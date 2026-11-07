/**
 * HomeArena 用户画像与设备统计（v0.33.0 R21-2 新增）
 * ============================================================================
 * 目标：回答"谁在用、用什么设备、从哪来、怎么用"这四个问题。
 *
 * 设计约束（都是真实环境逼出来的，不是偏好）：
 *
 *   ① **NAS 可能完全没有外网**。所以 IP 地理位置必须能降级：
 *      私网地址直接由本地规则判定（这一步永不失败）；
 *      公网地址才尝试在线库，超时/失败一律标记 unknown 并缓存负结果，
 *      绝不因为"查不到地理位置"而阻塞采集或拖慢请求。
 *
 *   ② **不能把主存储写大**。统计是附属功能，不能拖累战绩读写，
 *      所以用独立文件 analytics.json，且有硬上限 + 按 lastSeen 淘汰。
 *
 *   ③ **客户端上报的一切都不可信**。UA、屏幕、机型全部可以被伪造。
 *      因此：
 *        · 服务端自己算的字段（IP、header、时间）单独放一层，标记 trusted；
 *        · 客户端字段只做画像参考，参与"分布统计"但不参与任何权限判断；
 *        · 明显的矛盾（UA 说 iOS 但 platform 说 Win32）记为 risk。
 *
 *   ④ **隐私边界**。只采集设备与行为特征，不采集任何输入内容
 *      （不碰聊天、不碰密码、不碰牌局手牌）。did 是随机 ID，不含硬件序列号。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ── 存储位置：与 store.js 同一优先级，升级/重装不丢 ─────────────────── */
const DATA_DIR = (() => {
  const cand = process.env.TRIM_PKGVAR || process.env.HOMEARENA_DATA || path.join(__dirname, 'data');
  try { fs.mkdirSync(cand, { recursive: true }); } catch (e) { /* ignore */ }
  return cand;
})();
const DATA_FILE = path.join(DATA_DIR, 'analytics.json');

/* ── 容量上限：超出按 lastSeen 淘汰，防止长期运行把文件撑爆 ─────────── */
const MAX_DEVICES = Number(process.env.HOMEARENA_ANALYTICS_MAX || 5000);
const MAX_SESSIONS = 12000;
const SESSION_IDLE_MS = 30 * 60 * 1000;      // 30 分钟无动作算新会话
const KEEP_DAYS = Number(process.env.HOMEARENA_ANALYTICS_KEEP_DAYS || 180);

/* ══════════════════════════ 工具 ══════════════════════════ */

const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** 只保留字母数字与常见符号，防止上报字段里塞脚本 */
function clean(v, max = 120) {
  return str(v, max).replace(/[<>"'`\\\u0000-\u001f]/g, '').trim();
}

/* ══════════════════════════ IP 与地理 ══════════════════════════ */

/** 私有 / 保留地址判定（RFC1918 + RFC4193 + loopback + CGNAT） */
function isPrivateIp(ip) {
  if (!ip) return true;
  const s = String(ip).replace(/^::ffff:/i, '');
  if (s === '::1' || s === '127.0.0.1' || s === 'localhost') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;  // CGNAT
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true;                        // IPv6 ULA
  if (/^fe80:/i.test(s)) return true;                                    // IPv6 link-local
  return false;
}

/**
 * v0.34.0（R22-4）：把 IP 归到 /24（IPv4）或 /64（IPv6）网段。
 * 用途不是"定位到人"，而是让管理员一眼看出「这 30 台设备其实来自同一栋楼
 * 的同一个出口」，以及「有没有人换着 IP 反复注册」。
 */
function ipSubnet(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  if (!s) return '';
  if (s.indexOf(':') >= 0) {
    const parts = s.split(':').filter((x) => x.length > 0);
    return parts.slice(0, 4).join(':') + '::/64';
  }
  const seg = s.split('.');
  if (seg.length !== 4) return s;
  return seg[0] + '.' + seg[1] + '.' + seg[2] + '.0/24';
}

/**
 * 从请求里取真实客户端 IP。优先级取决于是否信任代理：
 *
 *   信任代理（NAS 前面挂了 Nginx / Cloudflare / 反代）：
 *     X-Forwarded-For 首段 → CF-Connecting-IP → X-Real-IP → socket 地址
 *   不信任代理（直连）：
 *     socket 地址（**绝不看任何头**）
 *
 * v0.33.0 修：旧实现不管信不信任，都把 socket.remoteAddress 先推进候选列表，
 * 而取第一个非本机地址就返回 —— 于是「信任代理」时永远拿到反代的地址
 * （192.168.x.x），XFF 里的真实公网 IP 反而被丢弃。结果就是所有经代理的
 * 访问都被归成同一个"局域网设备"，地域分布完全失真。
 */
function clientIpFrom(reqLike, trustProxy) {
  const h = (reqLike && reqLike.headers) || {};
  const sock = (reqLike && (reqLike.socket || reqLike.connection)) || {};
  const sockIp = String(sock.remoteAddress || '').replace(/^::ffff:/i, '');

  const pick = (list) => {
    for (const v0 of list) {
      const v = String(v0 || '').trim().replace(/^::ffff:/i, '');
      if (!v) continue;
      return v;
    }
    return '';
  };

  /* 兼容三种入参：true / false / 'auto'（v0.34.0 新增） */
  const mode = (trustProxy === undefined || trustProxy === null)
    ? 'auto'
    : (trustProxy === true ? 'always' : trustProxy === false ? 'never' : String(trustProxy));

  if (mode === 'never') return sockIp;

  const xff = h['x-forwarded-for'];
  const chain = xff ? String(xff).split(',').map((x) => x.trim()) : [];
  /* XFF 最左是真实客户端（右侧是逐跳追加的代理）。 */
  const fromHeaders = pick([
    chain[0],
    h['cf-connecting-ip'],
    h['true-client-ip'],
    h['x-real-ip'],
  ]);

  if (mode === 'always') return fromHeaders || sockIp;

  /* ══ auto 模式（v0.34.0 R22-4，本轮核心修复）══════════════════════════
   * 用户反馈「画像后台没有任何 IP 和城市位置信息」。
   *
   * 真实原因：`HOMEARENA_TRUST_PROXY` 默认没设 → 一律取 socket 地址。
   * 而用户把服务部署在 [内置线路已移除]，前面必然有一层
   * Nginx / 宝塔 / Caddy 反代 —— 于是所有连接的 socket 地址都是
   * 127.0.0.1，全部判成"局域网"，GeoIP 连查都不会查，城市一片空白。
   * 数据本身没坏，是**采信策略**把真实 IP 丢掉了。
   *
   * auto 的判定（既不丢数据，也不给伪造留口子）：
   *   ① 连接来自本机/内网 → 说明最后一跳就是同机的反代，认头；
   *   ② 连接来自公网 → 可能是直连，也可能是被打穿的上游，**不认头**
   *      （否则任何人带一个 X-Forwarded-For 就能把自己伪装成任意地区）；
   *   ③ 头里取到的必须是公网地址。内网地址出现在 XFF 首项只可能是
   *      伪造或内网代理链，对"用户在哪"没有信息量，回落 socket 更诚实。
   * ================================================================== */
  if (!isPrivateIp(sockIp)) return sockIp;
  if (!fromHeaders) return sockIp;
  if (isPrivateIp(fromHeaders)) return sockIp;
  return fromHeaders;
}

/** 代理头里直接带国家码时优先用（Cloudflare / Vercel 等），零成本 */
function countryFromHeaders(headers) {
  if (!headers) return '';
  const cc = headers['cf-ipcountry'] || headers['x-vercel-ip-country'] || headers['x-country-code'];
  return cc ? clean(String(cc), 8).toUpperCase() : '';
}

/* ── GeoIP：内存缓存 + 在线补齐 + 失败降级 ─────────────────────────── */

const geoCache = new Map();     // ip -> { at, data, neg }
const GEO_TTL_OK = 24 * 3600 * 1000;
/* 负缓存（查不到）从 1 小时收到 10 分钟。
 * 原来失败一次就锁定一小时 —— 反代刚部署好、网络刚恢复的那段时间里，
 * 用户会连续看到「归属地未解析」整整一小时，非常像功能没做完。 */
const GEO_TTL_NEG = 10 * 60 * 1000;
const GEO_TIMEOUT = 2500;
const GEO_MAX_INFLIGHT = 6;

/* ══ v0.34.0（R22-4b）：GeoIP 排队 + 源健康度 ═════════════════════════════
 *
 * 上一版（多源串行降级）解决了「单一源挂掉就没数据」，但还有两个洞：
 *
 *   ① **并发上限把请求直接丢掉**。原来是 `if (geoInFlight >= 3) return;` ——
 *      画像页一屏 11 台设备，只有前 3 台会被查，剩下 8 台原地返回、永远没有
 *      城市。用户看到的是「一部分有、一部分没有」，最容易被判成"没做完"。
 *      改成**排队**：超出的先入队，前一个回来再派下一个。
 *
 *   ② **源顺序写死**。国内网络下 ip-api（HTTP）整条超时是常态，每次都要
 *      白等 2.5s 才轮到下一个，画像页刚打开那几秒城市栏一片空白。
 *      加一层**本地健康度**：连续失败 3 次的源降权到队尾，成功一次立刻
 *      回到队首。纯内存状态，不增加任何请求，重启即重置。
 * ═══════════════════════════════════════════════════════════════════════ */
const geoQueue = [];
const geoQueued = new Set();
const GEO_QUEUE_MAX = 300;
const geoHealth = new Map();    // srcId -> { ok: ts, bad: n, last: ts }

function geoMark(srcId, okFlag) {
  const h = geoHealth.get(srcId) || { ok: 0, bad: 0, last: 0 };
  h.last = now();
  if (okFlag) { h.ok = h.last; h.bad = 0; } else { h.bad++; }
  geoHealth.set(srcId, h);
}

function geoOrdered() {
  const list = geoSourceList();
  const rank = (s) => {
    const h = geoHealth.get(s.id);
    if (!h) return 0;
    // 最近失败 3 次、且没有比失败更新的成功记录 → 降权
    return (h.bad >= 3 && h.ok < h.last) ? 1 : 0;
  };
  return list
    .map((s, i) => ({ s, i, k: rank(s) }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map((x) => x.s);
}


function geoOfIpSync(ip) {
  if (!ip) return null;
  if (isPrivateIp(ip)) {
    return {
      cc: 'LAN', ccName: '局域网', region: '', city: '', district: '',
      lat: null, lon: null, isp: '', org: '', asn: '', tz: '', src: 'local', priv: true,
    };
  }
  const c = geoCache.get(ip);
  if (c && !c.neg && now() - c.at < GEO_TTL_OK) {
    return Object.assign({ priv: false }, c.data);
  }
  return null;   // 未知：交给异步补齐
}

/**
 * 异步补齐公网 IP 的地理信息。
 * 绝不 await、绝不抛错、绝不阻塞 —— 查不到就算了，下次再看。
 * 之所以用 ip-api.com：无需 API Key、免费额度 45 次/分钟，家庭 NAS 场景足够。
 * 需要更高精度可换成自建 GeoLite2，只要把 lookupOnline 换掉即可。
 */
/**
 * v0.34.0（R22-4）：GeoIP 改成**多源串行降级**。
 *
 * 原来只有一个 ip-api.com（HTTP），而这个接口在国内网络下经常超时或
 * 被限流；一旦它不通，所有公网 IP 的城市就是空的，而 neg 缓存还会把
 * "没查到"记住一小时 —— 用户看到的就是"城市位置一栏永远是空的"。
 *
 * 现在：ip-api → ipapi.co → ipinfo.io，前一个失败自动试下一个。
 * 都失败才记负缓存（1 小时）。全程不 await、不阻塞请求路径。
 * 想接自建服务（ip2region / GeoLite2 包装）时设 HOMEARENA_GEO_API 即可，
 * 它会排在最前面。
 */
const GEO_SOURCES = [
  {
    id: 'ip-api',
    build: (ip) => 'http://ip-api.com/json/' + encodeURIComponent(ip)
      + '?lang=zh-CN&fields=status,country,countryCode,regionName,city,district,lat,lon,isp,org,as,timezone',
    parse: (j) => (j && j.status === 'success') ? {
      cc: clean(j.countryCode || '', 8), ccName: clean(j.country || '', 40),
      region: clean(j.regionName || '', 40), city: clean(j.city || '', 40),
      district: clean(j.district || '', 40),
      lat: typeof j.lat === 'number' ? Math.round(j.lat * 1000) / 1000 : null,
      lon: typeof j.lon === 'number' ? Math.round(j.lon * 1000) / 1000 : null,
      isp: clean(j.isp || '', 60), org: clean(j.org || '', 60),
      asn: clean(j.as || '', 60), tz: clean(j.timezone || '', 40), src: 'ip-api',
    } : null,
  },
  {
    id: 'ipapi.co',
    build: (ip) => 'https://ipapi.co/' + encodeURIComponent(ip) + '/json/',
    parse: (j) => (j && !j.error && j.country_code) ? {
      cc: clean(j.country_code || '', 8), ccName: clean(j.country_name || '', 40),
      region: clean(j.region || '', 40), city: clean(j.city || '', 40), district: '',
      lat: typeof j.latitude === 'number' ? Math.round(j.latitude * 1000) / 1000 : null,
      lon: typeof j.longitude === 'number' ? Math.round(j.longitude * 1000) / 1000 : null,
      isp: clean(j.org || '', 60), org: clean(j.org || '', 60),
      asn: clean(j.asn || '', 60), tz: clean(j.timezone || '', 40), src: 'ipapi.co',
    } : null,
  },
  {
    id: 'ipinfo.io',
    build: (ip) => 'https://ipinfo.io/' + encodeURIComponent(ip) + '/json',
    parse: (j) => (j && j.country && !j.bogon) ? (() => {
      const loc = String(j.loc || '').split(',');
      return {
        cc: clean(j.country || '', 8), ccName: '',
        region: clean(j.region || '', 40), city: clean(j.city || '', 40), district: '',
        lat: loc[0] ? Number(loc[0]) : null, lon: loc[1] ? Number(loc[1]) : null,
        isp: clean(j.org || '', 60), org: clean(j.org || '', 60),
        asn: '', tz: clean(j.timezone || '', 40), src: 'ipinfo.io',
      };
    })() : null,
  },
];

/** 可选的第一个源：管理员自建的 GeoIP 服务（返回同样的字段即可） */
function geoSourceList() {
  const custom = String(process.env.HOMEARENA_GEO_API || '').trim();
  if (!custom) return GEO_SOURCES;
  return [{
    id: 'custom',
    build: (ip) => custom.replace('{ip}', encodeURIComponent(ip)),
    parse: (j) => (j && (j.cc || j.country || j.countryCode)) ? {
      cc: clean(j.cc || j.countryCode || '', 8),
      ccName: clean(j.ccName || j.country || '', 40),
      region: clean(j.region || j.regionName || '', 40),
      city: clean(j.city || '', 40), district: clean(j.district || '', 40),
      lat: typeof j.lat === 'number' ? j.lat : null,
      lon: typeof j.lon === 'number' ? j.lon : null,
      isp: clean(j.isp || '', 60), org: clean(j.org || '', 60),
      asn: clean(j.asn || j.as || '', 60), tz: clean(j.tz || j.timezone || '', 40),
      src: 'custom',
    } : null,
  }].concat(GEO_SOURCES);
}

function fetchGeo(src, ip, cb) {
  let url = '';
  try { url = src.build(ip); } catch (e) { return cb(null); }
  if (!url) return cb(null);
  let lib = null;
  try { lib = url.indexOf('https:') === 0 ? require('https') : require('http'); }
  catch (e) { return cb(null); }
  let done = false;
  const fin = (d) => { if (!done) { done = true; cb(d); } };
  try {
    const req = lib.get(url, {
      timeout: GEO_TIMEOUT,
      headers: { 'user-agent': 'HomeArena/0.34 (+https://github.com/)', accept: 'application/json' },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 8192) buf += d; });
      res.on('end', () => {
        try { fin(src.parse(JSON.parse(buf))); } catch (e) { fin(null); }
      });
      res.on('error', () => fin(null));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } fin(null); });
    req.on('error', () => fin(null));
  } catch (e) { fin(null); }
}

let geoInFlight = 0;

/**
 * 把 IP 排进查询队列。
 * 返回 true 表示「已入队 / 正在查」，false 表示缓存命中或无需查（内网/关闭）。
 */
function enrichGeo(ip) {
  if (!ip || isPrivateIp(ip)) return false;
  if (process.env.HOMEARENA_GEO_OFF === '1') return false;
  const c = geoCache.get(ip);
  if (c) {
    const ttl = c.neg ? GEO_TTL_NEG : GEO_TTL_OK;
    if (now() - c.at < ttl) return false;
  }
  if (geoQueued.has(ip)) return true;
  if (geoQueue.length >= GEO_QUEUE_MAX) return false;
  geoQueued.add(ip);
  geoQueue.push(ip);
  pumpGeo();
  return true;
}

/**
 * 队列派发器：并发不超过 GEO_MAX_INFLIGHT，其余排队等 —— **不再直接丢弃**。
 * 画像页一屏十几台设备时，以前只有前 3 台会被查；现在全部会查完，只是慢一点。
 */
function pumpGeo() {
  while (geoInFlight < GEO_MAX_INFLIGHT && geoQueue.length) {
    const ip = geoQueue.shift();
    geoQueued.delete(ip);
    geoInFlight++;
    runGeoLookup(ip, () => { geoInFlight--; pumpGeo(); });
  }
}

function runGeoLookup(ip, done) {
  let settled = false;
  const settle = (data, neg) => {
    if (settled) return;
    settled = true;
    geoCache.set(ip, { at: now(), data: data || {}, neg: !!neg });
    if (geoCache.size > 4000) {
      const keys = [...geoCache.keys()].slice(0, 500);
      keys.forEach((k) => geoCache.delete(k));
    }
    done();
  };

  const list = geoOrdered();
  const tryOne = (i) => {
    if (settled) return;
    if (i >= list.length) return settle(null, true);
    const src = list[i];
    fetchGeo(src, ip, (data) => {
      if (settled) return;
      if (data) { geoMark(src.id, true); return settle(data, false); }
      geoMark(src.id, false);
      tryOne(i + 1);
    });
  };
  tryOne(0);
}

/* ══════════════════════════ User-Agent 解析 ══════════════════════════ */
/**
 * 服务端自己的 UA 解析（零依赖）。
 * 不用第三方包的原因：只有一个用途、规则集很小，而多一个依赖就多一份
 * 供应链风险 —— 这个项目是直接跑在用户 NAS 上的。
 */
function parseUA(ua) {
  const s = String(ua || '');
  const out = {
    os: { name: '未知', version: '' },
    browser: { name: '未知', version: '' },
    device: { type: 'desktop', brand: '', model: '' },
    engine: '',
    bot: false,
  };
  if (!s) return out;

  /* ── 机器人 ── */
  if (/(bot|crawler|spider|curl|wget|python-requests|headless|phantom|scrapy)/i.test(s)) {
    out.bot = true;
  }

  /* ── 操作系统 ── */
  let m;
  if ((m = s.match(/HarmonyOS(?:\s*([\d.]+))?/i))) {
    out.os = { name: 'HarmonyOS', version: m[1] || '' };
  } else if ((m = s.match(/OpenHarmony(?:\s*([\d.]+))?/i))) {
    out.os = { name: 'OpenHarmony', version: m[1] || '' };
  } else if (/Android/i.test(s)) {
    m = s.match(/Android\s*([\d.]+)?/i);
    out.os = { name: 'Android', version: (m && m[1]) || '' };
  } else if ((m = s.match(/(?:iPhone|iPad|iPod).*?OS\s*([\d_]+)/i))) {
    out.os = { name: 'iOS', version: m[1].replace(/_/g, '.') };
  } else if (/iPhone|iPad|iPod/i.test(s)) {
    out.os = { name: 'iOS', version: '' };
  } else if ((m = s.match(/Windows NT\s*([\d.]+)/i))) {
    const map = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    out.os = { name: 'Windows', version: map[m[1]] || m[1] };
  } else if ((m = s.match(/Mac OS X\s*([\d_.]+)/i))) {
    out.os = { name: 'macOS', version: m[1].replace(/_/g, '.') };
  } else if (/CrOS/i.test(s)) {
    out.os = { name: 'ChromeOS', version: '' };
  } else if (/Linux/i.test(s)) {
    out.os = { name: 'Linux', version: '' };
  }

  /* ── 浏览器 / 内核 ── */
  if ((m = s.match(/Edg(?:A|iOS)?\/([\d.]+)/))) out.browser = { name: 'Edge', version: m[1] };
  else if ((m = s.match(/OPR\/([\d.]+)/))) out.browser = { name: 'Opera', version: m[1] };
  else if ((m = s.match(/HuaweiBrowser\/([\d.]+)/i))) out.browser = { name: '华为浏览器', version: m[1] };
  else if ((m = s.match(/MicroMessenger\/([\d.]+)/i))) out.browser = { name: '微信内置', version: m[1] };
  else if ((m = s.match(/QQBrowser\/([\d.]+)/i))) out.browser = { name: 'QQ浏览器', version: m[1] };
  else if ((m = s.match(/UCBrowser\/([\d.]+)/i))) out.browser = { name: 'UC浏览器', version: m[1] };
  else if ((m = s.match(/Firefox\/([\d.]+)/))) out.browser = { name: 'Firefox', version: m[1] };
  else if ((m = s.match(/Chrome\/([\d.]+)/))) {
    // Android WebView 的 UA 带 "; wv" 标记
    out.browser = { name: /;\s*wv\)/.test(s) ? 'Android WebView' : 'Chrome', version: m[1] };
  } else if ((m = s.match(/Version\/([\d.]+).*Safari/))) out.browser = { name: 'Safari', version: m[1] };
  else if (/Safari/i.test(s)) out.browser = { name: 'Safari', version: '' };

  if (/AppleWebKit/i.test(s)) out.engine = 'WebKit';
  if (/Gecko\/|Firefox/i.test(s)) out.engine = 'Gecko';
  if (/Chrome\/|Chromium\//i.test(s)) out.engine = 'Blink';

  /* ── 设备形态 ── */
  if (/iPad|Tablet|PlayBook|Nexus 7|Nexus 9/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) {
    out.device.type = 'tablet';
  } else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s)) {
    out.device.type = 'mobile';
  } else if (/TV|SmartTV|AppleTV|GoogleTV|HbbTV/i.test(s)) {
    out.device.type = 'tv';
  } else {
    out.device.type = 'desktop';
  }
  if (out.bot) out.device.type = 'bot';

  /* ── 品牌 / 型号（客户端上报优先，这里只做兜底推断） ── */
  const brandMap = [
    [/HUAWEI|HONOR/i, '华为/荣耀'], [/Xiaomi|Redmi|Mi\s?\d/i, '小米/红米'],
    [/OPPO|realme/i, 'OPPO/realme'], [/vivo|iQOO/i, 'vivo/iQOO'],
    [/Samsung|SM-/i, '三星'], [/iPhone/i, 'Apple'], [/iPad/i, 'Apple'],
    [/OnePlus/i, '一加'], [/Meizu/i, '魅族'], [/Lenovo/i, '联想'],
  ];
  for (const [re, name] of brandMap) {
    if (re.test(s)) { out.device.brand = name; break; }
  }
  if (!out.device.brand && out.os.name === 'Windows') out.device.brand = 'PC';
  if (!out.device.brand && out.os.name === 'macOS') out.device.brand = 'Apple';

  return out;
}

/* ══════════════════════════ 画像标签 ══════════════════════════ */

const PLATFORM_TAG = (osName) => {
  const map = {
    Android: '安卓', HarmonyOS: '鸿蒙', OpenHarmony: '开源鸿蒙', iOS: 'iOS',
    Windows: 'Windows', macOS: 'macOS', Linux: 'Linux', ChromeOS: 'ChromeOS',
  };
  return map[osName] || '未知平台';
};

const TYPE_TAG = { mobile: '手机', tablet: '平板', desktop: '桌面', tv: '电视', bot: '机器人' };

/** 活跃度分档：以会话数 + 总时长为主，避免"开一次挂一天"被误判成核心用户 */
function activityTier(sessions, totalMs) {
  const hours = totalMs / 3600000;
  const score = sessions * 2 + hours;
  if (score >= 40) return { tag: '核心玩家', score: 5 };
  if (score >= 15) return { tag: '高频用户', score: 4 };
  if (score >= 5) return { tag: '常客', score: 3 };
  if (sessions >= 2) return { tag: '回头客', score: 2 };
  return { tag: '新访客', score: 1 };
}

/** 时段偏好：按会话开始时间的分布判定 */
function timeBucket(ts) {
  const h = new Date(ts).getHours();
  if (h >= 6 && h < 9) return '早鸟';
  if (h >= 9 && h < 18) return '日间';
  if (h >= 18 && h < 23) return '晚高峰';
  if (h >= 23 || h < 2) return '夜猫';
  return '深夜';
}

/** 性能档：核数 + 内存 + GPU 粗略分档（用于判断"该不该给低配降级"） */
function perfTier(cpu, mem, gpuRenderer) {
  const c = num(cpu), mm = num(mem);
  let pts = 0;
  if (c >= 8) pts += 2; else if (c >= 4) pts += 1;
  if (mm >= 8) pts += 2; else if (mm >= 4) pts += 1;
  if (/adreno\s?(7|8)|apple\s?gpu|mali-g[7-9]/i.test(gpuRenderer || '')) pts += 2;
  if (pts >= 4) return '高端机';
  if (pts >= 2) return '中端机';
  return '入门机';
}

/* ══════════════════════════ 数据层 ══════════════════════════ */

const devices = new Map();     // did -> device record
const sessions = [];           // 最近 MAX_SESSIONS 条会话
const live = new Map();        // did -> { at, sid, uid, ip, path } 实时在线
/**
 * v0.33.0 修：**每台设备的"当前会话"必须单独索引**。
 *
 * 旧实现判断"是否续用上一个会话"时看的是 `sessions[sessions.length-1]`
 * —— 全局数组的最后一条。多设备并发时这个假设立刻失效：
 *   A 访问 → 会话1(A)
 *   B 访问 → 会话2(B)        ← 现在尾部是 B
 *   A 再访问 → 尾部是 B，不是 A → **又建一条会话3(A)**
 * 于是同一台设备只要和别的设备交替访问，每次都会新增会话，
 * 「人均会话数」「平均会话时长」全部虚高。
 *
 * 现在按 did 存一个指针，各设备互不影响。会话过期后指针失效即可。
 */
const curSessions = new Map();  // did -> session

let dirty = false;
let saveTimer = null;

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 4000);
}

function saveNow() {
  if (!dirty) return;
  dirty = false;
  try {
    const payload = {
      v: 1,
      at: now(),
      devices: [...devices.values()],
      sessions: sessions.slice(-MAX_SESSIONS),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 先写临时文件再原子替换，避免断电留下半截 JSON
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[analytics] 保存失败', e && e.message);
  }
}

function loadNow() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const p = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const d of (p.devices || [])) {
      if (d && d.did) devices.set(d.did, d);
    }
    for (const s of (p.sessions || [])) {
      if (s && s.sid) sessions.push(s);
    }
    console.log(`[analytics] 已载入设备 ${devices.size} 台 / 会话 ${sessions.length} 条`);
  } catch (e) {
    console.error('[analytics] 载入失败（忽略损坏文件）', e && e.message);
  }
}

/** 淘汰：设备超过上限时按 lastSeen 从旧到新删 */
function evict() {
  if (devices.size <= MAX_DEVICES) return;
  const arr = [...devices.values()].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  const drop = devices.size - MAX_DEVICES;
  for (let i = 0; i < drop; i++) {
    devices.delete(arr[i].did);
  }
  if (drop > 0) console.log(`[analytics] 超出上限，淘汰 ${drop} 台最早设备`);
  // 会话也按时间裁剪
  if (sessions.length > MAX_SESSIONS) sessions.splice(0, sessions.length - MAX_SESSIONS);
}

/* ── 设备档案结构 ─────────────────────────────────────────────────── */

function blankDevice(did) {
  return {
    did,
    firstSeen: now(),
    lastSeen: now(),
    uid: null,
    uids: [],
    names: [],
    /* 计数 */
    sessions: 0,
    pageViews: 0,
    totalMs: 0,
    /* 服务端可信层 */
    trusted: { ip: '', ipv: 4, priv: true, geo: null, ua: '', ccHeader: '' },
    /* 客户端上报层 */
    client: null,
    /* 派生画像 */
    tags: [],
    score: 0,
    risk: [],
    /* 行为 */
    paths: {},
    referrer: '',
    landing: '',
    lastPath: '',
    /* 时段分布 */
    hours: new Array(24).fill(0),
  };
}

/** 拉一台设备；不存在则创建 */
function touchDevice(did) {
  let d = devices.get(did);
  if (!d) {
    d = blankDevice(did);
    devices.set(did, d);
  }
  d.lastSeen = now();
  return d;
}

/* ── 合并客户端上报的档案 ─────────────────────────────────────────── */
/**
 * 只接受白名单字段，且每个字段都做类型/长度约束。
 * 客户端说什么都可能是假的 —— 这里的目标是"结构正确、不会把前端搞崩"，
 * 不是"验证真假"。真假由 trusted 层和 risk 规则来判。
 */
function mergeClientProfile(d, c) {
  if (!c || typeof c !== 'object') return;
  const p = {};
  p.ua = clean(c.ua, 400);
  p.platform = clean(c.platform, 40);
  p.vendor = clean(c.vendor, 60);
  p.model = clean(c.model, 60);
  p.appVersion = clean(c.appVersion, 20);
  p.bundleVer = clean(c.bundleVer, 20);
  p.shell = clean(c.shell, 20);              // 'app' | 'pwa' | 'web'
  p.lang = clean(c.lang, 20);
  p.langs = Array.isArray(c.langs) ? c.langs.slice(0, 8).map((x) => clean(x, 20)) : [];
  p.tz = clean(c.tz, 60);
  p.tzOffset = num(c.tzOffset);
  p.cores = clamp(num(c.cores), 0, 256);
  p.mem = clamp(num(c.mem), 0, 1024);
  p.dpr = clamp(num(c.dpr), 0, 20);
  p.screenW = clamp(num(c.screenW), 0, 20000);
  p.screenH = clamp(num(c.screenH), 0, 20000);
  p.availW = clamp(num(c.availW), 0, 20000);
  p.availH = clamp(num(c.availH), 0, 20000);
  p.depth = clamp(num(c.depth), 0, 64);
  p.orient = clean(c.orient, 20);
  p.touchPoints = clamp(num(c.touchPoints), 0, 64);
  p.maxTouch = clamp(num(c.maxTouch), 0, 64);
  p.gpuVendor = clean(c.gpuVendor, 120);
  p.gpuRenderer = clean(c.gpuRenderer, 200);
  p.webglVer = clean(c.webglVer, 40);
  p.netType = clean(c.netType, 20);
  p.downlink = clamp(num(c.downlink), 0, 100000);
  p.rtt = clamp(num(c.rtt), 0, 60000);
  p.saveData = !!c.saveData;
  p.cookie = !!c.cookie;
  p.dnt = !!c.dnt;
  p.ls = !!c.ls;
  p.ss = !!c.ss;
  p.idb = !!c.idb;
  p.sw = !!c.sw;
  p.wasm = !!c.wasm;
  p.notif = clean(c.notif, 20);
  p.battery = c.battery && typeof c.battery === 'object'
    ? { level: clamp(num(c.battery.level), 0, 1), charging: !!c.battery.charging }
    : null;
  p.storageQuota = clamp(num(c.storageQuota), 0, 1e12);
  p.storageUsage = clamp(num(c.storageUsage), 0, 1e12);
  p.fonts = clamp(num(c.fonts), 0, 5000);
  p.colorGamut = clean(c.colorGamut, 20);
  p.reducedMotion = !!c.reducedMotion;
  p.darkMode = clean(c.darkMode, 20);
  p.uaFull = clean(c.uaFull, 400);
  p.locale = clean(c.locale, 30);
  p.calendar = clean(c.calendar, 30);

  /* UA 解析：客户端原始 UA 优先（WebView 里可能被壳改写），否则用 trusted 的 */
  const srcUA = p.ua || (d.trusted && d.trusted.ua) || '';
  p.parsed = parseUA(srcUA);

  d.client = p;
}

/**
 * 用客户端上报的物理尺寸**修正** UA 判出来的设备形态。
 *
 * 为什么必须有这一步：安卓手机的 UA 经常不带 `Mobile` 标记
 * （Chrome 在部分机型/WebView 上就是 `(Linux; Android 14; Mi 14)`），
 * 于是"Android 且不含 Mobile"的经典规则会把它判成平板。
 * 实测一条真实 UA 就会踩中：`(Linux; Android 14; Mi 14) ... Chrome/121`
 * → tablet。而它的实际屏幕是 1080×2400、5 点触控，是不折不扣的手机。
 *
 * 判据用 **dp 短边**（Android 官方的 sw 分档口径）：
 *   < 600dp  → 手机
 *   600~999  → 平板
 *   ≥ 1000dp → 桌面（大屏平板接键鼠 / 桌面模式）
 * 只对移动系 OS 生效 —— 桌面浏览器窗口可能只有 800px 宽，
 * 按 dp 判会把 Windows 笔记本误判成平板。
 */
function refineDeviceType(d) {
  const c = d.client;
  if (!c || !c.parsed || !c.parsed.device) return;
  if (c.parsed.device.type === 'bot') return;
  const osName = (c.parsed.os && c.parsed.os.name) || '';
  const mobileOs = osName === 'Android' || osName === 'iOS'
    || osName === 'HarmonyOS' || osName === 'OpenHarmony';
  if (!mobileOs) return;
  const w = num(c.screenW), h = num(c.screenH);
  const dpr = num(c.dpr) || 1;
  if (!w || !h) return;
  const shortDp = Math.min(w, h) / dpr;
  const touch = num(c.maxTouch) || num(c.touchPoints);
  if (shortDp >= 1000 && touch <= 2) c.parsed.device.type = 'desktop';
  else if (shortDp >= 600) c.parsed.device.type = 'tablet';
  else c.parsed.device.type = 'mobile';
}

/* ── 重算画像 ─────────────────────────────────────────────────────── */
function recompute(d) {
  const c = d.client || {};
  const tags = [];
  const risk = [];

  refineDeviceType(d);

  /* 平台 / 形态 */
  const osName = (c.parsed && c.parsed.os && c.parsed.os.name) || '';
  tags.push(PLATFORM_TAG(osName));
  const dtype = (c.parsed && c.parsed.device && c.parsed.device.type) || 'desktop';
  tags.push(TYPE_TAG[dtype] || '桌面');

  /* 端形态：App 壳 / PWA / 普通网页 */
  if (c.shell === 'app') tags.push('原生App');
  else if (c.shell === 'pwa') tags.push('PWA');
  else tags.push('网页');

  /* 活跃度 */
  const tier = activityTier(d.sessions || 0, d.totalMs || 0);
  tags.push(tier.tag);
  d.score = Math.round(clamp(
    (d.sessions || 0) * 6 + (d.totalMs || 0) / 600000 + (d.pageViews || 0) * 0.5,
    0, 100,
  ));

  /* 时段偏好：取最活跃的两段 */
  if (d.hours && d.hours.length === 24) {
    const buckets = { '早鸟': 0, '日间': 0, '晚高峰': 0, '夜猫': 0, '深夜': 0 };
    for (let h = 0; h < 24; h++) {
      const n = d.hours[h] || 0;
      if (h >= 6 && h < 9) buckets['早鸟'] += n;
      else if (h >= 9 && h < 18) buckets['日间'] += n;
      else if (h >= 18 && h < 23) buckets['晚高峰'] += n;
      else if (h >= 23 || h < 2) buckets['夜猫'] += n;
      else buckets['深夜'] += n;
    }
    const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    if (sorted[0] && sorted[0][1] > 0) tags.push(sorted[0][0] + '活跃');
  }

  /* 网络位置 */
  if (d.trusted && d.trusted.priv) tags.push('局域网');
  else if (geoOfDevice(d).city) tags.push(geoOfDevice(d).city);
  else tags.push('公网');

  /* 性能档 */
  tags.push(perfTier(c.cores, c.mem, c.gpuRenderer));

  /* ── 风险标记（只提示，不做任何自动处置）── */
  if (c.parsed && c.parsed.bot) risk.push('疑似机器人/无头浏览器');

  if (Array.isArray(d.uids) && d.uids.length >= 4) {
    risk.push('同设备多账号(' + d.uids.length + ')');
  }

  /* UA 与 platform 自相矛盾：iOS 的 UA 却报 Win32 */
  const pl = String(c.platform || '').toLowerCase();
  if (osName === 'iOS' && pl && !/iphone|ipad|macintel|arm/.test(pl)) {
    risk.push('UA与平台矛盾');
  }
  if (osName === 'Android' && pl && !/linux|android|arm/.test(pl)) {
    risk.push('UA与平台矛盾');
  }

  /* 屏幕尺寸为 0：多半是脚本伪造或环境异常 */
  if (c.screenW === 0 && c.screenH === 0 && d.sessions > 0) {
    risk.push('屏幕信息缺失');
  }

  d.tags = [...new Set(tags)];
  d.risk = [...new Set(risk)];
  return d;
}

/* ══════════════════════════ 对外 API ══════════════════════════ */

/**
 * 记录一次"设备连通"（socket 握手 / HTTP 首页访问都走这里）。
 * @param {object} o
 *   did        设备 ID（客户端生成；缺失时用 ip+ua 派生一个临时 ID）
 *   ip         客户端 IP
 *   ua         User-Agent
 *   headers    原始 header（用于 cf-ipcountry 等）
 *   uid        已登录账号（可空）
 *   name       账号名（可空）
 *   client     客户端上报的档案（可空）
 *   path       当前页面路径
 *   referrer   来源
 *   via        'socket' | 'http'
 */
function recordVisit(o) {
  const opt = o || {};
  let did = clean(opt.did, 64);
  if (!did) {
    /* 没有 did 的请求（爬虫、直接访问 /healthz 之类）——
     * 用 ip + ua 派生一个稳定的伪 ID，至少能统计"有多少不同来源"，
     * 但明确标记出来，不让它污染"已安装设备"的口径。 */
    did = 'anon_' + require('crypto').createHash('sha1')
      .update(String(opt.ip || '') + '|' + String(opt.ua || '')).digest('hex').slice(0, 16);
  }

  const d = touchDevice(did);
  const ip = clean(opt.ip, 64);
  const ipv = ip.indexOf(':') >= 0 ? 6 : 4;
  const priv = isPrivateIp(ip);

  /* trusted 层：服务端自己算的，最可信 */
  d.trusted = {
    ip,
    ipv,
    priv,
    ua: str(opt.ua, 400),
    ccHeader: countryFromHeaders(opt.headers),
    geo: geoOfIpSync(ip),
  };
  if (!d.trusted.geo) enrichGeo(ip);      // 异步补齐，下一次就有

  /* 账号绑定 */
  d.uids = Array.isArray(d.uids) ? d.uids : [];
  d.names = Array.isArray(d.names) ? d.names : [];
  if (opt.uid) {
    d.uid = opt.uid;
    if (d.uids.indexOf(opt.uid) < 0) d.uids.push(opt.uid);
    const nm = clean(opt.name, 30);
    if (nm && d.names.indexOf(nm) < 0) d.names.push(nm);
  }

  /* 客户端档案 */
  if (opt.client) mergeClientProfile(d, opt.client);

  /* UA 兜底解析（v0.33.0 交付截图时发现并补上）
   * ────────────────────────────────────────────────────────────────
   * socket 通道的 client 档案里已经带了 `parsed`（mergeClientProfile 算的）；
   * 但 **HTTP 通道根本不传 client** —— 那些「只打开了网页、采集脚本还没跑完
   * 就关掉」的访客，`d.client` 是空的，于是平台/浏览器/形态在分布图里全变成
   * 「未知」，白白浪费掉这批样本（实测能占到总设备数的 45%）。
   * 这里用 trusted.ua 兜一次解析：trusted 是服务端自己看到的原始 UA，
   * 可信度足够支撑平台/浏览器判定。 */
  if ((!d.client || !d.client.parsed) && d.trusted && d.trusted.ua) {
    d.client = d.client || {};
    d.client.parsed = parseUA(d.trusted.ua);
    refineDeviceType(d.client);   // 无 screenW 时不动，安全
  }

  /* 路径与来源 */
  const p = clean(opt.path, 160);
  if (p) {
    if (!d.landing) d.landing = p;
    d.lastPath = p;
    d.paths = d.paths || {};
    d.paths[p] = (d.paths[p] || 0) + 1;
    if (Object.keys(d.paths).length > 60) {
      // 只留 top 60，防无限膨胀
      const arr = Object.entries(d.paths).sort((a, b) => b[1] - a[1]).slice(0, 60);
      d.paths = Object.fromEntries(arr);
    }
  }
  if (!d.referrer && opt.referrer) d.referrer = clean(opt.referrer, 300);

  /* 会话：30 分钟静默算断开（按 did 索引，见 curSessions 的注释） */
  let cur = curSessions.get(did) || null;
  if (cur && now() - (cur.at || 0) >= SESSION_IDLE_MS) cur = null;
  if (!cur) {
    cur = {
      sid: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      did, uid: opt.uid || null, ip,
      start: now(), end: now(), at: now(),
      pages: 1, ms: 0,
      ref: clean(opt.referrer, 200),
      land: p || '/',
      ua: str(opt.ua, 200),
      via: opt.via || 'socket',
    };
    sessions.push(cur);
    curSessions.set(did, cur);
    d.sessions = (d.sessions || 0) + 1;
    /* 同步裁剪，避免长跑之后数组无限长（MAX_SESSIONS 是硬上限） */
    if (sessions.length > MAX_SESSIONS) {
      const dropped = sessions.splice(0, sessions.length - MAX_SESSIONS);
      for (const s of dropped) {
        if (curSessions.get(s.did) === s) curSessions.delete(s.did);
      }
    }
  } else {
    cur.at = now();
    cur.end = now();
    cur.uid = opt.uid || cur.uid;
    cur.pages = (cur.pages || 0) + (opt.countPageView ? 1 : 0);
    cur.ms = cur.end - cur.start;
  }

  d.pageViews = (d.pageViews || 0) + (opt.countPageView ? 1 : 0);

  /* 时段分布 */
  if (opt.countPageView || !d._h) {
    const h = new Date().getHours();
    d.hours = Array.isArray(d.hours) && d.hours.length === 24 ? d.hours : new Array(24).fill(0);
    d.hours[h] = (d.hours[h] || 0) + 1;
    d._h = 1;
  }

  recompute(d);
  live.set(did, { at: now(), sid: cur.sid, uid: opt.uid || null, ip, path: p, name: clean(opt.name, 30) });
  evict();
  scheduleSave();
  return d;
}

/** 心跳：只更新在线状态与时长，不新增会话 */
function heartbeat(did, extra) {
  const d = devices.get(clean(did, 64));
  if (!d) return null;
  d.lastSeen = now();
  const ex = extra || {};
  if (ex.uid) d.uid = ex.uid;
  const hbSess = curSessions.get(d.did);
  if (hbSess && now() - (hbSess.at || 0) < SESSION_IDLE_MS) {
    hbSess.at = now();
    hbSess.end = now();
    hbSess.ms = hbSess.end - hbSess.start;
  }
  /* totalMs 用「各会话时长之和」更准，但每台都重算太贵；
   * 这里按增量累加：每次心跳补上距上次的间隔（上限 5 分钟，防休眠误计）。 */
  if (d._lastBeatAt) {
    const delta = clamp(now() - d._lastBeatAt, 0, 5 * 60 * 1000);
    d.totalMs = (d.totalMs || 0) + delta;
    const h = new Date().getHours();
    d.hours = Array.isArray(d.hours) && d.hours.length === 24 ? d.hours : new Array(24).fill(0);
    // 时长也计入时段（弱权重）
    d.hours[h] = d.hours[h] || 0;
  }
  d._lastBeatAt = now();
  live.set(d.did, Object.assign(live.get(d.did) || {}, { at: now(), uid: d.uid, ip: d.trusted ? d.trusted.ip : '' }));
  scheduleSave();
  return d;
}

/** 页面切换：只加计数，不建会话 */
function pageView(did, p, referrer) {
  const d = devices.get(clean(did, 64));
  if (!d) return null;
  const path = clean(p, 160);
  if (!path) return null;
  d.pageViews = (d.pageViews || 0) + 1;
  d.lastPath = path;
  d.paths = d.paths || {};
  d.paths[path] = (d.paths[path] || 0) + 1;
  const pvSess = curSessions.get(d.did);
  if (pvSess && now() - (pvSess.at || 0) < SESSION_IDLE_MS) {
    pvSess.pages = (pvSess.pages || 0) + 1;
    pvSess.at = now();
    pvSess.end = now();
    pvSess.ms = pvSess.end - pvSess.start;
  }
  d.lastSeen = now();
  live.set(d.did, Object.assign(live.get(d.did) || {}, { at: now(), path }));
  scheduleSave();
  return d;
}

/** 在线列表（30 秒内有心跳即算在线） */
function onlineList(windowMs = 90 * 1000) {
  const t = now() - windowMs;
  const out = [];
  for (const [did, v] of live) {
    if (v.at >= t) {
      const d = devices.get(did);
      out.push({
        did,
        name: (v.name || (d && d.names && d.names[d.names.length - 1]) || ''),
        uid: v.uid || '',
        ip: v.ip || (d && d.trusted ? d.trusted.ip : ''),
        path: v.path || '',
        at: v.at,
        idle: now() - v.at,
        platform: d && d.client && d.client.parsed ? d.client.parsed.os.name : '',
        model: d && d.client ? (d.client.model || '') : '',
        type: d && d.client && d.client.parsed ? d.client.parsed.device.type : '',
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/* ── 聚合 ─────────────────────────────────────────────────────────── */

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

function bump(map, key, n) {
  if (!key) key = '未知';
  map[key] = (map[key] || 0) + (n || 1);
}

function topN(map, n = 12, total) {
  const arr = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
  const sum = total || arr.reduce((s, x) => s + x[1], 0);
  return arr.map(([k, v]) => ({ k, v, pct: pct(v, sum) }));
}

/** 总览：管理后台首屏要的所有数字 */
function overview() {
  const all = [...devices.values()];
  const total = all.length;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const todayStart = t0.getTime();
  const weekStart = todayStart - 6 * 86400000;

  const dToday = all.filter((d) => (d.firstSeen || 0) >= todayStart).length;
  const dWeek = all.filter((d) => (d.firstSeen || 0) >= weekStart).length;
  const activeToday = all.filter((d) => (d.lastSeen || 0) >= todayStart).length;
  const active7d = all.filter((d) => (d.lastSeen || 0) >= weekStart).length;

  const byPlatform = {}, byType = {}, byBrand = {}, byModel = {}, byOs = {}, byBrowser = {};
  const byRegion = {}, byCity = {}, byIsp = {}, byAsn = {}, byCc = {};
  const byScreen = {}, byTier = {}, byTag = {}, byHour = new Array(24).fill(0);
  /* v0.34.0（R22-4）：新增 IP 网段分布与覆盖城市数 */
  const bySubnet = {};
  const citySet = new Set();
  let totalSessions = 0, totalMs = 0, totalPv = 0, lan = 0, pub = 0, withGeo = 0;

  for (const d of all) {
    const c = d.client || {};
    const parsed = c.parsed || {};
    bump(byPlatform, (parsed.os && parsed.os.name) || '未知');
    bump(byOs, (parsed.os && (parsed.os.name + (parsed.os.version ? ' ' + parsed.os.version : ''))) || '未知');
    bump(byBrowser, (parsed.browser && parsed.browser.name) || '未知');
    bump(byType, TYPE_TAG[(parsed.device && parsed.device.type) || 'desktop'] || '桌面');
    bump(byBrand, (parsed.device && parsed.device.brand) || c.vendor || '未知');
    bump(byModel, c.model || '未知');
    bump(byScreen, c.screenW ? (c.screenW + '×' + c.screenH) : '未知');
    const pt = perfTier(c.cores, c.mem, c.gpuRenderer);
    bump(byTier, pt);
    for (const tg of (d.tags || [])) bump(byTag, tg);
    if (d.hours && d.hours.length === 24) {
      for (let h = 0; h < 24; h++) byHour[h] += d.hours[h] || 0;
    }

    const g = geoOfDevice(d);
    if (d.trusted && d.trusted.priv) lan++;
    else pub++;
    /* 网段分布：任何有 IP 的设备都计入（内网也计，用 192.168.x.0/24 这种形式） */
    if (d.trusted && d.trusted.ip) {
      const sn = ipSubnet(d.trusted.ip);
      if (sn) bump(bySubnet, sn);
    }
    if (g && g.cc && g.cc !== 'LAN') {
      withGeo++;
      bump(byCc, g.ccName || g.cc);
      /* v0.34.0（R22-4f）：region 为空时不记「未知」。
       * 非中国地区有城市时我们会把 region 清空（避免「美国 · California · 山景城」太长），
       * 若这里兜底成「未知」，「省份/州」卡上就会出现一坨"未知 2" —— 看着像解析失败。 */
      if (g.region) bump(byRegion, g.region);
      if (g.city) { bump(byCity, g.city); citySet.add(g.city); }
      else bump(byCity, '未知');
      bump(byIsp, g.isp || '未知');
      bump(byAsn, g.asn || '未知');
    } else if (d.trusted && d.trusted.priv) {
      bump(byCc, '局域网');
      bump(byRegion, '局域网');
      bump(byCity, '局域网');
    }

    totalSessions += d.sessions || 0;
    totalMs += d.totalMs || 0;
    totalPv += d.pageViews || 0;
  }

  /* 近 14 天新增设备趋势 */
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const s = todayStart - i * 86400000;
    const e = s + 86400000;
    trend.push({
      date: new Date(s).toISOString().slice(5, 10),
      newDevices: all.filter((d) => (d.firstSeen || 0) >= s && (d.firstSeen || 0) < e).length,
      active: all.filter((d) => (d.lastSeen || 0) >= s && (d.lastSeen || 0) < e).length,
    });
  }

  return {
    at: now(),
    totals: {
      devices: total,
      newToday: dToday,
      newWeek: dWeek,
      activeToday,
      active7d,
      online: onlineList(90 * 1000).length,
      sessions: totalSessions,
      pageViews: totalPv,
      totalHours: Math.round(totalMs / 3600000 * 10) / 10,
      avgSessionMin: totalSessions > 0 ? Math.round(totalMs / totalSessions / 60000 * 10) / 10 : 0,
      pertDevice: total > 0 ? Math.round(totalSessions / total * 10) / 10 : 0,
      /* v0.34.0（R22-4）：覆盖城市数 / 覆盖网段数，用于一眼判断"是不是都来自同一个出口" */
      cities: citySet.size,
      subnets: Object.keys(bySubnet).length,
    },
    network: { lan, public: pub, withGeo, pctLan: pct(lan, lan + pub) },
    dist: {
      platform: topN(byPlatform, 12, total),
      os: topN(byOs, 12, total),
      browser: topN(byBrowser, 10, total),
      type: topN(byType, 6, total),
      brand: topN(byBrand, 12, total),
      model: topN(byModel, 15, total),
      screen: topN(byScreen, 10, total),
      tier: topN(byTier, 5, total),
      tag: topN(byTag, 20, total),
      country: topN(byCc, 12, total),
      region: topN(byRegion, 15, total),
      city: topN(byCity, 20, total),
      isp: topN(byIsp, 12, total),
      asn: topN(byAsn, 12, total),
      subnet: topN(bySubnet, 12, total),
    },
    hours: byHour,
    trend,
    topDevices: all
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10)
      .map((d) => ({
        did: d.did,
        name: (d.names && d.names[d.names.length - 1]) || '',
        score: d.score || 0,
        sessions: d.sessions || 0,
        platform: d.client && d.client.parsed ? d.client.parsed.os.name : '',
        model: d.client ? (d.client.model || '') : '',
        tags: (d.tags || []).slice(0, 4),
      })),
  };
}

/* ── 设备列表（分页 / 搜索 / 排序） ────────────────────────────────── */

/**
 * 读取一台设备的地理信息。
 *
 * v0.34.0（R22-4d）关键修复：
 *   原来这里直接读 `d.trusted.geo` —— 那是**入店那一刻**的快照。而 GeoIP 是
 *   异步补齐的，补齐结果只写进 geoCache，**从不回写快照**。后果：
 *   一台设备第一次访问时 IP 还没解析出来，它的 `trusted.geo` 就永远是 null，
 *   除非它再访问一次。于是画像后台出现「一部分设备有城市、一部分永远空白」，
 *   看起来像功能只做了一半 —— 用户反馈的「没有任何 IP 城市信息」正是这么来的。
 *
 *   现在改成**优先读实时缓存**，读到就回写快照（下次省一次查表）。
 */

/* ══ 地名中文化（v0.34.0 R22-4e）══════════════════════════════════════════
 * 三个源的中文支持不一致：ip-api 支持 lang=zh-CN（「中国 · 山东 · 济南市」），
 * ipapi.co / ipinfo.io 只有英文（「China · Jiangsu · Nanjing」）。
 * 结果同一张表里中英混排，看着像两套系统拼的。这里做一层本地映射：
 *   · 国家名：全量常用 40 个，同时收 ISO2 码与英文全名两种键；
 *   · 中国省市：34 个省级 + 40 个常见城市；
 *   · 其它国家的城市保留原文（中国人看 California 比「加利福尼亚州」更熟）。
 * 没有映射到的原样返回，绝不丢信息。
 * ═══════════════════════════════════════════════════════════════════════ */
const GEO_CC_ZH = {
  CN: '中国', CHINA: '中国', HK: '中国香港', 'HONG KONG': '中国香港',
  MO: '中国澳门', MACAO: '中国澳门', MACAU: '中国澳门', TW: '中国台湾', TAIWAN: '中国台湾',
  US: '美国', USA: '美国', 'UNITED STATES': '美国',
  JP: '日本', JAPAN: '日本', KR: '韩国', 'SOUTH KOREA': '韩国', KP: '朝鲜',
  SG: '新加坡', SINGAPORE: '新加坡', MY: '马来西亚', MALAYSIA: '马来西亚',
  TH: '泰国', THAILAND: '泰国', VN: '越南', VIETNAM: '越南', PH: '菲律宾', PHILIPPINES: '菲律宾',
  ID: '印度尼西亚', INDONESIA: '印度尼西亚', IN: '印度', INDIA: '印度',
  AU: '澳大利亚', AUSTRALIA: '澳大利亚', NZ: '新西兰', 'NEW ZEALAND': '新西兰',
  GB: '英国', UK: '英国', 'UNITED KINGDOM': '英国',
  DE: '德国', GERMANY: '德国', FR: '法国', FRANCE: '法国',
  NL: '荷兰', NETHERLANDS: '荷兰', BE: '比利时', BELGIUM: '比利时',
  CH: '瑞士', SWITZERLAND: '瑞士', AT: '奥地利', AUSTRIA: '奥地利',
  SE: '瑞典', SWEDEN: '瑞典', NO: '挪威', NORWAY: '挪威', DK: '丹麦', DENMARK: '丹麦',
  FI: '芬兰', FINLAND: '芬兰', PL: '波兰', POLAND: '波兰',
  IT: '意大利', ITALY: '意大利', ES: '西班牙', SPAIN: '西班牙', PT: '葡萄牙', PORTUGAL: '葡萄牙',
  IE: '爱尔兰', IRELAND: '爱尔兰', GR: '希腊', GREECE: '希腊',
  RU: '俄罗斯', RUSSIA: '俄罗斯', UA: '乌克兰', UKRAINE: '乌克兰',
  TR: '土耳其', TURKEY: '土耳其', IL: '以色列', ISRAEL: '以色列',
  AE: '阿联酋', 'UNITED ARAB EMIRATES': '阿联酋', SA: '沙特阿拉伯', 'SAUDI ARABIA': '沙特阿拉伯',
  EG: '埃及', EGYPT: '埃及', ZA: '南非', 'SOUTH AFRICA': '南非',
  BR: '巴西', BRAZIL: '巴西', AR: '阿根廷', ARGENTINA: '阿根廷',
  CL: '智利', CHILE: '智利', MX: '墨西哥', MEXICO: '墨西哥', CA: '加拿大', CANADA: '加拿大',
};

const GEO_PLACE_ZH = {
  /* 省级 */
  Beijing: '北京', Shanghai: '上海', Tianjin: '天津', Chongqing: '重庆',
  Hebei: '河北', Shanxi: '山西', Liaoning: '辽宁', Jilin: '吉林', Heilongjiang: '黑龙江',
  Jiangsu: '江苏', Zhejiang: '浙江', Anhui: '安徽', Fujian: '福建', Jiangxi: '江西',
  Shandong: '山东', Henan: '河南', Hubei: '湖北', Hunan: '湖南', Guangdong: '广东',
  Hainan: '海南', Sichuan: '四川', Guizhou: '贵州', Yunnan: '云南', Shaanxi: '陕西',
  Gansu: '甘肃', Qinghai: '青海', Guangxi: '广西', 'Inner Mongolia': '内蒙古',
  Ningxia: '宁夏', Xinjiang: '新疆', Tibet: '西藏', Xizang: '西藏',
  /* 常见城市 */
  Nanjing: '南京', Suzhou: '苏州', Wuxi: '无锡', Changzhou: '常州', Nantong: '南通',
  Xuzhou: '徐州', Yangzhou: '扬州',
  Hangzhou: '杭州', Ningbo: '宁波', Wenzhou: '温州', Jiaxing: '嘉兴', Jinhua: '金华',
  Guangzhou: '广州', Shenzhen: '深圳', Dongguan: '东莞', Foshan: '佛山', Zhuhai: '珠海',
  Huizhou: '惠州', Zhongshan: '中山',
  Jinan: '济南', Qingdao: '青岛', Yantai: '烟台', Weifang: '潍坊', Linyi: '临沂',
  Wuhan: '武汉', Yichang: '宜昌', Xiangyang: '襄阳',
  Changsha: '长沙', Zhuzhou: '株洲',
  Chengdu: '成都', Mianyang: '绵阳',
  Xian: "西安", "Xi'an": '西安',
  Zhengzhou: '郑州', Luoyang: '洛阳',
  Shenyang: '沈阳', Dalian: '大连',
  Harbin: '哈尔滨', Changchun: '长春',
  Shijiazhuang: '石家庄', Baoding: '保定', Tangshan: '唐山',
  Hefei: '合肥', Fuzhou: '福州', Xiamen: '厦门', Quanzhou: '泉州',
  Nanchang: '南昌', Nanning: '南宁', Guilin: '桂林', Kunming: '昆明', Guiyang: '贵阳',
  Lanzhou: '兰州', Xining: '西宁', Yinchuan: '银川', Urumqi: '乌鲁木齐', Hohhot: '呼和浩特',
  Haikou: '海口', Sanya: '三亚', Lhasa: '拉萨', Taiyuan: '太原',
  /* 港澳台 */
  Kowloon: '九龙', 'Hong Kong': '香港', Macau: '澳门', Macao: '澳门', Taipei: '台北',
  Kaohsiung: '高雄', Taichung: '台中',
  /* 海外常见城市（只收中文媒体常用的那些，其余保留原文更准确） */
  'Mountain View': '山景城', 'San Francisco': '旧金山', 'Los Angeles': '洛杉矶',
  'New York': '纽约', Seattle: '西雅图', Chicago: '芝加哥', Dallas: '达拉斯',
  Ashburn: '阿什本', 'Santa Clara': '圣克拉拉', Singapore: '新加坡',
  Tokyo: '东京', Osaka: '大阪', Seoul: '首尔', 'Hong Kong ': '香港',
  London: '伦敦', Paris: '巴黎', Frankfurt: '法兰克福', Amsterdam: '阿姆斯特丹',
};

function geoZhCountry(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return GEO_CC_ZH[s.toUpperCase()] || GEO_CC_ZH[s] || s;
}
function geoZhPlace(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return GEO_PLACE_ZH[s] || s;
}

function geoOfDevice(d) {
  const t = (d && d.trusted) || {};
  let raw = t.geo || {};
  if (t.ip && !t.priv) {
    const live = geoOfIpSync(t.ip);
    if (live) { t.geo = live; raw = live; }
  }
  if (!raw || (!raw.cc && !raw.ccName && !raw.city && !raw.region)) return raw || {};
  const out = Object.assign({}, raw, {
    ccName: geoZhCountry(raw.ccName || raw.cc || ''),
    region: geoZhPlace(raw.region),
    city: geoZhPlace(raw.city),
  });
  /* 非中国地区：有城市时不再重复显示省级。
   * 「美国 · California · Mountain View」在表格里太长，而这个场景真正有用的
   * 信息是「哪个国家 + 哪个城市」；省级只在没有城市时兜底显示，信息不丢。
   * 中国内地/港澳台保留完整三级 —— 「中国 · 江苏 · 南京」正是想要的粒度。 */
  if (out.city && out.ccName && out.ccName.indexOf('中国') !== 0) {
    out.region = '';
  }
  return out;
}

function listDevices(q) {
  const o = q || {};
  const kw = clean(o.kw, 60).toLowerCase();
  const sort = ['lastSeen', 'firstSeen', 'sessions', 'totalMs', 'score', 'pageViews'].indexOf(o.sort) >= 0 ? o.sort : 'lastSeen';
  const page = Math.max(1, num(o.page) || 1);
  const size = clamp(num(o.size) || 20, 1, 200);

  let arr = [...devices.values()];

  if (kw) {
    arr = arr.filter((d) => {
      const hay = [
        d.did,
        (d.names || []).join(' '),
        (d.uids || []).join(' '),
        d.client ? d.client.model : '',
        d.client ? d.client.vendor : '',
        d.client && d.client.parsed ? d.client.parsed.os.name : '',
        d.trusted ? d.trusted.ip : '',
        (function () { const gg = geoOfDevice(d); return gg.city || gg.region || ''; })(),
        (d.tags || []).join(' '),
        (d.risk || []).join(' '),
      ].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }
  if (o.platform) arr = arr.filter((d) => d.client && d.client.parsed && d.client.parsed.os.name === o.platform);
  if (o.type) arr = arr.filter((d) => d.client && d.client.parsed && d.client.parsed.device.type === o.type);
  if (o.riskOnly) arr = arr.filter((d) => (d.risk || []).length > 0);

  arr.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
  const total = arr.length;
  const start = (page - 1) * size;
  const rows = arr.slice(start, start + size).map((d) => {
    const c = d.client || {};
    const g = geoOfDevice(d);
    return {
      did: d.did,
      name: (d.names && d.names[d.names.length - 1]) || '',
      uids: (d.uids || []).length,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      sessions: d.sessions || 0,
      pageViews: d.pageViews || 0,
      totalMin: Math.round((d.totalMs || 0) / 60000),
      score: d.score || 0,
      platform: c.parsed ? c.parsed.os.name : '',
      osVer: c.parsed ? c.parsed.os.version : '',
      browser: c.parsed ? c.parsed.browser.name : '',
      type: c.parsed ? c.parsed.device.type : '',
      brand: c.parsed ? c.parsed.device.brand : '',
      model: c.model || '',
      screen: c.screenW ? (c.screenW + '×' + c.screenH) : '',
      dpr: c.dpr || 0,
      cores: c.cores || 0,
      mem: c.mem || 0,
      ip: (d.trusted && d.trusted.ip) || '',
      priv: !!(d.trusted && d.trusted.priv),
      cc: g.ccName || g.cc || '',
      region: g.region || '',
      city: g.city || '',
      isp: g.isp || '',
      tags: (d.tags || []).slice(0, 6),
      risk: d.risk || [],
    };
  });
  return { total, page, size, pages: Math.ceil(total / size), rows, online: onlineList(90 * 1000).length };
}

/** 单台设备全量详情（含会话时间线） */
function deviceDetail(did) {
  const d = devices.get(clean(did, 64));
  if (!d) return null;
  const sess = sessions.filter((s) => s.did === d.did).slice(-40).reverse();
  return {
    device: d,
    sessions: sess,
    online: onlineList(90 * 1000).some((x) => x.did === d.did),
  };
}

/** 删除一台设备（管理员主动清理） */
function removeDevice(did) {
  const id = clean(did, 64);
  const had = devices.delete(id);
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].did === id) sessions.splice(i, 1);
  }
  curSessions.delete(id);
  live.delete(id);
  if (had) scheduleSave();
  return had;
}

/** 清空全部（危险操作，仅管理员，且要二次确认） */
function clearAll() {
  const n = devices.size;
  devices.clear();
  sessions.length = 0;
  curSessions.clear();
  live.clear();
  dirty = true;
  saveNow();
  return n;
}

/** 导出（CSV 或 JSON） */
function exportRows() {
  const arr = [...devices.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return arr.map((d) => {
    const c = d.client || {};
    const g = geoOfDevice(d);
    return {
      '设备ID': d.did,
      '账号': (d.names || []).join('/'),
      '绑定账号数': (d.uids || []).length,
      '首次访问': new Date(d.firstSeen || 0).toISOString(),
      '最近访问': new Date(d.lastSeen || 0).toISOString(),
      '会话数': d.sessions || 0,
      '页面浏览': d.pageViews || 0,
      '累计时长(分)': Math.round((d.totalMs || 0) / 60000),
      '活跃分': d.score || 0,
      '平台': c.parsed ? c.parsed.os.name : '',
      '系统版本': c.parsed ? c.parsed.os.version : '',
      '浏览器': c.parsed ? c.parsed.browser.name : '',
      '浏览器版本': c.parsed ? c.parsed.browser.version : '',
      '设备形态': TYPE_TAG[(c.parsed && c.parsed.device.type) || 'desktop'] || '',
      '品牌': (c.parsed && c.parsed.device.brand) || '',
      '型号': c.model || '',
      '屏幕': c.screenW ? (c.screenW + '×' + c.screenH) : '',
      '像素比': c.dpr || '',
      'CPU核数': c.cores || '',
      '内存(GB)': c.mem || '',
      'GPU': c.gpuRenderer || '',
      '触摸点': c.touchPoints || 0,
      '语言': c.lang || '',
      '时区': c.tz || '',
      '网络类型': c.netType || '',
      'IP': (d.trusted && d.trusted.ip) || '',
      '内网': (d.trusted && d.trusted.priv) ? '是' : '否',
      '国家/地区': g.ccName || g.cc || '',
      '省/州': g.region || '',
      '城市': g.city || '',
      '运营商': g.isp || '',
      'ASN': g.asn || '',
      '经纬度': (g.lat != null && g.lon != null) ? (g.lat + ',' + g.lon) : '',
      '来源': d.referrer || '',
      '落地页': d.landing || '',
      '最近页面': d.lastPath || '',
      '画像标签': (d.tags || []).join('|'),
      '风险标记': (d.risk || []).join('|'),
      'UA': (d.trusted && d.trusted.ua) || '',
    };
  });
}

/* ── 启动 ── */
loadNow();
/* 定期保存 + 淘汰，防止异常退出丢太多 */
const tick = setInterval(() => { if (dirty) saveNow(); evict(); }, 30000);
if (tick.unref) tick.unref();

/* 进程退出时落盘（best effort） */
process.on('exit', () => { try { saveNow(); } catch (e) { } });

module.exports = {
  recordVisit,
  heartbeat,
  pageView,
  onlineList,
  overview,
  listDevices,
  deviceDetail,
  removeDevice,
  clearAll,
  exportRows,
  parseUA,
  isPrivateIp,
  clientIpFromHeaders: clientIpFrom,
  countryFromHeaders,
  /* 给测试用 */
  _internal: { devices, sessions, live, curSessions, geoCache, perfTier, activityTier, timeBucket },
};
