const express = require('express');
const http = require('http');
const fsMod = require('fs');
const extreg = require('./extreg');
const unzip = require('./unzip');
const extanalyze = require('./extanalyze');   // v0.20.0（R8-5）导入审核解析 + 联机桥注入
const path = require('path');
const { Server } = require('socket.io');
const gomoku = require('./gomoku');
const chess = require('./games/chess');
const doudizhu = require('./games/doudizhu');
const guandan = require('./games/guandan');
const mahjong = require('./games/mahjong');
const xiangqi = require('./games/xiangqi');
const reversi = require('./games/reversi');
const connect4 = require('./games/connect4');
const go = require('./games/go');
const texas = require('./games/texas');
const shengji = require('./games/shengji');
const dz = require('./ai/douzero');
const hint = require('./games/lib/hint');
const cardsLib = require('./games/lib/cards');
const { getEngine } = require('./ai/ucci');
const store = require('./store');
const account = require('./account');
const settings = require('./settings');
const rating = require('./rating');
const replayLib = require('./replay');
// v0.33.0（R21-2）：用户画像与设备统计。独立文件、独立上限，不拖累战绩读写。
const analytics = require('./analytics');

const VERSION = '0.48.0';

/* ══════════════════════════════════════════════════════════════════════════
 * v0.29.0（R17-1）管理员兜底绑定 —— 修复「老账号无管理权 / 管理页不可见」
 * --------------------------------------------------------------------------
 * 根因：管理权只靠 `settings.ensureAdmin()` 在「首个注册」时固化 adminUid。
 *   对 v0.18 之前就注册过账号的部署来说，那些账号注册时还没有 ensureAdmin，
 *   于是 users.json 里有人、settings.adminUid 却一直为空 —— 服务端 socketIsAdmin
 *   永远 false，客户端 `isMeAdmin()` 也永远 false，「管理中心」入口永不出现，
 *   老厅主再怎么登录都拿不到管理权。
 * 修法：进程启动时做一次**幂等兜底**——
 *   · 已指定 adminUid（手动转让 / 环境变量 HOMEARENA_ADMIN_UID / 首注固化）→ 不动；
 *   · 否则若存在注册账号 → 把「最早注册」那位提为管理员（家庭厅的装机者即厅主）；
 *   · 没有任何注册账号 → 保持空，仍由首个注册者接管（旧行为不变）。
 * 这样任意历史数据都能自动长出管理权，且不影响新装实例的「首注即厅主」语义。 */
(function bootstrapAdmin() {
  if (settings.adminUidOf()) return;
  const users = [...account.users.values()];
  if (!users.length) return;
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  settings.ensureAdmin(users[0].uid);
  console.log('[settings] 管理员兜底绑定（老部署兼容）：' + users[0].uid);
})();
// AI 座位的虚拟形象（与真人同一套渲染，视觉上统一）
const AI_NAMES = { fun: '小乐', strong: '小强', super: '小超' };
/* v0.10.20：名字池。硬需求是「同桌不重名」—— 之前一桌两个 strong 都叫小强，
   座位条和播报里根本没法区分。池长度 ≥ 最大座位数（麻将 4 人）。 */
const AI_NAME_POOL = {
  fun: ['小乐', '阿呆', '豆豆', '皮皮'],
  strong: ['小强', '阿飞', '老周', '大勇'],
  super: ['小超', '棋圣', '老K', '铁蛋'],
};
/* v0.19.0（R7-1）：AI 陪练头像改用 12 个精绘角色中的 4 个，与 avatar.js v4 一致 */
const ROBOT_AVATARS = ['moke', 'xianhe', 'pixiu', 'jiuwei'];

/* ══════════════════════════════════════════════════════════════════════════
 * v0.12.0（R2-4）回合计时与超时托管
 * --------------------------------------------------------------------------
 * 为什么必须做（这不是「锦上添花」而是「一桌人能不能打完」的问题）：
 *   旧实现只有「空位 / AI 座位」会自动出牌。一旦某位真人掉线、去倒水、
 *   或者干脆关掉 App，只要他的座位还挂着 pid，这一桌就**永久卡死**，
 *   其他真人既不能跳过也不能踢人，只能自己退出重开。家庭局里这是最气人的场景。
 *
 * 设计：
 *   · 每个「轮到真人」的回合计时，超时后由 AI 以其座位身份代打一手（托管）。
 *     托管**不改变座位归属**，本人回来下一手即可接管 —— 和空位托管同一套语义。
 *   · 计时是**软性**的：只在服务端内存里存 deadline，随 room:state 下发，
 *     客户端画个进度条。服务端到点才动作，客户端算错时间也不影响牌局。
 *   · 超时不止一手：托管一次后重新计时，若本人仍不动，会继续托管，
 *     于是「掉线的人」最终会被 AI 替他把这局打完，其他人能正常收局。
 *   · 连续托管达到 MAX_TRUSTEES 次后，标记 seat.trusted = true，
 *     UI 上该座位显示「托管中」，别人一眼知道这人不在。
 *
 * 各游戏时长不一：棋类一步要想，牌类一手是选牌。棋盘类给 45s，
 * 牌类给 30s（出牌基本是秒出，30s 已经非常宽裕）。可在设置里关掉（0 = 不限时）。
 * ══════════════════════════════════════════════════════════════════════════ */
const TURN_MS = {
  chess: 45000, xiangqi: 45000, go: 45000, gomoku: 45000,
  reversi: 30000, connect4: 30000,
  doudizhu: 30000, guandan: 30000, shengji: 30000, mahjong: 30000, texas: 45000,
};
const turnTimerOf = new Map();     // roomCode -> NodeJS.Timeout
const MAX_TRUSTEES = Number(process.env.HOMEARENA_MAX_TRUSTEE || 200);

/* ══════════════════════════════════════════════════════════════════════════
 * v0.17.0（R4-5）内置趣味快捷短语白名单
 * --------------------------------------------------------------------------
 * 客户端只传 id，服务端反查出标准文案落库 —— 单一事实源，任何客户端版本
 * 都不可能把同一句短语渲染成两种文字。id 与 web/ui.js 的 QUICK_POCKET 一一对应。
 * ══════════════════════════════════════════════════════════════════════════ */
const CHAT_PHRASES = {
  /* 催一催 */
  huaxie: '快点吧，等到花都谢了',
  yayaowei: '这把稳了，别送',
  xiaqu: '打住打住，收手吧',
  pingjiao: '咱们平着来，别急',
  gangshang: '刚上手，热热身',
  shouqi: '手气也是实力，别怪我',
  /* 夸一夸 */
  haoni: '好牛！这手打得漂亮',
  rangpaile: '让让你，这把不算',
  woduini: '我信你，跟你走',
  wanhuile: '完了，这把要交学费',
  bielian: '别连我底裤都扒了',
  xiaoxinyi: '小心别把底裤输没了',
  /* 自嘲一下 */
  paibuchu: '牌不好，忍一手',
  wanhuile2: '完了，这把要交学费',
  gangshang2: '刚上手，热热身',
  bielian2: '别连我底裤都扒了',
  shouqi2: '手气也是实力，别怪我',
  pingjiao2: '咱们平着来，别急',
  /* 收个尾 */
  biezou: '别走啊，再战一局',
  huaxie2: '快点吧，等到花都谢了',
  haoni2: '好牛！这手打得漂亮',
  woduini2: '我信你，跟你走',
  yayaowei2: '这把稳了，别送',
  xiaqu2: '打住打住，收手吧',
};

/* ══════════════════════════════════════════════════════════════════════════
 * v0.17.0（R4-6）牌桌「托管」—— 主动挂机与接回
 * --------------------------------------------------------------------------
 * v0.12.0 只做了**被动**托管（超时由 AI 代打）。真实牌局里更常见的是：
 *   · 「我去倒杯水 / 接个电话」—— 想立刻托管，而不是每手干等 30 秒；
 *   · 「我这局已经没戏了」—— 让 AI 打完，但人还在桌边看牌。
 * 现在补上主动通道：
 *   socket 'room:trustee' { on: true|false }
 *     on=true  → seat.manual = true（主动托管），下一次轮到立刻由 AI 出牌；
 *                之后的每一手都不再计时等待，秒出（不拖累全桌）。
 *     on=false → 收回托管，重新计时，本人立刻可以操作。
 * 语义与被动托管完全共用 seat.trusted/auto 那套字段，区别只在 seat.manual：
 *   · manual 是「我决定托管」，回来必须**我点接回**才解除；
 *   · 被动托管只要本人出一手牌就自动解除（见 game:move）。
 * 托管是**座位属性**，不是 socket 属性 —— 断线重连、换设备回座都保持。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 主动托管时若正好轮到我：不等待，直接让 AI 走一手 */
function playIfMyTurn(r, seatIdx) {
  if (!r || r.finished) return;
  if (!r.state || r.state.winner != null || r.state.draw) return;
  if (r.state.current !== seatIdx) return;
  clearTurnTimer(r.code);
  r.turnDeadline = null;
  trustMove(r, r.seats[seatIdx]);
}

function turnLimitFor(game) {
  /* 设置项 turnLimit 单位是秒，0 表示不限时（家庭休闲场景有人就是喜欢慢慢想）。
   * 各游戏默认时长（TURN_MS，毫秒）只在设置未定义时兜底。 */
  let sec = null;
  try { const sn = settings.snapshot(); if (sn && sn.turnLimit != null) sec = Number(sn.turnLimit); } catch (e) { }
  if (sec === 0) return 0;
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  return TURN_MS[game] || 30000;
}

/** 清掉某房间的回合计时（换局、结束、退出时都要调） */
function clearTurnTimer(code) {
  const t = turnTimerOf.get(code);
  if (t) { clearTimeout(t); turnTimerOf.delete(code); }
}

/**
 * 重排回合计时。每次状态推进（afterMove / 开局 / 有人入座）后调用。
 * 只有「当前轮到的是一个在座真人」时才计时；AI 与空位由 maybeAITurn 直接推进。
 */
function armTurnTimer(r) {
  clearTurnTimer(r.code);
  if (!r || r.finished) { r && (r.turnDeadline = null); return; }
  if (r.state && (r.state.winner != null || r.state.draw)) { r.turnDeadline = null; return; }
  if (isExt(GAMES[r.game])) { r.turnDeadline = null; return; }
  /* v0.28.0（R16-6）：房间玩法（标准 45s / 快棋 20s）优先于全局默认；
   * 管理员设「不限时」(0) 仍拥有最高优先级。 */
  let limit = turnLimitFor(r.game);
  const roomMs = r.rules && +r.rules.turnMs;
  if (limit !== 0 && roomMs) limit = roomMs;
  if (!limit) { r.turnDeadline = null; return; }
  const seatIdx = r.state.current;
  const seat = r.seats[seatIdx];
  // AI / 空位走 maybeAITurn，不需要真人计时
  if (!seat || seat.type !== 'human' || !seat.pid) { r.turnDeadline = null; return; }

  /* v0.17.0：主动托管中的座位 —— 不给人计时窗口，直接交给 AI。
   * （被动托管只是每次超时才代打；主动托管是「人明确说我不在」，没必要等。） */
  if (seat.manual) {
    r.turnDeadline = null;
    const r0 = r, i0 = seatIdx;
    /* v0.30.0（R18-3）：主动托管的出手节奏从固定 900ms 调整为 1.5s±0.5s。
     * 900ms 是「机器快进」观感：三家托管同时开，一局十几秒打完，真人
     * 根本来不及看牌面变化；给一点随机停顿更像「代打的人在思考」，
     * 也让其他玩家跟得上节奏。 */
    const wait = 1500 + Math.floor(Math.random() * 500);
    const t0 = setTimeout(() => {
      const r1 = store.rooms.get(r0.code);
      if (!r1 || r1.round !== r0.round || !r1.state) return;
      if (r1.state.current !== i0) return;
      const s1 = r1.seats[i0];
      if (!s1 || !s1.manual) return;
      trustMove(r1, s1);
    }, wait);
    if (t0.unref) t0.unref();
    turnTimerOf.set(r.code, t0);
    return;
  }

  /* v0.13.0（S4）托管节奏：已经连续被代打 ≥2 手的座位，后续回合缩短等待。
   *
   * 旧行为：掉线的人每手都要等满 30 秒，一局 20 手就是 10 分钟 ——
   * 剩下两个人对着「XX 行动中…」干等，这是家庭局最容易散场的地方。
   * v0.30.0（R18-3）：分级调整 —— 原「2 手就压到 5 秒」对思考型玩家太激进
   * （连续两次想久了就被判挂机）。现在：
   *   · 连续 2 手 → 15 秒（仍然明显快于 30 秒，但留足接回窗口）
   *   · 连续 4 手 → 6 秒（确认人不在，才真正加速收尾）
   * 任何一次真实操作都会把 trusted 清零（见 game:move），分级自动回落。 */
  const tc = seat.trusted || 0;
  const effLimit = tc >= 4 ? Math.min(limit, 6000)
    : tc >= 2 ? Math.min(limit, 15000)
    : limit;

  r.turnDeadline = Date.now() + effLimit;
  r.turnLimit = effLimit;
  const code = r.code, round = r.round, token = (r.turnToken = (r.turnToken || 0) + 1);
  const t = setTimeout(() => {
    turnTimerOf.delete(code);
    const r2 = store.rooms.get(code);
    // 期间换局/换人/已结束 → 这次计时作废
    if (!r2 || r2.round !== round || r2.turnToken !== token) return;
    if (!r2.state || r2.state.winner != null || r2.state.draw) return;
    const s2 = r2.seats[r2.state.current];
    if (!s2 || s2.type !== 'human' || !s2.pid) return;
    trustMove(r2, s2);
  }, effLimit + 250);        // 多给 250ms，容忍网络往返与客户端最后一刻的出牌
  if (t.unref) t.unref();
  turnTimerOf.set(code, t);
}

/**
 * 托管：用 AI 替某个真人座位走一手。
 * 与 maybeAITurn 的区别是「座位是真人」，所以要额外做三件事：
 *   ① 打标记 trusted，让同房其他人看到「这人托管了」
 *   ② 用 'fun' 档（托管不该比人打得好，否则等于作弊）
 *   ③ 走完继续重排计时 —— 人没回来就继续替他打
 */
async function trustMove(r, seat) {
  if (isExt(GAMES[r.game])) return;
  const seatIdx = r.seats.indexOf(seat);
  if (seatIdx < 0) return;
  seat.trusted = (seat.trusted || 0) + 1;
  seat.trustedAt = Date.now();
  /* v0.13.0（S4）两级语义，别把「偶尔超时一次」和「人不在」混为一谈：
   *   trusted —— 本局累计被代打几手（有就说明超时过）
   *   auto    —— 连续 ≥2 手都靠代打，判定为「托管中」，座位上挂牌
   * 玩家任何一次真实操作都会把两者一起清零（见 game:move）。
   * v0.17.0：seat.manual = 主动托管（玩家自己点的），此时第一手就挂牌，
   * 且不需要等满两手。 */
  seat.auto = seat.manual || seat.trusted >= 2;
  const round = r.round;
  try {
    const mv = await GAMES[r.game].ai(r.state, seatIdx + 1, 'fun');
    const r2 = store.rooms.get(r.code);
    if (!r2 || r2.round !== round) return;                 // 已换局
    if (!r2.state || r2.state.winner != null || r2.state.draw) return;
    if (r2.state.current !== seatIdx) return;      // 期间有人抢先出了
    if (!mv) {
      /* v0.13.0（S4）兜底：AI 给不出动作时不能就这么挂着。
       * 能过就过（不卡下家），过不了（自己领出）就重排计时等下一轮 ——
       * 旧实现只重排计时，遇到「AI 空返回 + 必须领出」会无限循环等下去。 */
      const pr = GAMES[r2.game].apply(r2.state, { type: 'pass' }, seatIdx + 1);
      if (pr && pr.ok) { afterMove(r2, pr.next); return; }
      armTurnTimer(r2); return;
    }
    const res = GAMES[r.game].apply(r2.state, mv, seatIdx + 1);
    if (res && res.ok) {
      try {
        const act = actionFromMove(r2.game, mv, seatIdx, r2.state);
        if (act) io.to(r2.code).emit('table:action', { ...act, trusted: true });
      } catch (e) { }
      /* 通知房内：某人超时被托管（前端据此提示，避免「我的牌怎么自己动了」） */
      io.to(r2.code).emit('room:trustee', {
        code: r2.code,
        seat: seatIdx, name: seat.name || '玩家',
        count: seat.trusted, limit: r2.turnLimit || 0,
        kind: 'timeout', manual: !!seat.manual,
      });
      afterMove(r2, res.next);
    } else {
      armTurnTimer(r2);
    }
  } catch (e) {
    console.error('[trustee]', e && e.message);
    armTurnTimer(r);
  }
}


const app = express();
// 跨源放行：安卓 / 鸿蒙客户端的内置外壳跑在 appassets.local（虚拟 https 源），
// 需要从本机直接连家里的 NAS。家庭局域网内网服务，放开 CORS 是安全的。
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept');
  res.header('Access-Control-Max-Age', '86400');
  // 反代/WebView 跨源探测时（v0.9.1），需要暴露给 JS 的简单头
  res.header('Access-Control-Expose-Headers', 'Content-Length,Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// healthz 放在静态资源之前，且显式声明不缓存，避免外壳探活拿到过期结果
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, app: 'homearena', v: VERSION, rooms: store.rooms.size, online: io.engine.clientsCount });
});

/* ══════════════════════════════════════════════════════════════════════════
 * v0.33.0（R21-2）：浏览器直连模式的访问采集
 * --------------------------------------------------------------------------
 * 原生外壳（安卓/鸿蒙/iOS）加载的是 file:// 本地页面，根本不经过这里，
 * 它们的设备信息全部走 socket 的 `device:hello`。所以这条中间件只服务
 * 「用浏览器直接打开 NAS 页面」这一种场景。
 *
 * 两个刻意的取舍：
 *   ① **只采 HTML 页面**，不采静态资源。一个页面要拉 20+ 个 js/css/图片，
 *      全采的话设备表会被刷成"每人几十条"，既没信息量又拖慢落盘。
 *   ② **同一 ip+ua 每小时只记一次**，且用 `anon_` 前缀与真设备区分开。
 *      浏览器可能刷新十几次，但那是同一个"来源"，不是十台设备。
 *      管理后台里 anon_ 会被单独标成「未建立会话」，不计入装机量。
 * ══════════════════════════════════════════════════════════════════════════ */
/* v0.34.0（R22-4）：代理信任从「默认关」改成「默认 auto」。
 * 默认关意味着：只要前面挂了 Nginx/宝塔（几乎所有外网部署都会挂），
 * 抓到的就是 127.0.0.1，画像里的 IP 与城市全空 —— 这正是用户反馈的现象。
 * auto 的判定逻辑见 analytics.clientIpFrom。 */
const TRUST_PROXY = (() => {
  const v = String(process.env.HOMEARENA_TRUST_PROXY || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'always') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'never') return false;
  return 'auto';
})();
console.log('[analytics] 代理信任模式=' + TRUST_PROXY
  + '（auto=连接来自内网时采信 X-Forwarded-For）');
const _httpSeen = new Map();          // ip|ua -> 上次记录时间
app.use((req, res, next) => {
  try {
    const isPage = (req.method === 'GET' || req.method === 'HEAD')
      && req.path !== '/healthz'
      && (/^\/$/.test(req.path) || /\.html?$/i.test(req.path));
    if (isPage) {
      const ip = analytics.clientIpFromHeaders(req, TRUST_PROXY);
      const ua = String(req.headers['user-agent'] || '');
      const key = ip + '|' + ua;
      const last = _httpSeen.get(key) || 0;
      if (Date.now() - last > 3600 * 1000) {
        _httpSeen.set(key, Date.now());
        if (_httpSeen.size > 5000) _httpSeen.clear();
        const ref = String(req.headers['referer'] || '');
        analytics.recordVisit({
          did: '',                       // 无客户端 ID → 由 ip+ua 派生 anon_
          ip, ua,
          headers: req.headers,
          path: req.path,
          referrer: ref,
          via: 'http',
          countPageView: true,
        });
      }
    }
  } catch (e) {
    // 统计失败绝不能影响正常请求
  }
  next();
});

/* v0.33.0（R21-2）：静态目录可用 HOMEARENA_WEB_DIR 覆盖。
 * 两个真实用途：
 *   ① 自动化测试要跑 **build/web 混淆产物**，而默认目录是 app/web（源码）；
 *      覆盖后不必为了测试去覆盖源码目录。
 *   ② 部署时可以把前端放到数据盘 / 只读挂载点，与程序目录解耦。 */
const WEB_DIR = process.env.HOMEARENA_WEB_DIR
  ? path.resolve(process.env.HOMEARENA_WEB_DIR)
  : path.join(__dirname, '..', 'web');
app.use(express.static(WEB_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // HTML 与 js/css 一律协商缓存（no-cache）：带 ?v= 就永远是新的，
    // 不带版本号时也不会拿到过期副本——避免「改了样式但手机看到的还是旧界面」。
    if (/\.(html|js|css|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');   // 图片等长缓存
    }
  }
}));

/* v0.10.9：用户导入的外部游戏已迁出安装目录（见 extreg.js 的 BASE_DIR），
 * 这里单独挂一条静态路由。放在 web 静态之后 → 内置 /ext/snake 仍由 web/ext 命中，
 * 只有当 web 下不存在该文件时才落到可写目录，两者互不干扰。 */
app.use('/ext', express.static(extreg.EXT_ROOT, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

/* ================= v0.10.7 外部游戏自助导入 API ==========================
 * 设计：客户端负责解压（手机上用 JSZip 解析 zip），逐个文件 POST 到写入接口，
 * 服务端只做「校验 + 落盘 + 注册」。这样无需引入 multer / multipart 依赖，
 * 也能在安卓/鸿蒙 WebView 里稳定工作。
 *
 * 接口：
 *   GET  /api/ext/list                      已安装列表
 *   POST /api/ext/prepare  {id,label,...}   校验 id 并创建/清空目标目录
 *   POST /api/ext/file     {id,path,dataB64} 写入单个文件（含路径安全校验）
 *   POST /api/ext/finish   {id,meta}        校验包完整性 → 写入注册表 → 热更新
 *   POST /api/ext/remove   {id}             卸载
 *   GET  /api/ext/limits                    限制常量（供前端提示）
 * ======================================================================== */
/* v0.10.12：**分片上传**。
 * 旧实现每个文件一次 POST，整个文件 base64 后塞进 JSON ——
 * 40mb 的 body 上限按 base64 算，只能装约 30MB 原始文件（base64 膨胀 4/3），
 * 这就是「超过 30M 就导不进去」的直接原因。
 * 现在前端按 4MB 切片，每片单独 POST + append 落盘，
 * body 上限收到 8mb（4MB * 4/3 ≈ 5.6MB，留余量），单请求永不逼近上限。 */
app.use('/api/ext', express.json({ limit: '8mb' }));

app.get('/api/ext/limits', (req, res) => {
  res.json({ ok: true, maxBytes: extreg.LIMITS.maxBytes, maxFiles: extreg.LIMITS.maxFiles, reserved: extreg.RESERVED });
});

app.get('/api/ext/list', (req, res) => {
  const games = extreg.list().map(g => Object.assign({}, g, { builtin: false }));
  // 内置外部游戏（如 snake）也列出来，标记 builtin 供 UI 区分「不可卸载」
  for (const [k, v] of Object.entries(GAMES)) {
    if (v && v.kind === 'external' && v.builtin) {
      games.unshift({ id: k, label: v.label, seats: v.seats, engine: v.engine, entry: v.entry, builtin: true, installedAt: 0, size: 0 });
    }
  }
  res.json({ ok: true, games });
});

/* v0.10.14：导入状态锁从 Set 改为 Map<id, 启动时间戳>。
 * 原来用户中途关掉导入面板 / 断网 / 刷新页面后，prepare 加进 Set 的 id
 * 永远不会被 finish/release 清掉 —— 之后同一 id 再导入永远报
 * 「该游戏正在导入中，请稍候」，只能重启服务。这是导入成功率杀手之一。
 * 现在带 30 分钟 TTL：超时的锁视为遗留死锁，prepare 直接接管（覆盖旧目录）。 */
const EXT_TMP_TTL = 30 * 60 * 1000;
const EXT_TMP_DIRS = new Map();
function extLockLive(id) {
  const t = EXT_TMP_DIRS.get(id);
  return t != null && (Date.now() - t) < EXT_TMP_TTL;
}
function extLockTake(id) { EXT_TMP_DIRS.set(id, Date.now()); }
function extLockFree(id) { EXT_TMP_DIRS.delete(id); }

/* ═══ v0.18.0（R6-3）游戏导入权收归管理员 ══════════════════════════════
 * 用户明确要求：「游戏导入权仅管理员一人有此权限」。
 * 导入/卸载/停用是写操作且直接落盘执行外部代码，必须鉴权；limits/list
 * 是只读元信息，继续公开（大厅渲染要用）。
 * 凭证走请求头 x-ha-token（与登录态同一把 HMAC token），前端
 * ext-import.js 统一带上。
 *
 * v0.32.0（R20 审计 P0-6）修复「未绑定管理员时全网放行」：
 *   原来 `if (!settings.adminUidOf()) return true;` —— 未绑定时**匿名请求**
 *   也能 POST /api/ext/prepare → /api/ext/file 往 web/ext/ 落盘任意
 *   HTML/JS，再由 express.static 直接对外提供，等价于在服务端托管
 *   任意可执行页面。而 CORS 是 '*'，来自任意网页的请求同样可达。
 *   「未绑定」的真实状态是「**一个注册用户都还没有**」
 *   （首个注册者注册时 ensureAdmin 会立刻绑定，bootstrapAdmin 也会
 *     在启动时把最早注册者提为管理员），此时根本不存在合法管理员，
 *   不该有任何写权限。
 *   现在：未绑定时，写操作要求携带**已注册用户的有效会话 token**
 *   （guest 不行 —— guests 不落盘，account.resolve 也解析不出），
 *   或匹配 HOMEARENA_ADMIN_TOKEN 环境变量。 */
function reqIsAdmin(req) {
  const t = String(req.headers['x-ha-token'] || req.query.token || '');
  /* 环境变量管理员口令（部署期应急通道）*/
  const envToken = process.env.HOMEARENA_ADMIN_TOKEN;
  if (envToken && t && String(t) === String(envToken)) return true;
  const u = t ? account.resolve(t) : null;
  if (!u) return false;                        // 无有效会话：拒绝
  if (settings.adminUidOf()) return settings.isAdminUid(u.uid);
  /* 未绑定管理员：仅「已注册用户」可写（游客身份不在 users 表里，
   * resolve() 也解析不出游客 token）*/
  return account.users.has(u.uid);
}
function extAdminGuard(req, res) {
  if (reqIsAdmin(req)) return true;
  res.status(403).json({ ok: false, msg: '游戏导入/管理仅限管理员操作', code: 'NOT_ADMIN' });
  return false;
}

app.post('/api/ext/prepare', (req, res) => {
  if (!extAdminGuard(req, res)) return;
  const b = req.body || {};
  const v = extreg.validateId(b.id);
  if (!v.ok) return res.json({ ok: false, msg: v.msg });
  if (extLockLive(b.id)) return res.json({ ok: false, msg: '该游戏正在导入中，请稍候' });
  try {
    const dir = require('path').join(extreg.EXT_ROOT, b.id);
    // 覆盖安装：先整目录清空，避免旧版本残留文件（如改了 bundle 名）导致白屏
    fsMod.rmSync(dir, { recursive: true, force: true });
    fsMod.mkdirSync(dir, { recursive: true });
    extLockTake(b.id);
    res.json({ ok: true, dir: '/ext/' + b.id + '/' });
  } catch (e) {
    extLockFree(b.id);
    res.json({ ok: false, msg: '创建目录失败：' + (e && e.message) });
  }
});

/* v0.10.12：分片写入。
 * body: { id, path, seq, dataB64 } —— seq=0 表示覆盖建新文件，>0 表示追加。
 * 每个分片独立落盘，前端顺序发（不并发），所以不需要偏移量参数。
 * 这样把一个 100MB 的包拆成 25 个 4MB 请求，避开 express body 上限。
 *
 * v0.10.14（参考 tus 协议的「服务端权威偏移量」设计）：
 * body 新增可选 expect = 客户端认为的服务端当前字节数。
 * 重试场景下如果上一次请求其实已经落盘（响应丢了），盲目 append 会把文件写坏
 * （同一片写两遍 → zip/asset 校验失败 → 游戏白屏，且用户完全无从排查）。
 * 服务端现在校验 statSync().size === expect，不符则拒绝并回传真实 size，
 * 客户端据此跳到正确偏移续传 —— 这是「断点续传」的最小正确实现。 */
app.post('/api/ext/chunk', (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  if (!extLockLive(b.id)) return res.json({ ok: false, msg: '导入会话已失效，请重新开始（若反复出现请刷新页面）' });
  const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.indexOf('..') >= 0) return res.json({ ok: false, msg: '非法路径' });
  try {
    const base = require('path').join(extreg.EXT_ROOT, b.id);
    const full = require('path').join(base, rel);
    if (require('path').relative(base, full).indexOf('..') === 0) return res.json({ ok: false, msg: '越界路径' });
    fsMod.mkdirSync(require('path').dirname(full), { recursive: true });
    const buf = Buffer.from(String(b.dataB64 || ''), 'base64');
    const seq = Number(b.seq || 0);
    const cur = fsMod.existsSync(full) ? fsMod.statSync(full).size : 0;
    if (seq === 0) {
      fsMod.writeFileSync(full, buf);
    } else {
      if (cur === 0) return res.json({ ok: false, msg: '分片顺序错误：' + rel });
      /* expect 校验：只挡「错位」，不挡正常重试（重试时 expect === cur 会直接通过） */
      if (b.expect != null && Number(b.expect) !== cur) {
        return res.json({ ok: false, mismatch: true, size: cur, msg: '分片偏移不符（服务端 ' + cur + '，客户端 ' + Number(b.expect) + '）：' + rel });
      }
      fsMod.appendFileSync(full, buf);
    }
    res.json({ ok: true, bytes: buf.length, size: fsMod.statSync(full).size });
  } catch (e) {
    res.json({ ok: false, msg: '分片写入失败：' + (e && e.message) });
  }
});

app.post('/api/ext/file', (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  if (!extLockLive(b.id)) return res.json({ ok: false, msg: '导入会话已失效，请重新开始（若反复出现请刷新页面）' });
  const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.indexOf('..') >= 0) return res.json({ ok: false, msg: '非法路径' });
  try {
    const base = require('path').join(extreg.EXT_ROOT, b.id);
    const full = require('path').join(base, rel);
    // 二次确认：解析后仍必须在目标目录内
    if (require('path').relative(base, full).indexOf('..') === 0) return res.json({ ok: false, msg: '越界路径' });
    fsMod.mkdirSync(require('path').dirname(full), { recursive: true });
    const b64 = String(b.dataB64 || '');
    const buf = Buffer.from(b64, 'base64');
    // v0.10.8：空内容不落盘。之前字段名不匹配时 b64 为空串，
    // Buffer.from('') 长度为 0，仍然返回 ok:true 并写下一个 0 字节文件，
    // 最终整包「安装成功」但游戏打不开。凡是声明的文件大小 >0 却解出 0 字节，一律判失败。
    const declared = Number(b.size || 0);
    if (buf.length === 0 && (declared > 0 || b64.length > 0)) {
      return res.json({ ok: false, msg: '文件内容解码为空：' + rel });
    }
    if (declared > 0 && buf.length !== declared) {
      return res.json({ ok: false, msg: '文件长度不符（预期 ' + declared + '，实收 ' + buf.length + '）：' + rel });
    }
    fsMod.writeFileSync(full, buf);
    res.json({ ok: true, bytes: buf.length });
  } catch (e) {
    res.json({ ok: false, msg: '写入失败：' + (e && e.message) });
  }
});

/* v0.10.15：导入中止释放锁 —— 客户端解压/上传/写 finish 出错时主动调用，
 * 避免锁一直挂着（最坏等 30min TTL）导致同 id 短期无法重装。幂等，可重复调。 */
app.post('/api/ext/release', (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  if (!b.id) return res.json({ ok: false, msg: '缺少 id' });
  const id0 = String(b.id).replace(/[\/\\]/g, '');
  extLockFree(id0);
  /* v0.21.0（R9-1）：直传路径的临时 zip 一并清掉，避免半截包占磁盘 */
  try { fsMod.rmSync(require('path').join(extreg.EXT_ROOT, '.tmp-' + id0 + '.zip'), { force: true }); } catch (e) { }
  res.json({ ok: true });
});

/* ═══ v0.21.0（R9-1）大包直传：服务端解压三端点 ════════════════════════
 * 背景：v0.10.16 为防安卓 WebView OOM 给手机端设了 96MB 解压闸门，
 * 138MB 级游戏包（如战机代号666）在解压前就被拦 —— 「之前能导、现在不能」。
 * 现在手机端不再解压：整包 zip 按 4MB 分片直传上来（内存峰值≈单分片），
 * 由 Node 内置 zlib 在服务端解压（见 unzip.js，零新依赖）。
 *   POST /api/ext/zipinit    {id,size}           建会话 + 清空目标目录 + 建临时 zip
 *   POST /api/ext/zipchunk   {id,seq,expect,dataB64}  追加原始字节（tus 式断点续传）
 *   POST /api/ext/zipfinish  {id,meta}          解压 → 审核/桥注入 → 注册 → 热更新
 * ═══════════════════════════════════════════════════════════════════════ */
function zipTmpPath(id) { return require('path').join(extreg.EXT_ROOT, '.tmp-' + String(id).replace(/[\/\\]/g, '') + '.zip'); }

app.post('/api/ext/zipinit', (req, res) => {
  if (!extAdminGuard(req, res)) return;
  const b = req.body || {};
  const v = extreg.validateId(b.id);
  if (!v.ok) return res.json({ ok: false, msg: v.msg });
  if (extLockLive(b.id)) return res.json({ ok: false, msg: '该游戏正在导入中，请稍候' });
  const size = Number(b.size || 0);
  if (!size || size < 22) return res.json({ ok: false, msg: '包体大小非法' });
  if (size > extreg.LIMITS.maxBytes) return res.json({ ok: false, msg: '包体超过 ' + Math.round(extreg.LIMITS.maxBytes / 1048576) + 'MB 上限' });
  try {
    const dir = require('path').join(extreg.EXT_ROOT, b.id);
    // 覆盖安装：与 /api/ext/prepare 同口径，先整目录清空
    fsMod.rmSync(dir, { recursive: true, force: true });
    fsMod.mkdirSync(dir, { recursive: true });
    fsMod.rmSync(zipTmpPath(b.id), { force: true });
    fsMod.writeFileSync(zipTmpPath(b.id), Buffer.alloc(0));
    extLockTake(b.id);
    res.json({ ok: true });
  } catch (e) {
    extLockFree(b.id);
    res.json({ ok: false, msg: '创建目录失败：' + (e && e.message) });
  }
});

app.post('/api/ext/zipchunk', (req, res) => {
  if (!extAdminGuard(req, res)) return;
  const b = req.body || {};
  const id0 = String(b.id || '').replace(/[\/\\]/g, '');
  if (!extLockLive(id0)) return res.json({ ok: false, msg: '导入会话已失效，请重新开始' });
  try {
    const tmp = zipTmpPath(id0);
    if (!fsMod.existsSync(tmp)) return res.json({ ok: false, msg: '请先调用 zipinit' });
    const cur = fsMod.statSync(tmp).size;
    if (cur > extreg.LIMITS.maxBytes) return res.json({ ok: false, msg: '超过包体上限' });
    /* expect 校验：与 /api/ext/chunk 同口径的 tus 式断点续传 */
    if (b.expect != null && Number(b.expect) !== cur) {
      return res.json({ ok: false, mismatch: true, size: cur, msg: '分片偏移不符（服务端 ' + cur + '，客户端 ' + Number(b.expect) + '）' });
    }
    const buf = Buffer.from(String(b.dataB64 || ''), 'base64');
    if (!buf.length) return res.json({ ok: false, msg: '分片内容为空' });
    fsMod.appendFileSync(tmp, buf);
    res.json({ ok: true, size: fsMod.statSync(tmp).size });
  } catch (e) {
    res.json({ ok: false, msg: '分片写入失败：' + (e && e.message) });
  }
});

app.post('/api/ext/zipfinish', async (req, res) => {
  if (!extAdminGuard(req, res)) return;
  const b = req.body || {};
  const id0 = String(b.id || '').replace(/[\/\\]/g, '');
  if (!extLockLive(id0)) return res.json({ ok: false, msg: '导入会话已失效，请重新开始' });
  const tmp = zipTmpPath(id0);
  const dir = require('path').join(extreg.EXT_ROOT, id0);
  try {
    if (!fsMod.existsSync(tmp) || fsMod.statSync(tmp).size < 22) {
      extLockFree(id0);
      return res.json({ ok: false, msg: '上传的压缩包为空或不完整' });
    }
    /* 服务端解压（unzip.js：EOCD/中央目录解析 + zlib，路径穿越/上限全防护） */
    const ex = unzip.extract(tmp, dir, { maxFiles: extreg.LIMITS.maxFiles, maxBytes: extreg.LIMITS.maxBytes });
    fsMod.rmSync(tmp, { force: true });
    if (!ex.files) { extLockFree(id0); return res.json({ ok: false, msg: '压缩包里没有可安装的文件' }); }

    /* 入口探测：优先用户填写且真实存在的入口，否则与前端 findEntry 同口径自动探测 */
    let entry = extreg.safeEntry(String(b.entry || '')) || '';
    if (!entry || ex.names.indexOf(entry) < 0) entry = unzip.findEntry(ex.names);
    if (!entry) {
      extLockFree(id0);
      const isProj = ex.names.some(n => /^assets\/.*\.fire$/i.test(n)) || ex.names.indexOf('project.json') >= 0;
      return res.json({ ok: false, msg: isProj
        ? '这是 Cocos Creator 的「工程源码」。请在 Cocos 里「项目 → 构建发布」选 Web Mobile，把输出目录（含 index.html）打成 zip 再导入'
        : '压缩包里找不到任何 .html 入口文件，请确认打包的是构建产物' });
    }
    const entryFull = require('path').join(dir, entry);
    if (!fsMod.existsSync(entryFull) || fsMod.statSync(entryFull).size === 0) {
      extLockFree(id0);
      return res.json({ ok: false, msg: '入口文件 ' + entry + ' 缺失或为空' });
    }
    const measure = extreg.measure(dir);
    if (!measure) { extLockFree(id0); return res.json({ ok: false, msg: '无法读取安装目录，请重试' }); }
    if (measure.over === 'files') { extLockFree(id0); return res.json({ ok: false, msg: '文件数超过上限（' + extreg.LIMITS.maxFiles + ' 个）' }); }
    if (measure.over === 'bytes') { extLockFree(id0); return res.json({ ok: false, msg: '解压后总大小超过 ' + Math.round(extreg.LIMITS.maxBytes / 1048576) + 'MB 上限' }); }

    /* 审核 + 联机桥注入（R8-5）：必须在 sha1 之前（哈希覆盖注入后的内容） */
    const analysis = extanalyze.analyzeAndInject(dir, entry);
    const rec = extreg.upsert({
      id: id0, label: b.label, seats: b.seats, engine: b.engine || analysis.engine,
      entry: entry, version: b.version, author: b.author, desc: b.desc,
      mp: analysis.mp, obf: !!analysis.obfuscated,
      size: measure.bytes, hash: await extreg.sha1Dir(dir),
    }, '/ext/' + id0);
    extLockFree(id0);
    reloadExtGames();

    broadcastGameList();
    res.json({ ok: true, game: rec, files: measure.files, bytes: measure.bytes, analysis });
  } catch (e) {
    extLockFree(id0);
    try { fsMod.rmSync(tmp, { force: true }); } catch (e2) { }
    res.json({ ok: false, msg: '服务端解压/安装失败：' + (e && e.message) });
  }
});

app.post('/api/ext/finish', async (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  if (!extLockLive(b.id)) return res.json({ ok: false, msg: '导入会话已失效，请重新开始' });
  const dir = require('path').join(extreg.EXT_ROOT, b.id);
  try {
    const measure = extreg.measure(dir);
    if (!measure) { extLockFree(b.id); return res.json({ ok: false, msg: '无法读取安装目录，请重试' }); }
    if (measure.over === 'files') { extLockFree(b.id); return res.json({ ok: false, msg: '文件数超过上限（' + extreg.LIMITS.maxFiles + ' 个），请精简包体后重试' }); }
    if (measure.over === 'bytes') { extLockFree(b.id); return res.json({ ok: false, msg: '解压后总大小超过 ' + Math.round(extreg.LIMITS.maxBytes / 1048576) + 'MB 上限' }); }
    const entry = extreg.safeEntry(b.entry || 'index.html');
    if (!entry) { extLockFree(b.id); return res.json({ ok: false, msg: '入口文件必须是包内 .html' }); }
    if (!measure.bytes || measure.bytes === 0) {
      extLockFree(b.id);
      return res.json({ ok: false, msg: '包内没有任何文件内容，请重新选择游戏包' });
    }
    const entryFull = require('path').join(dir, entry);
    if (!fsMod.existsSync(entryFull)) {
      // 兼容：没给 entry 但根目录有 index.html
      if (fsMod.existsSync(require('path').join(dir, 'index.html'))) {
        // 用默认入口
      } else {
        extLockFree(b.id);
        return res.json({ ok: false, msg: '包里找不到入口文件 ' + entry + '（请把 index.html 放在压缩包根目录）' });
      }
    }
    if (fsMod.existsSync(entryFull) && fsMod.statSync(entryFull).size === 0) {
      extLockFree(b.id);
      return res.json({ ok: false, msg: '入口文件 ' + entry + ' 是空文件，安装后无法打开' });
    }
    /* v0.20.0（R8-5）导入审核解析 + 联机桥注入：
     * 识别引擎、判断包是否已接平台联机协议；未接入的自动把 /ha-link.js
     * 注入入口 HTML —— 游戏侧用 window.HomeArenaLink 几行代码即可获得
     * 平台真实联机（座位/名单/组播/结算）。必须在 sha1 之前做（哈希覆盖注入后内容）。 */
    const analysis = extanalyze.analyzeAndInject(dir, entry);
    const rec = extreg.upsert({
      id: b.id, label: b.label, seats: b.seats, engine: b.engine || analysis.engine,
      entry: entry, version: b.version, author: b.author, desc: b.desc,
      mp: analysis.mp, obf: !!analysis.obfuscated,
      size: measure.bytes, hash: await extreg.sha1Dir(dir),
    }, '/ext/' + b.id);
    extLockFree(b.id);
    reloadExtGames();

    broadcastGameList();
    res.json({ ok: true, game: rec, files: measure.files, bytes: measure.bytes, analysis });
  } catch (e) {
    extLockFree(b.id);
    res.json({ ok: false, msg: '安装失败：' + (e && e.message) });
  }
});

app.post('/api/ext/remove', (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  if (GAMES[b.id] && GAMES[b.id].builtin) return res.json({ ok: false, msg: '内置游戏不可卸载' });
  const r = extreg.remove(b.id);
  if (r.ok) { reloadExtGames(); broadcastGameList(); }
  res.json(r);
});

/* v0.10.13：启用 / 停用外部游戏（不删文件，可随时恢复）
 * 前端「导入游戏管理」用这个接口做开关。停用后该游戏从大厅下架，
 * 已有房间不受影响（正在玩的人不会被打断）。 */
app.post('/api/ext/enable', (req, res) => {
  if (!extAdminGuard(req, res)) return;   // R6-3：导入权仅管理员
  const b = req.body || {};
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!id) return res.json({ ok: false, msg: '缺少游戏 id' });
  if (GAMES[id] && GAMES[id].builtin) return res.json({ ok: false, msg: '内置游戏不可停用' });
  const r = extreg.setEnabled(id, b.enabled !== false);
  if (r.ok) { reloadExtGames(); broadcastGameList(); }
  res.json(r);
});

const server = http.createServer(app);
// Socket.IO 默认只允许同源；客户端外壳是 appassets.local，必须显式放开
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

/* ── v0.33.0（R21-2）：用户画像的「实时」推送 ────────────────────────────
 * 全局只跑一个 5 秒定时器，给所有正在看画像页的管理员广播同一份 overview。
 * 没有观察者时这个定时器只做一次 size 判断就返回，开销可忽略。
 * 用 Set 存 socket 而不是 uid：同一个管理员开两个标签页也能各自刷新；
 * 断开时由 disconnect 处理器移除，不会泄漏。 */
const analyticsWatchers = new Set();
const _analyticsTick = setInterval(() => {
  if (analyticsWatchers.size === 0) return;
  let data = null;
  try { data = analytics.overview(); } catch (e) { return; }
  for (const s of analyticsWatchers) {
    try { s.emit('admin:analytics:overview', data); } catch (e) { /* 单个失败不影响其他 */ }
  }
}, 5000);
if (_analyticsTick.unref) _analyticsTick.unref();


// 游戏注册表（v0.6.0：11 款）
const GAMES = {
  gomoku: { label: '五子棋', seats: 2, state: gomoku.createState, apply: gomoku.applyMove, ai: gomoku.ai },
  chess: { label: '国际象棋', seats: 2, state: chess.createState, apply: chess.applyMove, ai: chess.ai },
  xiangqi: { label: '中国象棋', seats: 2, state: xiangqi.createState, apply: xiangqi.applyMove, ai: xiangqi.ai, view: xiangqi.view || null },
  doudizhu: { label: '斗地主', seats: 3, state: doudizhu.createState, apply: doudizhu.applyMove, ai: doudizhu.ai, view: doudizhu.view },
  guandan: { label: '掼蛋', seats: 4, state: guandan.createState, apply: guandan.applyMove, ai: guandan.ai, view: guandan.view },
  mahjong: { label: '麻将', seats: 4, state: mahjong.createState, apply: mahjong.applyMove, ai: mahjong.ai, view: mahjong.view, onTurnStart: mahjong.onTurnStart },
  reversi: { label: '黑白棋', seats: 2, state: reversi.createState, apply: reversi.applyMove, ai: reversi.ai },
  connect4: { label: '四子棋', seats: 2, state: connect4.createState, apply: connect4.applyMove, ai: connect4.ai },
  go: { label: '围棋', seats: 2, state: go.createState, apply: go.applyMove, ai: go.ai },
  texas: { label: '德州扑克', seats: 4, state: texas.createState, apply: texas.applyMove, ai: texas.ai, view: texas.view, winnerBase: 0 },
  shengji: { label: '双升', seats: 4, state: shengji.createState, apply: shengji.applyMove, ai: shengji.ai, view: shengji.view },
  /* ── v0.10.6 外部游戏插件位 ────────────────────────────────────────
   * kind:'external' 的游戏不经过原生引擎（无 state/apply/ai），
   * 房间只做消息转发（game:move → ext:msg 组播），联机逻辑由游戏自身负责。
   * entry 是 web/ 下的相对目录（iframe 沙箱加载），engine 标注 h5 / cocos。
   * 接入新游戏：在 web/ext/ 放目录 + 在这里注册一行即可，协议见 web/ext/README.md */
  snake: { label: '贪吃蛇·联机', seats: 4, kind: 'external', engine: 'h5', entry: '/ext/snake/', builtin: true },
};
function isExt(g) { return !!(g && g.kind === 'external'); }

/* ── v0.10.7 动态外部游戏注册表 ─────────────────────────────────────
 * 从 data/ext-registry.json 读取用户自助导入的 H5/Cocos 游戏，并入 GAMES。
 * 导入/卸载后调用 reloadExtGames() 热更新，无需重启进程、无需改代码。 */
function reloadExtGames() {
  // 先摘掉旧的动态项（内置 snake 等静态项带 builtin 标记，不动）
  for (const k of Object.keys(GAMES)) {
    if (GAMES[k] && GAMES[k].kind === 'external' && !GAMES[k].builtin) delete GAMES[k];
  }
  let list = [];
  try { list = extreg.list(); } catch (e) { list = []; }
  for (const g of list) {
    if (g.enabled === false) continue;
    GAMES[g.id] = {
      label: g.label, seats: g.seats, kind: 'external',
      engine: g.engine, entry: g.entry, extVersion: g.version, extDynamic: true,
    };
  }
  return list.length;
}
reloadExtGames();

/** 统一游戏元数据出口（init 推送 + 导入后广播，保证前后端字段一致） */
function gameList() {
  return Object.entries(GAMES).map(([k, v]) => ({
    id: k, label: v.label, seats: v.seats,
    kind: v.kind || 'native',
    engine: v.engine || null,
    entry: v.entry || null,
    builtin: !!v.builtin,
    dynamic: !!v.extDynamic,
    /* v0.28.0（R16-6）区域玩法随游戏下发，建房弹窗据此渲染玩法卡片。
     * 只下发展示字段与规则预设，数值仍由服务端 sanitizeRules 兜底。 */
    modes: (MODES[k] || []).map(m => ({ id: m.id, name: m.name, short: m.short, tag: m.tag, desc: m.desc, rules: m.rules })),
  }));
}
/** 导入/卸载游戏后广播新列表，所有在线客户端立即刷新大厅 */
function broadcastGameList() {
  io.emit('games:list', { games: gameList() });
}
// 团队类游戏：胜负以「队伍」而非座位表示（双升 2v2：对角结盟）
// v0.13.0：队伍展开逻辑统一收敛进 normalizeWinners，此表仅作文档保留，
// 结算链路不再依赖它（避免「两处各算一遍」再次分叉）。
const TEAM_GAMES = { guandan: [[0, 2], [1, 3]], shengji: [[0, 2], [1, 3]] };

function genCode() { let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (store.rooms.has(c)); return c; }
function firstEmpty(seats) { return seats.findIndex(s => s.type === 'human' && !s.pid); }
function findRoom(pid) {
  for (const r of store.rooms.values()) if (r.seats.some(s => s.type === 'human' && s.pid === pid) || r.spectators.includes(pid)) return r;
  return null;
}
/* R32 / v0.43.0「一人一房」：列出该 pid 占着的**所有**房间。
 * 旧代码 findRoom() 只返回第一间，而 createRoom/joinRoom 从不检查玩家
 * 是否已在别处 —— 反复点「开桌」就会挂出多间房；退出时 room:leave
 * 又只清 findRoom 那一间，其余房间的 seats 里 pid 仍在，lobbyList 判定
 * 「有真人」继续展示，sweepRooms 也因 occupied 非空永不回收。
 * 用户录屏里「退出房间后房间依然存在，并存多个房间」正是这条链。 */
function roomsOfPid(pid) {
  const out = [];
  for (const r of store.rooms.values()) {
    if (r.seats.some(s => s.type === 'human' && s.pid === pid) || r.spectators.includes(pid)) out.push(r);
  }
  return out;
}
/* 把 socket 从所有房间彻底摘干净（座位 / 观战 / socket.io 频道），
 * 空房立即回收。exceptCode 用于「进新房前只退旧房，别把目标房也清了」。 */
function leaveAllRooms(socket, exceptCode, opts) {
  opts = opts || {};
  const pid = socket.data.pid;
  const touched = [];
  for (const r of roomsOfPid(pid)) {
    if (exceptCode && r.code === exceptCode) continue;
    const idx = r.seats.findIndex(s => s.type === 'human' && s.pid === pid);
    if (idx >= 0) r.seats[idx].pid = null;
    r.spectators = r.spectators.filter(p => p !== pid);
    try { socket.leave(r.code); } catch (e) { }
    if (socket.data.room === r.code) socket.data.room = null;
    const humans = r.seats.filter(x => x.type === 'human' && x.pid);
    if (!humans.length && !r.spectators.length) {
      clearTurnTimer(r.code);
      store.rooms.delete(r.code);
      try { io.in(r.code).socketsLeave(r.code); } catch (e) { }
    } else {
      try { clearTurnTimer(r.code); r.turnDeadline = null; armTurnTimer(r); maybeAITurn(r); } catch (e) { }
      broadcastRoom(r);
    }
    touched.push(r.code);
  }
  if (touched.length) broadcastLobby();
  return touched;
}
function seatOfSocket(r, s) { if (!s) return -1; return r.seats.findIndex(x => x.type === 'human' && x.pid === s.data.pid); }
/* 赢家座位归一化
 * 各游戏 state.winner 的语义历史上不统一：
 *   gomoku/chess/xiangqi/reversi/go → 1/2（1 基玩家号，可能是队伍基准）
 *   doudizhu/mahjong/texas        → 0 基座位号
 *   guandan/shengji               → 队伍号 0/1
 * 前端各渲染分支各自减 1 或直接取，导致「胜者：？」。
 * 这里统一补一个 winnerSeats（0 基座位号数组，天然支持平局多赢家），
 * 前端只用它，不再猜语义。 */
function normalizeWinners(game, st) {
  if (!st) return [];
  if (st.winner == null) return [];
  const w = st.winner;
  switch (game) {
    case 'gomoku':
    case 'chess':
    case 'xiangqi':
    case 'reversi':
    case 'go':
      // 1 基玩家号 → 0 基座位
      return [Number(w) - 1];
    case 'connect4':
      // 1 基座位号（connect4.js:53 `state.winner = seatNo`，seatNo 来自 applyMove 的 1 基 player）
      // —— 原先漏了这一档，落到 default 被当成 0 基解读，胜者显示在隔壁座位
      return [Number(w) - 1];
    case 'guandan':
      // 队伍号 0/1 → 该队两名成员（座位 0,2 或 1,3）
      return [Number(w), Number(w) + 2];
    case 'shengji':
      // 队伍号 0/1 → 座位 (0,2) 或 (1,3)
      return [Number(w), Number(w) + 2];
    case 'doudizhu': {
      // v0.42.0（R29-6）：农民胜利 → 两名农民都算胜者（地主赢则只有地主）。
      // 少这一条时，队友赢了却不在 winnerSeats 里：结算只显示一个名字，
      // 特效也只对先出完牌的那个人放 —— 与「农民同款庆祝」直接冲突。
      const lord = st.landlord;
      if (lord == null) return [Number(w)];
      return Number(w) === Number(lord) ? [Number(lord)]
        : [0, 1, 2].filter(i => i !== Number(lord));
    }
    default:
      // mahjong / texas：本身就是 0 基座位号
      return [Number(w)];
  }
}
function serializeRoom(r, seat) {
  const st = GAMES[r.game].view ? GAMES[r.game].view(r.state, seat) : r.state;
  if (st && typeof st === 'object') {
    // 用 Object.assign 兼容 view 返回的新对象，避免污染各游戏内部 state
    st.winnerSeats = normalizeWinners(r.game, st);
  }
  /* v0.10.11：房间级战绩看板数据。
   * 用户要求下半区「显示牌友胜负率或本房间一直以来的积分记分」，
   * 所以房间对象上多挂两样东西：
   *   roomStats.seats[i] = { games, wins, losses, draws, points }
   *   其中 points 是本房间内的累计积分（胜 +3 / 和 +1 / 负 0），
   *   随每局结束累加，退出房间即丢（这是「本房间记分区」而非总战绩）。
   * 总战绩仍在 playerStats 里，前端可两者并排展示。 */
  const rs = r.roomStats || { seats: [], round: 0 };
  /* ══════════════════════════════════════════════════════════════════════
   * v0.17.0（R4-7）座位牌「更精细」所需的最小档案字段
   * ----------------------------------------------------------------------
   * 截图里三张座位卡一模一样（头像/名字/17 张），看不出谁是高手、谁刚来。
   * 这里补三样**零额外请求**的数据，随快照下发：
   *   rk    —— 该玩家 Elo 段位（取「真实玩家」的总战绩；AI 给难度标）
   *   pts   —— 本房累计积分（roomStats 已有，这里提到座位顶层便于渲染）
   *   game  —— 该玩家在**本游戏**的局数（看得出是老手还是新手）
   * 注意：只透出段位名与局数，不透 rating 具体分值 —— 牌桌上暴露精确分数
   * 会让对局变成「算分」，保留一点神秘感。
   * ══════════════════════════════════════════════════════════════════════ */
  const seatsOut = r.seats.map((s, i) => {
    const o = { type: s.type, name: s.name, avatar: s.avatar, color: s.color, pid: s.pid,
      guest: !!s.guest, aiLevel: s.aiLevel || null, auto: !!s.auto, manual: !!s.manual,
      trusted: s.trusted || 0 };
    const st0 = (rs.seats || [])[i];
    o.pts = st0 ? (st0.points || 0) : 0;
    if (s.type === 'human' && s.pid) {
      try {
        const g = store.getProfile(s.pid);
        if (g) {
          const tg = (g.tier && g.tier.name) || '定级中';
          const gn = (g.byGame && g.byGame[r.game]) ? (g.byGame[r.game].games || 0) : 0;
          o.rk = tg; o.gn = gn; o.games = g.games || 0;
        }
      } catch (e) { /* 档案缺失不影响渲染 */ }
    }
    return o;
  });
  return {
    code: r.code, game: r.game, name: r.name, visibility: r.visibility,
    rules: r.rules || null,
    mode: r.mode || null,
    seats: seatsOut, state: st, chat: r.chat.slice(-50), spectators: r.spectators,
    createdAt: r.createdAt, finished: r.finished || false, recorded: r.recorded || false,
    /* v0.28.0（R16-4）：结算面板要显示「本局用时」，必须给权威时间点。
     * startedAt 每局重置、endedAt 在结算时落一次；首局 startedAt 缺失时回落 createdAt。 */
    startedAt: r.startedAt || r.createdAt || 0, endedAt: r.endedAt || null,
    roomStats: {
      round: rs.round || 0,
      seats: (rs.seats || []).map(s => ({
        games: s.games || 0, wins: s.wins || 0, losses: s.losses || 0,
        draws: s.draws || 0, points: s.points || 0,
        /* v0.13.0（S2）最近一局结果：结算面板即时回显「本局 +3」 */
        last: s.last || null,
      })),
    },
    /* v0.10.12：结算态。前端据此渲染「再来一局 / 换桌」投票条 ——
     * 在此之前，一局打完只能退出房间重开，用户反馈「无法重新开始」。
     * vote 只带聚合信息（谁投了继续/换桌的座位号 + 人类总数 + 截止时间）。 */
    round: r.round || 1,
    /* v0.10.13：彩头（底分）随房间快照下发，房内所有人看到同一个数 */
    bet: r.bet || 0,
    /* v0.12.0（R2-4）：回合计时。客户端只用它画进度条；
     * 真正的裁决在服务端 setTimeout 里，客户端算错时间也不影响牌局。 */
    turnDeadline: r.turnDeadline || 0,
    turnLimit: r.turnLimit || 0,
    vote: r.vote ? {
      after: r.vote.after,
      yes: Array.from(r.vote.yes || []),
      no: Array.from(r.vote.no || []),
      humans: r.seats.filter(s => s.type === 'human' && s.pid).length,
      deadline: r.vote.deadline || 0,
    } : null,
    /* v0.23.0（R11-2）同房比分赛：随房间快照下发（null = 未发起） */
    match: r.match ? serializeMatch(r.match) : null,
  };
}

/** v0.10.11：为房间初始化/重置记分板（创建房间时调用，长度对齐座位数） */
function ensureRoomStats(r) {
  if (!r.roomStats || !Array.isArray(r.roomStats.seats) || r.roomStats.seats.length !== r.seats.length) {
    r.roomStats = {
      round: (r.roomStats && r.roomStats.round) || 0,
      seats: r.seats.map(() => ({ games: 0, wins: 0, losses: 0, draws: 0, points: 0 })),
    };
  }
  return r.roomStats;
}

/** v0.10.11：一局结束后累计本房间积分（只在 recordGame 里调用一次）
 *
 * v0.10.13 修复（用户截图反推出来的）：
 *   旧实现 `for (i...) { s.games += 1; ... }` 对**所有座位**无条件累加，
 *   于是空位（人类但 pid 为空）和 AI 座位也各自记一局。
 *   一张 4 人桌只坐进 1 个真人时，「牌友战绩」顶部显示「3 局」，
 *   而那 3 局其实只有 1 局是真打过的 —— 用户看到的「数据不准确」正是这里。
 *
 *   现在的口径：**只统计真实玩家**（type==='human' 且 pid 非空）。
 *   AI 的胜负不进本房记分榜 —— 它没有可比性（难度不同、可随时换），
 *   而且用户要的是「牌友之间谁在赢」，把机器人塞进排行榜只会稀释信息。
 *   AI 的战绩若要展示，应在座位卡上单独用「本局」口径显示。
 */
function accumulateRoomStats(r, winners) {
  const rs = ensureRoomStats(r);
  rs.round = (rs.round || 0) + 1;
  const winSet = winners instanceof Set ? winners : new Set();
  const isDraw = !!(r.state && r.state.draw);
  /* v0.10.13 彩头（底分）。
   * 旧实现写死「胜 +3 / 和 +1 / 负 +0」，与房间无关 ——
   * 于是用户想设「这局玩大一点」完全无处表达。
   * 现在积分 = 基数 × 倍数：胜 = bet，和 = ceil(bet/3)（和局按三成赔），负 = 0。
   * bet 缺省 1，等价于旧行为的所有比例关系（3:1:0 → 1:1/3:0），
   * 但数值会小 3 倍 —— 为了让老房间读数不变，bet=0/未设时仍走旧公式。 */
  const bet = Number(r.bet) > 0 ? Number(r.bet) : 0;
  const ptWin = bet || 3;
  const ptDraw = bet ? Math.max(1, Math.round(bet / 3)) : 1;
  for (let i = 0; i < rs.seats.length; i++) {
    const seat = r.seats[i];
    /* v0.13.0（S2）AI 也进本房记分，只把**空位**排除。
     *
     * 旧口径「只有真人算」看起来合理，落到界面上却是灾难：
     * 一个人机陪练桌，牌友战绩两行永远是「—」，积分榜三行永远「0 分」——
     * 用户第一眼就判定「这面板是假的」。而实际上这局刚刚分出胜负。
     *
     * 现在的口径：在座的都记（真人 + 人机），空位（type=human 且无 pid）不记。
     * 人机行在 UI 上带机器人图标 + 灰化，谁是人谁是机一眼可分，
     * 但「几局、几胜、多少分」这些数字是真的。 */
    if (!seat) continue;
    if (seat.type === 'human' && !seat.pid) continue;
    const s = rs.seats[i];
    s.games = (s.games || 0) + 1;
    let pts = 0, win = false;
    if (isDraw) { s.draws = (s.draws || 0) + 1; pts = ptDraw; }
    else if (winSet.has(i)) { s.wins = (s.wins || 0) + 1; win = true; pts = ptWin; }
    else { s.losses = (s.losses || 0) + 1; }
    s.points = (s.points || 0) + pts;
    /* v0.13.0（S2）本局结果快照：结算面板要立即显示「+3 / 本局胜」，
     * 而不是等下一帧或者干脆不显示。只保留最近一局，不占空间。 */
    s.last = { round: rs.round, win, draw: isDraw, pts };
  }
}
function broadcastRoom(r) {
  const rm = io.sockets.adapter.rooms.get(r.code); if (!rm) return;
  for (const sid of rm) { const s = io.sockets.sockets.get(sid); if (s) s.emit('room:state', serializeRoom(r, seatOfSocket(r, s))); }
}

/* ---------------- 大厅列表 ---------------- */
function lobbyList() {
  const out = [];
  for (const r of store.rooms.values()) {
    if (r.visibility === 'private') continue;
    /* v0.30.0（R18-1）：没有任何真人在座的房不上大厅 ——
     * 房主断线后宽限期内的「幽灵桌」既不能进（会转观战）也没人打，
     * 展示它只会制造误点。等宽限期结束由回收器清掉。 */
    if (!r.seats.some(s => s.type === 'human' && s.pid) && !r.spectators.length) continue;
    // 全员离线且已结束的桌子不再展示（等回收器删）
    if (r.finished && !r.seats.some(s => s.type === 'human' && s.pid)) continue;
    const humans = r.seats.filter(s => s.type === 'human');
    /* v0.46.0（R35-7）：「真人 x/y」的 y 必须是**能坐人的座位数**，而不是
     * 当前 type 恰好为 human 的座位数。
     * 旧口径下，开桌时把两个座位设成「空位」的 3 人桌会显示「真人 1/1」——
     * 明明还空着两把椅子，卡片却写着 1/1，玩家以为满员不敢进；
     * 更糟的是同屏还可能挂着「加入」按钮，两个信号自相矛盾。
     * 现在 x/y 与 joinable 用同一个口径：非 AI 座位 = 可坐人的座位。 */
    const openSeats = r.seats.filter(s => s.type !== 'ai');
    const taken = openSeats.filter(s => s.pid).length;
    const host = humans.find(s => s.pid);
    const st = r.state || {};
    /* v0.27.0（R15-2）「正在联机」看板需要的实时字段：
     *   · joinable —— 还有人类空位且未结束（能不能进）；
     *   · playing  —— 真打起来了（有落子/出牌/非初始阶段），区别于「刚开桌」；
     *   · round/bet/host —— 局数、底分、房主，都是一眼判断「这桌值不值得进」的信息。
     * 这些字段此前只有进了房间才拿得到，大厅里只能看到人数 —— 用户无法判断
     * 一桌是「三缺一」还是「正打到第 5 局」，只能逐个点进去试。 */
    const played = (Array.isArray(st.moves) && st.moves.length > 0)
      || (st.phase && ['idle', 'waiting', 'ended', ''].indexOf(st.phase) < 0)
      || (r.game === 'doudizhu' && (st.bids || []).length > 0);
    out.push({
      code: r.code, game: r.game, gameLabel: GAMES[r.game].label, name: r.name,
      seats: r.seats.length, taken,
      humanSeats: openSeats.length, aiSeats: r.seats.filter(s => s.type === 'ai').length,
      hasPassword: !!r.password, finished: !!r.finished, createdAt: r.createdAt,
      spectators: r.spectators.length,
      round: r.round || 1, bet: r.bet || 0,
      /* v0.28.0（R16-6）大厅卡也标玩法短名 —— 同一款游戏可能有多种规矩，
       * 进桌前就要知道这桌是「川麻」还是「推倒胡」。 */
      mode: r.mode ? { short: r.mode.short, name: r.mode.name } : null,
      playing: !r.finished && !!played,
      joinable: !r.finished && taken < openSeats.length,
      host: (host && (host.name || '')) || '',
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
}
function broadcastLobby() { io.emit('lobby:list', { rooms: lobbyList() }); }

/* ---------------- 房间生命周期回收 ----------------
 * 之前房间只增不减：玩家关掉页面 / 手机切后台后，桌子永远挂在大厅里，
 * 首页「N 桌进行中」的计数会一直虚高。这里做两件事：
 *   ① 真人座位全部空出来（pid 清空）→ 保留 EMPTY_KEEP_MS 供人回流，之后销毁
 *   ② 全部真人离线超过 OFFLINE_KEEP_MS → 直接销毁
 * 全靠 seat.pid 是否为空来判断，无需额外心跳表。
 */
const EMPTY_KEEP_MS = Number(process.env.ROOM_EMPTY_KEEP_MS || 3 * 60 * 1000);   // 3 分钟
const OFFLINE_KEEP_MS = Number(process.env.ROOM_OFFLINE_KEEP_MS || 12 * 60 * 1000); // 12 分钟

function sweepRooms() {
  const now = Date.now();
  let changed = false;
  for (const [code, r] of store.rooms) {
    const humans = r.seats.filter(s => s.type === 'human');
    const occupied = humans.filter(s => s.pid);
    if (occupied.length) {
      // 有人在线：刷新活动时间
      r.lastActiveAt = now;
      /* v0.10.12：结算后正在投票的房间**不能被回收** ——
       * 否则 45 秒投票没走完，桌子已经被 sweep 清掉，
       * 玩家点「再来一局」会得到「房间不存在」。 */
      if (r.vote) {
        if (now >= r.vote.deadline) { try { resolveVote(r, null); } catch (e) { } changed = true; }
        continue;
      }
      // 已结束的桌子，若观战席也空了，缩短保留期
      if (r.finished && !r.spectators.length) {
        r.finishedAt = r.finishedAt || now;
        if (now - r.finishedAt > EMPTY_KEEP_MS) { store.rooms.delete(code); changed = true; }
      }
      continue;
    }
    // 无人在座：空桌或全员离线
    r.emptySince = r.emptySince || now;
    const idle = now - r.emptySince;
    const limit = r.finished ? EMPTY_KEEP_MS : OFFLINE_KEEP_MS;
    if (idle > limit) {
      store.rooms.delete(code);
      changed = true;
      console.log('[room] reclaim', code, r.game, Math.round(idle / 1000) + 's idle');
    }
  }
  if (changed) broadcastLobby();
}
const SWEEP_MS = Number(process.env.ROOM_SWEEP_MS || 20000);
setInterval(sweepRooms, SWEEP_MS).unref();

/* ---------------- 战绩 ---------------- */
function recordGame(r) {
  if (r.recorded) return;
  const st = r.state;
  if (st.winner == null && !st.draw) return;
  r.recorded = true;
  r.finished = true;
  r.endedAt = Date.now();
  /* ══════════════════════════════════════════════════════════════════════
   * v0.13.0（S1 修 P0「赢了却记成输」）
   * ----------------------------------------------------------------------
   * 用户：「战绩面板和积分面板都是虚假数据」。
   *
   * 真凶在这里 —— 历史上 recordGame 自己重新推了一遍赢家座位，
   * 用的是「winner 一律当 1 基、减 1 还原」的旧口径：
   *
   *     winners.add(st.winner - (GAMES[game].winnerBase === 0 ? 0 : 1));
   *
   * 但斗地主 / 麻将的 applyMove 内部已经把 player(1 基) 转成 seat = player-1，
   * 落进 state.winner 的**本来就是 0 基座位号**；这两个游戏又没有声明
   * winnerBase，于是被再减一次 1 —— 赢家永远记到「赢家的上家」头上。
   *
   * 实测（v0.12.0，真人坐 0 号位、AI 阿飞坐 1 号位当地主并获胜）：
   *   · 桌面显示「胜者：阿飞」（前端走 normalizeWinners，正确）
   *   · 牌友战绩却给我记 100% 胜率、+3 分（后端累加，错误）
   *   · Elo 同步反着算：赢家掉分、输家涨分
   * 一个界面两种事实，这就是「虚假数据」的来源。
   *
   * 修法：**只认 normalizeWinners 这一个出口**。它已经把 1 基 / 0 基 /
   * 队伍号三种语义归一成「0 基座位号数组」，前端显示用的也是它。
   * 结算、Elo、本房记分从此和界面完全同源，不可能再分叉。
   * ══════════════════════════════════════════════════════════════════════ */
  const winners = new Set(
    (st.draw ? [] : normalizeWinners(r.game, st))
      .filter(n => Number.isInteger(n) && n >= 0 && n < r.seats.length)
  );
  /* ═══════════════════════════════════════════════════════════════════
   * v0.12.0（R2-2）真实积分：先算全桌 Elo，再逐人落账
   * -------------------------------------------------------------------
   * 为什么必须在这里算：
   *   Elo 的输入是「我和每个对手的分差」，而**只有记录下来之前**
   *   全桌所有座位是可知的（人类的 pid、AI 的档位）。store 层看不到这些。
   *
   * 对手强度来源（这就是「专业逻辑」与「死板展示」的分水岭）：
   *   · 真人 → 该游戏当前 Elo 分（没打过就是 1000）
   *   · AI   → 档位折算固定分：超人 1750 / 强 1400 / 娱乐 1050
   *     于是「打赢超人」涨得多、「打赢娱乐」几乎不涨，符合直觉。
   *
   * 兜底：整桌全是 AI 或只有 1 个真人时，Elo 依然成立（对手是 AI 的分），
   *   所以单机练习也涨分 —— 但打赢娱乐档只涨 1~2 分，不会刷分。
   * ═══════════════════════════════════════════════════════════════════ */
  const ratingPool = [];
  r.seats.forEach((s, i) => {
    if (!s) return;
    let outcome = st.draw ? 'draw' : (winners.has(i) ? 'win' : 'loss');
    if (s.type === 'ai') {
      ratingPool.push({ pid: 'ai#' + i, rating: rating.AI_RATING[s.aiLevel || 'fun'] || rating.AI_RATING.fun, games: 999, outcome });
    } else if (s.pid) {
      const g = store.statOf(s.pid).byGame[r.game] || {};
      ratingPool.push({ pid: s.pid, rating: g.everRated ? g.rating : rating.BASE, games: g.games || 0, outcome });
    }
  });
  const deltas = rating.computeDeltas(ratingPool);
  r.seats.forEach((s, i) => {
    if (s.type !== 'human' || !s.pid) return;
    let outcome = 'draw';
    if (!st.draw) outcome = winners.has(i) ? 'win' : 'loss';
    const opp = r.seats.filter((_, j) => j !== i)
      .map(x => x.type === 'ai' ? (x.name || 'AI-' + (x.aiLevel || 'fun')) : (x.name || '玩家'))
      .slice(0, 3).join(' / ') || '—';
    const mine = deltas.get(s.pid);
    store.recordResult(s.pid, r.game, outcome, {
      opp, rc: r.code,
      n: (st.moves || []).length,
      dur: Date.now() - r.createdAt,
      ratings: mine ? { [s.pid]: mine } : null,
      /* v0.12.0（R2-3）：排行榜要显示名字与头像，落账时一并更新 */
      name: s.name, avatar: s.avatar, color: s.color, guest: !!s.guest,
    });
    // 记下本局积分变化，用于结算页展示「+24」
    s.lastDelta = mine ? mine.delta : 0;
  });
  // 结算后主动把最新战绩推给房内所有人，避免返回大厅时看到的是旧缓存
  /* v0.10.11：先累计「本房间积分记分」再广播。
   * 注意顺序：accumulateRoomStats 必须在 broadcastRoom 之前，
   * 否则客户端收到的 roomStats 会慢一局。 */
  try { accumulateRoomStats(r, winners); } catch (e) { }
  /* v0.12.0（R2-1）：把本局牌谱存进每个在场真人的账下 */
  try { persistReplayFor(r); } catch (e) { }
  pushStats(r);
  /* v0.10.12：结算后立即开「续局投票」。开在 broadcastRoom 之前，
   * 保证客户端收到结算帧时就带着 vote，UI 不用等下一帧。 */
  try { openVote(r); } catch (e) { }
  /* v0.13.0（S4）一局打完，托管状态立刻下线。
   * 结算画面是「这局结束了」的语气，座位上还挂着「托管中」会自相矛盾
   * （用户截图里就是这样：明明已经「胜者：老狮」，我头像旁还写着托管）。*/
  for (const s of r.seats) if (s) s.auto = false;
  broadcastRoom(r);
  broadcastLobby();
}
/* v0.10.13：外部游戏结算入口。
 * 与 recordGame 的区别：外部游戏的胜负由游戏包自己判定（宿主看不到内部状态），
 * 所以只做「结构化收纳 + 白名单校验」，绝不对 payload 做语义解释。
 * 幂等：同一房间同一 round 只记一次（包可能重连后重发结算帧）。 */
function recordExtResult(r, res) {
  if (!r || r.finished) return;
  const key = 'ext:' + (r.round || 1);
  if (!r._extDone) r._extDone = {};
  if (r._extDone[key]) return;
  r._extDone[key] = 1;

  r.finished = true;
  r.recorded = true;
  r.endedAt = Date.now();
  const winSet = new Set(res.draw ? [] : res.winners);
  const detail = (res.detail && typeof res.detail === 'object') ? res.detail : {};

  r.seats.forEach((s, i) => {
    if (s.type !== 'human' || !s.pid) return;
    const outcome = res.draw ? 'draw' : (winSet.has(i) ? 'win' : 'loss');
    const opp = r.seats.filter((_, j) => j !== i)
      .map(x => x.type === 'ai' ? (x.name || 'AI') : (x.name || '玩家'))
      .slice(0, 3).join(' / ') || '—';
    /* v0.12.0：外部游戏同样计分。对手强度按同座 AI 档位折算；
     * 外部游戏没有服务端 state，但座位信息是可靠的。 */
    const pool = [];
    r.seats.forEach((x, j) => {
      if (!x) return;
      const o = res.draw ? 'draw' : (winSet.has(j) ? 'win' : 'loss');
      if (x.type === 'ai') pool.push({ pid: 'ai#' + j, rating: rating.AI_RATING[x.aiLevel || 'fun'] || rating.AI_RATING.fun, games: 999, outcome: o });
      else if (x.pid) { const gg = store.statOf(x.pid).byGame[r.game] || {}; pool.push({ pid: x.pid, rating: gg.everRated ? gg.rating : rating.BASE, games: gg.games || 0, outcome: o }); }
    });
    const dl = rating.computeDeltas(pool);
    const mine2 = dl.get(s.pid);
    store.recordResult(s.pid, r.game, outcome, {
      opp, rc: r.code, n: Number(detail.steps) || 0,
      dur: Date.now() - r.createdAt,
      ratings: mine2 ? { [s.pid]: mine2 } : null,
      name: s.name, avatar: s.avatar, color: s.color, guest: !!s.guest,
    });
    s.lastDelta = mine2 ? mine2.delta : 0;
  });
  try { accumulateRoomStats(r, winSet); } catch (e) { }
  try { persistReplayFor(r); } catch (e) { }
  pushStats(r);
  try { openVote(r); } catch (e) { }
  broadcastRoom(r);
  broadcastLobby();
}

/* ══════════════════════════════════════════════════════════════════════
 * v0.23.0（R11-2）外部游戏「同房比分赛」
 * ----------------------------------------------------------------------
 * 背景：v0.22.0 实测三个真实游戏包主逻辑全为混淆，无法 hook 内部状态，
 * 「同屏」徽标只能如实标注。但**不依赖包内改造**的联机还有一个层次：
 * 同一房间里的各人各自游玩同一游戏（或同屏轮流），每局结束后把**分数**
 * 报到房里，服务端汇总排行、达标收官。这就是「异步比分赛」——
 * 混淆包从「各玩各的」升级为「同房比出个高低」。
 *
 * 设计要点：
 *   · 手动记分（自报）：混淆包拿不到真实分数，诚实地做成「+ 记一局」
 *     手动上报，家庭场景可接受；不假装能自动抓分。
 *   · 服务端只做结构收纳与白名单校验（整数、范围），不解释语义。
 *   · 全员达到目标局数 → 收官，总分最高者夺冠，房内播报。
 *   · 挂在房间对象上（r.match），serializeRoom 随快照下发，
 *     不引入新的存储/接口 —— 退房即散，符合「本房比分」的定位。
 * ══════════════════════════════════════════════════════════════════════ */
function matchEnsure(r) {
  if (!r.match) r.match = { target: 3, scores: {}, done: false, champion: null };
  return r.match;
}
function serializeMatch(m) {
  const rows = Object.entries(m.scores).map(([pid, v]) => ({
    pid, name: v.name, rounds: (v.rounds || []).map(x => x.n), total: v.total || 0,
  }));
  rows.sort((a, b) => b.total - a.total);
  return { target: m.target, done: !!m.done, champion: m.champion, rows };
}

/** v0.12.0（R2-1）：结算后为房内每个真人落一份牌谱 */
function persistReplayFor(r) {
  const rp = replayLib.buildReplay(r, (GAMES[r.game] && GAMES[r.game].label) || r.game);
  if (!rp.moves.length) return;   // 空局（比如刚建就退出）不记
  for (const seat of r.seats) {
    if (seat && seat.type === 'human' && seat.pid) {
      try { store.saveReplay(seat.pid, rp); } catch (e) { }
    }
  }
}

function pushStats(r) {
  try {
    const rm = io.sockets.adapter.rooms.get(r.code);
    if (!rm) return;
    for (const sid of rm) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data && s.data.pid) s.emit('lobby:stats', { stats: store.publicStatOf(s.data.pid) });
    }
  } catch (e) { /* 广播失败不影响对局 */ }
}

/* ==========================================================================
 * v0.10.12  桌局生命周期：结算后「继续 / 换桌」
 * --------------------------------------------------------------------------
 * 用户反馈：「棋牌游戏联机时无法重新开始或者可控的选择继续还是换桌」。
 *
 * 旧行为：recordGame() 把 r.finished 置 true 之后就结束了 ——
 *   大厅卡片变灰（disabled）、房间被 sweep 定时回收，
 *   玩家唯一出路是手动退出房间再重新建房、重新邀请。
 *
 * 新行为（一局结束即开启投票，默认 45 秒）：
 *   · 房内每个真人投「继续」或「换桌」，票数实时广播；
 *   · 全员投「继续」→ 立刻开下一局（state 重置，座位/记分保留）；
 *   · 有任意一人投「换桌」→ 立刻解散房间，所有人回大厅；
 *   · 超时未表态 → 按「继续」算（多数人只是想接着玩）。
 *
 * 为什么不是「房主单方面决定」：
 *   家庭场景里经常有长辈中途想换游戏，房主一言堂会让人直接退房，
 *   投票制既民主又能给出明确倒计时，不会无限挂着。
 * ========================================================================== */
const VOTE_TTL_MS = Number(process.env.REMATCH_VOTE_MS || 45000);

function humansOf(r) {
  return r.seats.filter(s => s.type === 'human' && s.pid);
}

function openVote(r) {
  /* 外部游戏没有服务端 state 可重置，多局语义也不明确 —— 不投票，直接标记结束。
   * 玩家照常可以退出重开。 */
  if (isExt(GAMES[r.game])) { r.vote = null; return; }
  const hs = humansOf(r);
  if (hs.length === 0) { r.vote = null; return; }
  r.vote = {
    after: r.round || 1,
    yes: new Set(),
    no: new Set(),
    deadline: Date.now() + VOTE_TTL_MS,
  };
}

/** 重置成新一局：state 重来、recorded/finished 复位、round+1，座位与 roomStats 保留 */
function startNextRound(r) {
  const def = GAMES[r.game];
  /* v0.12.0（R3-4）：规则是房间属性，「再来一局」重建 state 时原样带回 */
  r.state = def.state ? def.state(r.rules) : { ext: true, v: 1 };
  r.finished = false;
  r.recorded = false;
  r.endedAt = null;
  r.round = (r.round || 1) + 1;
  r.startedAt = Date.now();
  r.vote = null;
  /* v0.12.0（R2-4）：新一局重新计托管次数 —— 上一局的托管不该累积到这一局，
   * 否则打了一晚上的人会被永久标成「托管中」。
   * v0.17.0：跨局托管（seat.manual）保留 —— 玩家点了「托管」通常是想连续挂几局，
   * 每局又要重新点一次反而更烦。只有本人「接回」才清掉。 */
  for (const st of r.seats) if (st) { st.trusted = st.manual ? st.trusted : 0; st.trustedAt = 0; st.auto = !!st.manual; }
  clearTurnTimer(r.code); r.turnDeadline = null;
  try { maybeAITurn(r); } catch (e) { }
  /* 开局第一手也可能是真人 —— 直接在 maybeAITurn 之后排一次（若轮到 AI 会被覆盖清掉） */
  try { armTurnTimer(r); broadcastRoom(r); } catch (e) { }
}

/** 结算投票：all-yes 继续；any-no 换桌；超时视同继续 */
function resolveVote(r, force) {
  const v = r.vote;
  if (!v) return;
  const hs = humansOf(r);
  const total = hs.length;
  const yes = v.yes.size;
  const no = v.no.size;
  const expired = Date.now() >= v.deadline;
  if (force === 'switch' || no > 0) {
    // 换桌：直接解散，所有人回大厅
    r.vote = null;
    disbanRoom(r, no > 0 ? '有玩家选择了换桌' : '本局结束');
    return;
  }
  if (yes >= total || expired) {
    startNextRound(r);
    broadcastRoom(r);
    broadcastLobby();
    return;
  }
  broadcastRoom(r);
}

/** 解散房间：清座位并通知所有人回大厅（不立即删对象，避免前端还在等 room 帧） */
function disbanRoom(r, reason) {
  r.finished = true;
  r.vote = null;
  r.disbanned = reason || '房间已解散';
  /* v0.28.0（R16-3）：⚠️ 顺序即语义。
   * 旧版先 emit room:closed、后 broadcastRoom —— 客户端收到 closed 已回大厅，
   * 紧接着晚到的 room:state 又把它拽回房间，表现为「点换桌没反应」。
   * 现在先把「已结束」这一帧发完，最后再发解散通知，客户端落在哪就是哪。 */
  broadcastRoom(r);
  broadcastLobby();
  try {
    const rm = io.sockets.adapter.rooms.get(r.code);
    if (rm) {
      for (const sid of rm) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('room:closed', { code: r.code, reason: r.disbanned });
      }
    }
  } catch (e) { }
}

/* ---------------- 身份：账号 / 游客 ---------------- */
// pid 与身份的关系：
//   · 已登录：pid = u_xxx（账号 uid），战绩随账号走
//   · 游客：  pid = g_xxx（临时，内存态，不进 users.json）
//   · 老客户端（v0.8.0 及以前）继续用 p_xxx，兼容不改前端也能连
function bindIdentity(socket, identity) {
  if (!identity) return;
  const oldPid = socket.data.pid;
  const newPid = identity.uid || identity.gid;
  socket.data.identity = identity;
  socket.data.pid = newPid;
  socket.data.name = identity.name;
  // 在房间里改身份：把旧 pid 占的座位/观战席迁到新 pid，否则前端 mySeat() 会落空被当成观战者
  if (oldPid && oldPid !== newPid) migratePid(oldPid, newPid, identity);
  socket.emit('account:state', { user: { uid: newPid, name: identity.name, avatar: identity.avatar, color: identity.color, guest: !!identity.guest, admin: settings.isAdminUid(newPid) } });
  socket.emit('lobby:stats', { stats: store.publicStatOf(newPid) });
  /* v0.46.0（R35-6）：身份一绑定，立刻补发「成员才可见」的两份清单。
   *
   * 根因：v0.34.0 起，门禁关着时 init 里刻意不带 games / rooms
   * （未登录连接不该在握手阶段就看到本厅有什么游戏、有几桌）。
   * 但**登录 / 注册成功后没有人补发** —— 于是新注册用户虽然拆掉了
   * 登录墙，大厅里却一款游戏都没有、游戏墙是空的，「开桌」按钮
   * 根本不存在。用户看到的现象就是「所有状态和角色都无法开房联机」。
   * 这里放在 bindIdentity 里，注册 / 登录 / token 自动登录三条路一次覆盖。 */
  try { socket.emit('games:list', { games: gameList() }); } catch (e) { }
  try { socket.emit('lobby:list', { rooms: lobbyList() }); } catch (e) { }
}

/** 身份升级（p_xxx → u_xxx / g_xxx）时，把座位与观战席一并迁移 */
function migratePid(oldPid, newPid, identity) {
  const r = findRoom(oldPid);
  if (!r) return;
  for (const s of r.seats) {
    if (s.type === 'human' && s.pid === oldPid) {
      s.pid = newPid;
      if (identity) { s.name = identity.name; s.avatar = identity.avatar; s.color = identity.color; s.guest = !!identity.guest; }
    }
  }
  const si = r.spectators.indexOf(oldPid);
  if (si >= 0) { r.spectators.splice(si, 1); if (!r.spectators.includes(newPid)) r.spectators.push(newPid); }
  broadcastRoom(r); broadcastLobby();
}

io.on('connection', (socket) => {
  // 全局兜底：任何事件处理器里的同步异常都不该拖垮整个 Hub。
  // socket.io 会在监听器抛错时冒泡到 EventEmitter，进而终止进程，
  // 因此这里统一包一层 try/catch + 日志，把「一个人出错」限制在「一个人」。
  const safeWrap = () => {
    const origOn = socket.on.bind(socket);
    socket.on = function (ev, fn) {
      if (typeof fn !== 'function') return origOn(ev, fn);
      return origOn(ev, function (...args) {
        try { return fn.apply(this, args); }
        catch (e) {
          console.error('[socket]', ev, e && (e.stack || e.message));
          try { socket.emit('error:msg', { msg: '操作异常，请重试' }); } catch (_) { }
        }
      });
    };
  };
  safeWrap();

  /* ══════ v0.34.0（R22-2）仅注册成员的硬门禁 ══════════════════════════
   * 用户诉求：「不开放注册时依然可以游客进入，需要修复，仅注册用户才能
   * 使用，非注册用户**完全不可见任何内容**。」
   *
   * 关键判断：这件事**不能只在前端做**。
   *   前端藏起来只是"看不见"，`lobby:list` 一 emit 数据照样下发，
   *   抓个包/开个控制台就全拿到了 —— 那不是权限，是遮羞布。
   *   必须在服务端的事件入口拦，且要拦得**没有遗漏窗口**。
   *
   * 用 socket.io 的 socket.use 中间件，而不是逐个改 100+ 个 socket.on：
   *   · 中间件在事件分发给 handler **之前**统一执行；
   *   · 不调用 next() = 这个包被丢弃，handler 永远不会跑；
   *   · 以后新增业务事件**自动**受保护，不存在"漏加一行判断"的窗口。
   *
   * 放行白名单只有四类，缺一不可：
   *   · 登录/注册/退出 —— 不放行用户没法自救；
   *   · account:guest —— 要让它进来才能回一句明确的「本厅仅对成员开放」，
   *     直接丢弃会表现为"点了没反应"，比报错更让人抓狂；
   *   · settings:get —— 前端靠它拿 accessMode 才能渲染登录墙；
   *   · device:* / admin:analytics:* —— 画像采集与后台，自带权限判定。
   * ================================================================ */
  const GATE_FREE = new Set([
    'account:login', 'account:register', 'account:guest', 'account:logout',
    'settings:get',
    'device:hello', 'device:page', 'device:ping',
  ]);
  /* 提示节流：被拒的客户端如果疯狂重试，不能让它把 emit 打成广播风暴。
   * 放在 connection 闭包里 —— socket 断开后整个闭包可回收，不需要手动清。 */
  const gateWarnAt = new Map();

  socket.use((packet, next) => {
    /* 门禁关着 = 谁都放行，走原始路径，零额外开销 */
    if (settings.get().allowGuest !== false) return next();
    const ev = String((packet && packet[0]) || '');
    if (GATE_FREE.has(ev) || ev.indexOf('admin:analytics:') === 0) return next();
    /* 已登录的注册成员：正常放行。注意判的是 identity.guest，
     * 不是 identity 是否存在 —— 游客也有 identity。 */
    const id = socket.data.identity;
    if (id && !id.guest) return next();

    const t = Date.now();
    if (t - (gateWarnAt.get(socket) || 0) > 3000) {
      gateWarnAt.set(socket, t);
      try {
        socket.emit('access:locked', {
          code: 'MEMBERS_ONLY',
          msg: '本厅仅对已注册成员开放',
          accessMode: !settings.get().allowRegister ? 'membersOnly' : 'loginOnly',
        });
      } catch (e) { /* ignore */ }
    }
    /* 不调 next：包直接丢弃，handler 不会执行 */
  });

  // 断线重连：客户端可携带已保存的 pid；已登录时带 token
  const auth = socket.handshake.auth || {};
  const clientPid = auth.pid || socket.handshake.query.pid;
  const token = auth.token || socket.handshake.query.token;
  /* R32 / v0.43.0：boot = 本次页面加载的唯一标识。socket.io 自动重连
   * 复用同一页面（boot 不变）才允许断线保座回填；杀后台重新打开 App
   * 会重新加载页面 → boot 变化 → 不回填。见 store.takeReconnect。 */
  socket.data.boot = String(auth.boot || socket.handshake.query.boot || '');
  const authUser = token ? account.resolve(token) : null;

  if (authUser) {
    socket.data.pid = authUser.uid;
    socket.data.identity = { uid: authUser.uid, name: authUser.name, avatar: authUser.avatar, color: authUser.color };
    socket.data.token = token;
    /* v0.12.0（P0-1）：滚动续期。
     * 签名 token 有 180 天有效期，长期不换会有一天突然掉线。
     * 剩余不足 1/3 时下发新 token，前端静默替换 —— 用户永远感觉不到。 */
    if (account.needsRefresh(token)) {
      try { socket.emit('account:token', { token: account.newToken(authUser.uid) }); } catch (e) { }
    }
  } else if (token) {
    /* token 存在但验不过（过期 / 密钥换过 / 账号被删）——
     * 明确告知前端「凭证已失效」，让它清掉本地 token 回到未登录态，
     * 而不是留着一个永远用不上的东西在 localStorage 里。 */
    try { socket.emit('account:expired', { reason: 'session_invalid' }); } catch (e) { }
  }
  if (!authUser) {
    socket.data.pid = (typeof clientPid === 'string' && /^[pgu]_/.test(clientPid)) ? clientPid : 'p_' + Math.random().toString(36).slice(2, 10);
  }

  /* v0.34.0（R22-2）：门禁关着时，init 里**不能**带 games / 房间列表。
   * 之前这里是无条件全量推送 —— 也就是说即使前端做了登录墙，
   * 一个未登录的连接在握手阶段就已经把「本厅有哪些游戏、有几桌、
   * 桌号是多少」全收下了。这就是"完全不可见"没做到的地方。 */
  const gateClosed = settings.get().allowGuest === false;
  const ident = socket.data.identity;
  const memberOk = !!(ident && !ident.guest);
  const lockNow = gateClosed && !memberOk;

  socket.emit('init', {
    pid: socket.data.pid,
    games: lockNow ? [] : gameList(),
    version: VERSION,
    /* 锁定态额外下发准入信息，前端据此**立刻**渲染登录墙，
     * 不必等 settings:snapshot 回来（少一次可见内容的闪烁）。 */
    locked: lockNow,
    accessMode: !settings.get().allowRegister
      ? (gateClosed ? 'membersOnly' : 'guestOnly')
      : (gateClosed ? 'loginOnly' : 'open'),
    /* 两个原始布尔一并下发：前端拿到 init 就能画准登录墙，
     * 不用等 settings:snapshot（那一次往返足够用户看到半秒大厅）。 */
    allowRegister: !!settings.get().allowRegister,
    allowGuest: !!settings.get().allowGuest,
    me: ident ? Object.assign({}, ident, {
      admin: settings.isAdminUid(ident.uid),
    }) : null,
  });
  if (!lockNow) {
    socket.emit('lobby:list', { rooms: lobbyList() });
    socket.emit('lobby:stats', { stats: store.publicStatOf(socket.data.pid) });
  }

  /* v0.11.0（R4-1）AI 引擎状态：告诉客户端「超神档现在到底是谁在出牌」。
   * 探测异步、有缓存，不阻塞 init —— 先给缓存值，探完若有变化再补一条。 */
  socket.emit('ai:status', dz.status());
  dz.probe().then(st => {
    if (st && st.configured && st.online !== dz.usable()) socket.emit('ai:status', dz.status());
    else if (st && st.online) socket.emit('ai:status', dz.status());
  }).catch(() => { });

  /* ---- 账号事件 ---- */
  /* ── 安全解包（防御空载荷）─────────────────────────────────────────
   * socket.io 客户端 emit('x') 不带参数时，处理器形参收到的是 null 而非 undefined，
   * 因此 `({ a } = {}) => {}` 会抛 TypeError 并让整个 Node 进程退出（线上事故级）。
   * 统一用 sd() 包一层：sd(payload, ['a','b']) 返回安全对象。 */
  const sd = (p, keys) => {
    const src = (p && typeof p === 'object') ? p : {};
    const out = {};
    for (const k of keys) out[k] = src[k];
    return out;
  };

  /* ── v0.10.21 系统设置：读（任何客户端） / 写（管理员鉴权） ── */
  socket.on('settings:get', () => {
    socket.emit('settings:snapshot', settings.snapshot());
  });
  /* v0.11.0（R1-2）：连上就主动推一份设置快照。
   * 之前只在客户端 emit settings:get 时才回，于是「注册按钮该不该灰」
   * 只有在用户展开管理面板之后才知道答案——注册页第一次打开时是亮的。
   * 快照里只有开关和文案，无敏感信息，全量广播没有代价。 */
  socket.emit('settings:snapshot', settings.snapshot());
  socket.on('settings:update', (p) => {
    /* v0.18.0（R6-3）管理权收紧：一旦绑定了管理员（adminUid），系统设置
     * 只允许管理员本人修改 —— 用户要求「针对游戏以及游客还有注册玩家有
     * 绝对的管理权」。
     * v0.32.0（R20 审计 P1-11）修复「未绑定 + 未设环境变量口令 = 任意登录用户可改」。
     *   旧逻辑在 adminUid 为空时只校验 requiresToken()，
     *   而 requiresToken() 依赖 HOMEARENA_ADMIN_TOKEN —— 未设置即「不需要 token」，
     *   于是任意已登录用户都能改注册开关、公告、回合时限。
     *   现在未绑定时一律要求**已注册用户**（游客不行），
     *   与 reqIsAdmin 的口径保持一致。 */
    if (settings.adminUidOf()) {
      if (!socketIsAdmin(socket)) {
        return socket.emit('settings:error', { msg: '仅管理员可修改系统设置', code: 'NOT_ADMIN' });
      }
    } else {
      const token = p && p.adminToken;
      if (settings.requiresToken() && !settings.isAdmin(token)) {
        return socket.emit('settings:error', { msg: '无权限修改系统设置', code: 'NOT_ADMIN' });
      }
      /* 未绑定管理员：要求已注册用户（游客无权改系统设置） */
      if (!settings.requiresToken()) {
        const u = socket.data && socket.data.token && account.resolve(socket.data.token);
        if (!u || !account.users.has(u.uid)) {
          return socket.emit('settings:error', { msg: '仅注册用户可修改系统设置', code: 'NOT_ADMIN' });
        }
      }
    }
    const r = settings.update(p || {});
    if (!r.ok) return socket.emit('settings:error', { msg: r.msg });
    recordAudit(actingUid(), 'settings', '', '修改系统设置：' + Object.keys(p || {}).filter(k => k !== 'adminToken').join(','));
    io.emit('settings:snapshot', r.settings); // 全员广播，前端据此显隐"注册"入口
    socket.emit('settings:ok', r.settings);
  });

  socket.on('account:register', (p) => { const { name, pass } = sd(p, ['name','pass']);
    /* ══════════════════════════════════════════════════════════════════
       v0.10.21  注册开关（用户从 v0.9.0 起就提的「健全账号体系和注册开关」）
       ------------------------------------------------------------------
       四条纪律，缺一条都会踩坑：
         ① 开关**只拦注册**，不拦登录 / 会话恢复 / 游客。关了注册老用户
            必须还能进 —— 这是最常见做错的地方；
         ② 限额按 IP 滑动窗口，防连点误触刷出一堆小号；
         ③ 拒绝时返回 `code: 'REGISTER_CLOSED'`，前端据此显示"关闭原因"
            而不是一句笼统的"操作失败"；
         ④ 关闭时把管理员配置的提示语原样带回，前端直接展示。
       ══════════════════════════════════════════════════════════════════ */
    if (!settings.get().allowRegister) {
      return socket.emit('account:error', {
        msg: settings.get().registerClosedHint || '本厅暂未开放注册',
        code: 'REGISTER_CLOSED',
      });
    }
    const ip = (socket.handshake && (socket.handshake.address || '')) || 'unknown';
    if (!settings.canRegisterFrom(ip)) {
      return socket.emit('account:error', { msg: '注册过于频繁，请稍后再试', code: 'REGISTER_RATE' });
    }
    const r = account.register(name, pass);
    if (!r.ok) return socket.emit('account:error', { msg: r.msg });
    settings.noteRegisterFrom(ip);
    /* v0.18.0（R6-3）：首个注册账号自动成为管理员（幂等，已有管理员则跳过） */
    const becameAdmin = settings.ensureAdmin(r.user.uid);
    const u = account.users.get(r.user.uid);
    bindIdentity(socket, u);
    socket.data.token = r.token;
    socket.emit('account:ok', { user: r.user, token: r.token });
    /* v0.27.0（R15-3）首个注册账号会绑定管理员，必须**当场**把新的
     * settings 快照广播出去。否则客户端手里的 adminUid 仍是空值，
     * 「我的」页不会出现管理中心，要刷新页面才生效 —— 管理权首绑的
     * 体验断点正是从这里来的。 */
    if (becameAdmin) io.emit('settings:snapshot', settings.snapshot());
  });
  socket.on('account:login', (p) => { const { name, pass } = sd(p, ['name','pass']);
    const r = account.login(name, pass);
    if (!r.ok) return socket.emit('account:error', { msg: r.msg });
    const u = account.users.get(r.user.uid);
    bindIdentity(socket, u);
    socket.data.token = r.token;
    socket.emit('account:ok', { user: r.user, token: r.token });
  });
  socket.on('account:guest', (p) => {
    /* v0.34.0（R22-2）：门禁关着时，游客入口直接拒绝。
     * 这一句和上面的 socket.use 是**两道**：中间件拦业务事件，
     * 这里拦"建立游客身份"这个动作本身 —— 否则即使什么都不emit，
     * 用户也会带着一个 g_xxx 的游客身份留在页面里。 */
    if (settings.get().allowGuest === false) {
      socket.emit('account:error', {
        msg: '本厅仅对已注册成员开放，请登录已有账号',
        code: 'GUEST_CLOSED',
      });
      return;
    }
    const { name } = sd(p, ['name']);
    /* 转游客时把原账号的 token 撤销掉，否则本地还留着凭证，
     * 刷新页面又被自动登回原账号 —— 用户会以为「退出不了」。 */
    if (socket.data.token) { try { account.logout(socket.data.token); } catch (e) { } }
    socket.data.token = null;
    const r = account.guest(name);
    bindIdentity(socket, account.guests.get(r.user.uid));
    socket.emit('account:ok', { user: r.user, token: null });
  });
  socket.on('account:logout', () => {
    const oldPid = socket.data.pid;
    /* v0.12.0：优先用 socket 上记的 token（握手时验过的那个），
     * 而不是闭包里的 auth.token —— 后者在「重连后换了 token」时是旧值，
     * 会让真正在用的 token 撤销不掉。 */
    const t = socket.data.token || auth.token;
    if (t) account.logout(t);
    socket.data.token = null;
    socket.data.identity = null;
    socket.data.pid = 'p_' + Math.random().toString(36).slice(2, 10);
    // 退出登录后座位跟着新的匿名身份走，避免掉出房间
    if (oldPid) migratePid(oldPid, socket.data.pid, null);
    socket.emit('account:state', { user: { uid: socket.data.pid, name: '', guest: true, off: true } });
    socket.emit('lobby:stats', { stats: store.publicStatOf(socket.data.pid) });
  });
  socket.on('account:avatar', (p) => { const { avatar, color } = sd(p, ['avatar','color']);
    const uid = socket.data.pid;
    if (!socket.data.identity) return;
    const r = account.setAvatar(uid, avatar, color);
    if (!r.ok) return socket.emit('account:error', { msg: r.msg });
    socket.data.identity.avatar = r.user.avatar;
    socket.data.identity.color = r.user.color;
    socket.emit('account:state', { user: r.user });
    // 同步刷新房间内座位上的形象
    const r2 = findRoom(uid);
    if (r2) { syncSeatProfile(r2); broadcastRoom(r2); }
  });
  socket.on('account:rename', (p) => { const { name } = sd(p, ['name']);
    if (!socket.data.identity) return;
    const r = account.rename(socket.data.pid, name);
    if (!r.ok) return socket.emit('account:error', { msg: r.msg });
    socket.data.identity.name = String(name).trim().slice(0, 16);
    socket.emit('account:state', { user: { uid: socket.data.pid, ...socket.data.identity } });
    const r2 = findRoom(socket.data.pid);
    if (r2) { syncSeatProfile(r2); broadcastRoom(r2); broadcastLobby(); }
  });
  socket.on('account:avatars', () => socket.emit('account:avatars', { avatars: account.AVATARS, colors: account.COLORS }));

  /* ══════════════════════════════════════════════════════════════════════
   * v0.33.0（R21-2）：设备画像采集通道（客户端上报）
   * ---------------------------------------------------------------------
   * 三条事件，职责严格分开：
   *   device:hello  连上后报一次完整档案 → 建档 / 合并画像
   *   device:page   页面切换 → 只加浏览计数，不建会话
   *   device:ping   60s 心跳 → 在线状态 + 时长累加
   *
   * 为什么要拆开：如果每次心跳都带整份档案，每秒都要序列化一次
   * 400 字节的 JSON，家庭 NAS 上完全没必要；而如果只在 hello 时报，
   * 在线状态又会一直停在"刚连上"。拆开后各自只传必要字段。
   * ══════════════════════════════════════════════════════════════════════ */
  function socketIp(sock) {
    try {
      const h = (sock.handshake && sock.handshake.headers) || {};
      const addr = (sock.handshake && sock.handshake.address) || '';
      return analytics.clientIpFromHeaders({ headers: h, socket: { remoteAddress: addr } }, TRUST_PROXY);
    } catch (e) { return ''; }
  }
  /** 取当前 socket 对应的账号名（用于把设备与人对上） */
  function socketName() {
    try {
      const id = socket.data && socket.data.identity;
      return (id && id.name) || '';
    } catch (e) { return ''; }
  }
  function socketUid() {
    try {
      const t = socket.data && socket.data.token;
      const u = t ? account.resolve(t) : null;
      return (u && u.uid) || '';
    } catch (e) { return ''; }
  }

  socket.on('device:hello', (p) => {
    try {
      const b = p || {};
      const did = String(b.did || '').slice(0, 64);
      if (!did) return;
      /* 客户端档案不做"全部信任"也不做"全部拒绝"：
       * 结构过一遍白名单（在 analytics 里），服务端自己的 IP/UA 单独存一层。 */
      analytics.recordVisit({
        did,
        ip: socketIp(socket),
        ua: String((socket.handshake && socket.handshake.headers && socket.handshake.headers['user-agent']) || b.ua || ''),
        headers: (socket.handshake && socket.handshake.headers) || {},
        uid: socketUid(),
        name: socketName(),
        client: b.client || b,
        path: b.path || '/',
        referrer: b.ref || '',
        via: 'socket',
        countPageView: true,
      });
      socket.data.did = did;
    } catch (e) {
      console.error('[device:hello]', e && e.message);
    }
  });

  socket.on('device:page', (p) => {
    try {
      const b = p || {};
      const did = String(b.did || socket.data.did || '').slice(0, 64);
      if (!did) return;
      analytics.pageView(did, b.path || '/', b.ref || '');
    } catch (e) { /* ignore */ }
  });

  socket.on('device:ping', (p) => {
    try {
      const b = p || {};
      const did = String(b.did || socket.data.did || '').slice(0, 64);
      if (!did) return;
      analytics.heartbeat(did, { uid: socketUid() });
      socket.data.did = did;
    } catch (e) { /* ignore */ }
  });


  /* ══════════════════════════════════════════════════════════════════════
   * v0.18.0（R6-3）管理中心：管理员对玩家 / 游客 / 游戏导入的绝对管理权
   * ---------------------------------------------------------------------
   * 鉴权模型（双侧校验，前端显隐只是体验优化，权限永远在服务端判）：
   *   · socketIsAdmin(socket)：socket.data.token → account.resolve →
   *     uid 与 settings.adminUidOf() 比对；
   *   · 游客（g_ 前缀）永远不是管理员；未登录（p_ 匿名）也不是。
   * 管理动作全部走 socket 广播刷新（users 变了要刷新各端管理中心视图）。
   * ══════════════════════════════════════════════════════════════════════ */
  function socketIsAdmin(sock) {
    try {
      const t = sock && sock.data && sock.data.token;
      const u = t ? account.resolve(t) : null;
      if (!u) return false;                    // 未登录 / 游客：永远不是管理员
      /* v0.19.0（R7-2）：未绑定管理员时，与 extAdminGuard 保持一致——
       * 家庭内网可信，任一已登录账号即可管理（含管理中心与游戏导入）。
       * 一旦首个账号注册触发 ensureAdmin 固化 adminUid，即收紧为仅管理员。 */
      if (!settings.adminUidOf()) return true;
      return settings.isAdminUid(u.uid);
    } catch (e) { return false; }
  }
  /* 当前 socket 的操作者 uid：已登录即取其 uid，未登录取 settings.adminUidOf()。
   * 用于审计日志记录「谁」执行了操作（家庭内网未绑定管理员时也能追到真人）。 */
  function actingUid() {
    const u = socket.data && socket.data.token && account.resolve(socket.data.token);
    return (u && u.uid) || settings.adminUidOf() || '';
  }
  /* v0.19.0（R7-2）操作审计日志：记录管理员的关键操作（增删改 / 转让 / 清游客 /
   * 设置变更），随 admin:users 下发最近 N 条，落盘 data/admin-log.json。
   * 家庭厅里「谁动了什么」可追溯，转让管理权、删号不再无据可查。 */
  const ADMIN_LOG_FILE = path.join(process.env.TRIM_PKGVAR || process.env.HOMEARENA_DATA || path.join(__dirname, 'data'), 'admin-log.json');
  let adminLog = [];
  try { const lf = JSON.parse(fsMod.readFileSync(ADMIN_LOG_FILE, 'utf8')); if (Array.isArray(lf)) adminLog = lf; } catch (e) { }
  let adminLogSaveTimer = null;
  function saveAdminLog() {
    if (adminLogSaveTimer) return;
    adminLogSaveTimer = setTimeout(() => {
      adminLogSaveTimer = null;
      try { fsMod.mkdirSync(path.dirname(ADMIN_LOG_FILE), { recursive: true }); fsMod.writeFileSync(ADMIN_LOG_FILE, JSON.stringify(adminLog.slice(-300))); } catch (e) { }
    }, 600);
  }
  function recordAudit(adminUid, action, target, detail) {
    adminLog.push({ t: Date.now(), a: adminUid || '', act: action, uid: target || '', d: detail || '' });
    if (adminLog.length > 600) adminLog = adminLog.slice(-600);
    saveAdminLog();
  }
  function adminPayload() {
    /* v0.20.0（R8-6）管理看板：厅况一览 —— 全部服务端真实聚合，不做任何估算。
     *   humansOnline —— 已注册账号 5 分钟内有活动的人数（与前端在线点同口径）；
     *   rooms        —— 当前内存中的活跃房间摘要（真人/AI 数、局数、私密、底分）。 */
    let humansOnline = 0;
    try { humansOnline = account.adminListUsers().filter(u => (u.lastSeen || 0) > Date.now() - 5 * 60 * 1000).length; } catch (e) { }
    let rooms = [];
    try {
      rooms = [...store.rooms.values()].map(r => ({
        code: r.code, game: r.game, name: r.name || '',
        humans: r.seats.filter(s => s.type === 'human' && s.pid).length,
        ais: r.seats.filter(s => s.type === 'ai').length,
        round: r.round || 1, finished: !!r.finished,
        visibility: r.visibility || 'public', bet: r.bet || 0, createdAt: r.createdAt || 0,
      })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
    } catch (e) { }
    return {
      ok: true,
      adminUid: settings.adminUidOf(),
      users: account.adminListUsers(),
      guests: account.adminListGuests(),
      audit: adminLog.slice(-60).reverse(),
      meUid: (socket.data && socket.data.token && account.resolve(socket.data.token) || {}).uid || null,
      hall: {
        version: VERSION,
        roomsOpen: store.rooms.size,
        humansOnline,
        guestsOnline: account.adminListGuests().length,
        settings: settings.snapshot(),
        rooms,
      },
    };
  }
  /* ══════════════════════════════════════════════════════════════════════
   * v0.33.0（R21-2）：用户画像 / 设备统计后台（仅管理员）
   * ---------------------------------------------------------------------
   * 权限口径与管理中心完全一致：socketIsAdmin()。游客与未登录永远进不来。
   *
   * 「实时」用**订阅推送**而不是前端轮询：
   *   · 前端发 admin:analytics:watch {on:true} → 加入观察者集合；
   *   · 服务端全局每 5 秒算一次 overview，广播给所有观察者；
   *   · 断开/关页面时自动移出，集合为空时定时器什么都不做。
   * 这样 3 个管理员同时看，服务端也只算 1 次，而不是各自轮询 3 次。
   * ══════════════════════════════════════════════════════════════════════ */
  function analyticsGuard() {
    if (!socketIsAdmin(socket)) {
      socket.emit('admin:analytics:error', { msg: '仅管理员可查看用户画像', code: 'NOT_ADMIN' });
      return false;
    }
    return true;
  }

  socket.on('admin:analytics:overview', () => {
    if (!analyticsGuard()) return;
    try {
      socket.emit('admin:analytics:overview', analytics.overview());
    } catch (e) {
      socket.emit('admin:analytics:error', { msg: '统计生成失败：' + (e && e.message) });
    }
  });

  socket.on('admin:analytics:devices', (p) => {
    if (!analyticsGuard()) return;
    try {
      socket.emit('admin:analytics:devices', analytics.listDevices(p || {}));
    } catch (e) {
      socket.emit('admin:analytics:error', { msg: '设备列表读取失败：' + (e && e.message) });
    }
  });

  socket.on('admin:analytics:device', (p) => {
    if (!analyticsGuard()) return;
    const did = p && p.did;
    const d = did ? analytics.deviceDetail(did) : null;
    if (!d) return socket.emit('admin:analytics:error', { msg: '设备不存在或已被清理' });
    socket.emit('admin:analytics:device', d);
  });

  socket.on('admin:analytics:online', () => {
    if (!analyticsGuard()) return;
    socket.emit('admin:analytics:online', { list: analytics.onlineList(90 * 1000), at: Date.now() });
  });

  socket.on('admin:analytics:remove', (p) => {
    if (!analyticsGuard()) return;
    const did = p && p.did;
    if (!did) return socket.emit('admin:analytics:error', { msg: '缺少设备 ID' });
    const ok = analytics.removeDevice(did);
    recordAudit(actingUid(), 'analytics-remove', '', '移除设备记录 ' + String(did).slice(0, 16));
    socket.emit('admin:analytics:ok', { msg: ok ? '设备记录已移除' : '设备不存在', removed: ok ? 1 : 0 });
    socket.emit('admin:analytics:overview', analytics.overview());
  });

  socket.on('admin:analytics:clear', (p) => {
    if (!analyticsGuard()) return;
    /* 清空是破坏性操作：要求显式带 confirm 字符串，避免误点。
     * 这不只是 UX —— 统计一旦清空无法恢复，必须让人"打字确认"而不是"点一下"。 */
    const c = String((p && p.confirm) || '');
    if (c !== '确认清空') {
      return socket.emit('admin:analytics:error', { msg: '请在确认框中输入「确认清空」四个字' });
    }
    const n = analytics.clearAll();
    recordAudit(actingUid(), 'analytics-clear', '', '清空全部统计（' + n + ' 台设备）');
    socket.emit('admin:analytics:ok', { msg: '已清空 ' + n + ' 台设备记录' });
    socket.emit('admin:analytics:overview', analytics.overview());
  });

  socket.on('admin:analytics:export', (p) => {
    if (!analyticsGuard()) return;
    const fmt = String((p && p.fmt) || 'csv');
    try {
      const rows = analytics.exportRows();
      recordAudit(actingUid(), 'analytics-export', '', '导出设备统计 ' + rows.length + ' 条（' + fmt + '）');
      socket.emit('admin:analytics:export', { fmt, rows, at: Date.now() });
    } catch (e) {
      socket.emit('admin:analytics:error', { msg: '导出失败：' + (e && e.message) });
    }
  });

  socket.on('admin:analytics:watch', (p) => {
    if (!analyticsGuard()) return;
    const on = !!(p && p.on);
    if (on) {
      analyticsWatchers.add(socket);
      socket.emit('admin:analytics:overview', analytics.overview());
    } else {
      analyticsWatchers.delete(socket);
    }
  });

  /* 中心管理入口（v0.18.0 R6-3）：玩家列表 + 厅况 + 审计日志。
   * v0.33.0（R21-2）插入画像接口时这块被整段覆盖过一次 —— 属于编辑事故，
   * 已恢复。它和 analytics 是两套数据源，不要合并。 */
  socket.on('admin:list', () => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可用管理中心', code: 'NOT_ADMIN' });
    socket.emit('admin:users', adminPayload());
  });

  socket.on('admin:user:create', (p) => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可添加玩家', code: 'NOT_ADMIN' });
    const { name, pass } = sd(p || {}, ['name']);
    const r = account.adminCreateUser(name, pass);
    if (!r.ok) return socket.emit('admin:error', { msg: r.msg });
    recordAudit(actingUid(), 'create', r.user && r.user.uid, '创建玩家 ' + (r.user && r.user.name));
    io.emit('admin:users', adminPayload());
    socket.emit('admin:ok', { msg: `玩家「${r.user.name}」已创建${p && p.pass ? '' : '，初始密码：' + r.token.slice(0, 0) + (r.user.uid.slice(-4))}` });
  });
  socket.on('admin:user:update', (p) => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可修改玩家', code: 'NOT_ADMIN' });
    const b = p || {};
    if (!b.uid) return socket.emit('admin:error', { msg: '缺少 uid' });
    if (b.name != null) {
      const r = account.adminRename(b.uid, b.name);
      if (!r.ok) return socket.emit('admin:error', { msg: r.msg });
      recordAudit(actingUid(), 'rename', b.uid, '改名 → ' + b.name);
    }
    if (b.pass != null) {
      const r = account.adminResetPass(b.uid, b.pass);
      if (!r.ok) return socket.emit('admin:error', { msg: r.msg });
      recordAudit(actingUid(), 'resetpass', b.uid, '重置密码');
    }
    const ru = findRoom(b.uid);
    if (ru) { syncSeatProfile(ru); broadcastRoom(ru); }
    io.emit('admin:users', adminPayload());
    socket.emit('admin:ok', { msg: '已保存' });
  });
  socket.on('admin:user:delete', (p) => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可删除玩家', code: 'NOT_ADMIN' });
    const b = p || {};
    if (!b.uid) return socket.emit('admin:error', { msg: '缺少 uid' });
    if (b.uid === settings.adminUidOf()) return socket.emit('admin:error', { msg: '不能删除管理员自己（先转让管理员）' });
    const victim = account.users.get(b.uid);
    const r = account.adminDeleteUser(b.uid);
    if (!r.ok) return socket.emit('admin:error', { msg: r.msg });
    recordAudit(actingUid(), 'delete', b.uid, '删除玩家 ' + (victim && victim.name || b.uid));
    io.emit('admin:users', adminPayload());
    socket.emit('admin:ok', { msg: '已删除' });
  });
  socket.on('admin:guests:clear', () => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可清理游客', code: 'NOT_ADMIN' });
    const r = account.adminClearGuests();
    recordAudit(actingUid(), 'clearguests', '', '清理 ' + r.removed + ' 个游客身份');
    io.emit('admin:users', adminPayload());
    socket.emit('admin:ok', { msg: `已清理 ${r.removed} 个游客身份` });
  });
  socket.on('admin:transfer', (p) => {
    if (!socketIsAdmin(socket)) return socket.emit('admin:error', { msg: '仅管理员可转让管理员', code: 'NOT_ADMIN' });
    const uid = p && p.uid;
    if (!uid || !account.users.has(uid)) return socket.emit('admin:error', { msg: '目标不是注册玩家' });
    /* P0-5 修复：管理权变更只走 setAdminUid（正式转让通道）。
     *   通用写入口 settings.update() 已拒绝 adminUid 字段，
     *   避免 settings:update 静默改绑管理员、绕过审计。 */
    const r = settings.setAdminUid(uid);
    recordAudit(actingUid(), 'transfer', uid, '转让管理员');
    io.emit('settings:snapshot', r.settings);
    io.emit('admin:users', adminPayload());
    socket.emit('admin:ok', { msg: '管理员已转让' });
  });

  /* v0.43.0（R32）：断线保座回填只服务「同一页面内的 socket 重连」，且
   * **不覆盖外部游戏房（H5 / Cocos）**。录屏里用户退出 / 杀后台重开后
   * 仍被直接塞回 H5 游戏，就是这条无条件回填 + 90 秒宽限造成的：iframe
   * 里的游戏进度早已随页面销毁，回填只会重新加载一个空壳，毫无恢复价值，
   * 体感却是「退不出去」。现在：
   *   · boot 不同（重开 App）→ store.takeReconnect 直接丢弃记录；
   *   · 目标房是 ext → 丢弃记录并把该 pid 从所有房间清干净，不推 room:state；
   *   · 只有棋牌房 + 同一页面重连，才回原座位。 */
  const rec = store.takeReconnect(socket.data.pid, socket.data.boot);
  const recRoom = rec && store.rooms.get(rec.roomCode);
  if (recRoom && isExt(GAMES[recRoom.game])) {
    leaveAllRooms(socket);          // 清座位 / 空房回收 / 刷新大厅
    store.clearDisconnected(socket.data.pid);
  } else if (rec && recRoom) {
    const r = recRoom;
    if (rec.seat < 0) {
      // 之前是观战者：重新挂回观战席（不占座位）
      if (!r.spectators.includes(socket.data.pid)) r.spectators.push(socket.data.pid);
      socket.join(r.code); socket.data.room = r.code;
      socket.emit('room:state', serializeRoom(r, -1));
      socket.emit('system', { msg: '已重连继续观战' });
      broadcastRoom(r);
    } else if (r.seats[rec.seat] && r.seats[rec.seat].type === 'human' &&
               (!r.seats[rec.seat].pid || r.seats[rec.seat].pid === socket.data.pid)) {
      /* v0.30.0（R18-1）：只允许回到**仍空着**的原座位（或本来就还是自己）。
       * 宽限期内座位被其他人坐下时绝不抢座 —— 旧实现无条件覆盖 pid，
       * 会出现「两个人抢一个座位」的错乱。 */
      r.seats[rec.seat].pid = socket.data.pid;
      socket.join(r.code); socket.data.room = r.code;
      socket.emit('room:state', serializeRoom(r, rec.seat));
      socket.emit('system', { msg: '已重连回原座位' });
      broadcastRoom(r);
      maybeAITurn(r);
    } else if (r.seats[rec.seat] && r.seats[rec.seat].type === 'human') {
      /* 原座位已被他人占用：明确转为观战，绝不静默降级 */
      if (!r.spectators.includes(socket.data.pid)) r.spectators.push(socket.data.pid);
      socket.join(r.code); socket.data.room = r.code;
      socket.emit('room:state', serializeRoom(r, -1));
      socket.emit('system', { msg: '原座位已有人，已转为观战' });
      broadcastRoom(r);
    }
  }

  socket.on('lobby:list', () => socket.emit('lobby:list', { rooms: lobbyList() }));
  // v0.10.7：导入游戏后客户端可主动拉一次最新列表（广播丢失时兜底）
  socket.on('games:reload', () => { reloadExtGames(); socket.emit('games:list', { games: gameList() }); });
  socket.on('lobby:stats', () => socket.emit('lobby:stats', { stats: store.publicStatOf(socket.data.pid) }));
  socket.on('lobby:detail', () => socket.emit('lobby:detail', { detail: store.detailStatOf(socket.data.pid) }));
  /* v0.12.0（R2-3）家庭排行榜：周榜 / 总榜。
   * 纯读操作，不发广播 —— 一次对局结算后客户端自己重拉即可，
   * 全员广播排行榜在大厅人多时会变成无谓的流量。 */
  socket.on('lobby:leaderboard', (p) => {
    const { scope } = sd(p, ['scope']);
    const lb = store.leaderboard(scope);
    lb.me = socket.data.pid || null;
    // 我的名次（可能落在 top50 之外，单独算一遍给前端显示「我的排名」）
    if (socket.data.pid) {
      const all = store.leaderboard(scope);
      const idx = all.rows.findIndex(r => r.pid === socket.data.pid);
      lb.myRank = idx >= 0 ? idx + 1 : null;
      lb.myRow = idx >= 0 ? all.rows[idx] : null;
    }
    socket.emit('lobby:leaderboard', lb);
  });

  socket.on('lobby:quickmatch', (p) => { const { game, aiLevel } = sd(p, ['game','aiLevel']);
    const gid = GAMES[game] ? game : 'gomoku';
    // 优先找有空人类座位的公开房间
    for (const r of store.rooms.values()) {
      if (r.visibility === 'private' || r.game !== gid || r.finished || r.password) continue;
      /* v0.30.0（R18-1）：跳过「没有真人在座」的断线宽限房。
       * 这类房（房主刚断线、座位已腾空）若被快速匹配选中，
       * 满员时会走 joinRoom 的降级分支把用户变成观战者 —— 正是
       * 「点快速开始却进了观战、还退不出去」的来源。直接开新房更干净。 */
      if (!r.seats.some(s => s.type === 'human' && s.pid)) continue;
      const idx = firstEmpty(r.seats);
      if (idx >= 0) { joinRoom(socket, r.code, 'seat', idx, null); return; }
    }
    // 没有就新开一间：自己 + 其余 AI（外部游戏无 AI，全部留人类座位）
    const def = GAMES[gid];
    const seats = Array.from({ length: def.seats }, (_, i) =>
      isExt(def) ? { type: 'human' } : (i === 0 ? { type: 'human' } : { type: 'ai', aiLevel: aiLevel || 'strong' }));
    createRoom(socket, gid, seats, '人机陪练·' + def.label, 'public', null);
  });

  /* v0.28.0（R16-6）建房带玩法 id：新客户端传 modeId，兼容旧字段名 mode */
  socket.on('room:create', (p) => { const { game, seats, name, visibility, password, bet, rules, aiEngine, mode, modeId } = sd(p, ['game','seats','name','visibility','password','bet','rules','aiEngine','mode','modeId']); return createRoom(socket, game, seats, name, visibility, password, bet, rules, aiEngine, modeId || mode); });

  socket.on('room:join', (p) => { const { code, seat, password, via } = sd(p, ['code','seat','password','via']); return joinRoom(socket, String(code || '').toUpperCase(), 'seat', seat, password, { invite: via === 'invite' }); });
  socket.on('room:spectate', (p) => { const { code } = sd(p, ['code']); return joinRoom(socket, String(code || '').toUpperCase(), 'spectator'); });
  socket.on('room:leave', () => {
    /* v0.30.0（R18-1）：主动退出即放弃「断线重连保座」。
     * 否则退出后的宽限记录会在下一次 socket 重连时把用户按旧座位/观战席
     * 拉回房间 —— 观战者表现为「点退出没反应，反复自动进入直至牌局结束」。 */
    try { store.clearDisconnected(socket.data.pid); } catch (e) { }
    /* v0.43.0（R32）：全量退房。旧实现 findRoom() 只清第一间，其余房间
     * 里这个 pid 还占着座位 → lobbyList 判定「有真人」继续展示、sweepRooms
     * 也永不回收 → 「退出房间后房间依然存在，并存多个房间」。
     * 同时把残留的 socket.io 频道全部退掉，否则服务端继续给这条 socket
     * 广播旧房的 room:state，前端 onRoom 又把它渲染回房间 = 「退不出去」。 */
    leaveAllRooms(socket);
    socket.data.room = null;
    socket.emit('room:left', { ok: true });
  });
  /* ══════════════════════════════════════════════════════════════════════
   * v0.17.0（R4-5）快捷短语与牌桌「喊话」
   * ----------------------------------------------------------------------
   * 闲聊 room:chat 的语义保持原样（自由文本、进记录、屏幕上读这句文字）。
   * 新增 `q` 字段只服务**内置趣味短语**：客户端传 `{ text, q:'<短语id>' }`，
   * 服务端用白名单把 id 反查成标准短语落库 —— 这样：
   *   ① 同一句话在各端文字完全一致（不会因为客户端版本不同而漂移）；
   *   ② 客户端可以按 id 配「专属语气」的语音播报；
   *   ③ 用户自定义的句子不接受 q，避免伪造「系统短语」身份。
   * ══════════════════════════════════════════════════════════════════════ */
  socket.on('room:chat', (p) => {
    const { text, q } = sd(p, ['text', 'q']);
    const r = findRoom(socket.data.pid); if (!r) return;
    const entry = { pid: socket.data.pid, text: String(text || '').slice(0, 200), t: Date.now() };
    const qid = typeof q === 'string' ? q : '';
    if (qid && Object.prototype.hasOwnProperty.call(CHAT_PHRASES, qid)) {
      entry.text = CHAT_PHRASES[qid];
      entry.q = qid;
    }
    if (!entry.text) return;
    r.chat.push(entry);
    if (r.chat.length > 120) r.chat = r.chat.slice(-120);   // 防无限增长
    broadcastRoom(r);
  });
  /* ══════════════════════════════════════════════════════════════════════
   * v0.12.0（R3-1）房间语音对讲（对讲机式：按住说话，松手发出）
   * ----------------------------------------------------------------------
   * 为什么走服务端中转而不是 WebRTC P2P：
   *   · 目标设备是 NAS / 内网穿透 / 手机 WebView —— NAT 穿透需要 STUN/TURN，
   *     家庭场景部署不起也管不动；Hub 本来就是唯一的通信中枢，顺路中转最稳。
   *   · 片段是对讲机模型：按住→录一段≤6s→松手→发出→对方播放。
   *     不是连续通话，片段小（一般 <60KB），中转零压力。
   * 服务端只做三件事：验房间、验大小（<150KB）、验节奏（2s 一个，防轰炸），
   * 然后原样转发给同房其他人 —— 不落盘、不入聊天记录、不存储。
   * ══════════════════════════════════════════════════════════════════════ */
  const voiceLast = new Map();          // pid -> ts，2s 限频
  socket.on('voice:clip', (p) => {
    const { code, data } = sd(p, ['code', 'data']);
    const r = findRoom(socket.data.pid); if (!r || r.code !== String(code || '').toUpperCase()) return;
    if (typeof data !== 'string' || data.length > 200000) return;   // 150KB 上限（base64 后）
    if (!/^data:audio\//.test(data)) return;                        // 只收音频 data URL
    const now = Date.now();
    if (now - (voiceLast.get(socket.data.pid) || 0) < 2000) return; // 防轰炸
    voiceLast.set(socket.data.pid, now);
    const seat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    const rm = io.sockets.adapter.rooms.get(r.code); if (!rm) return;
    const payload = { code: r.code, seat: seat >= 0 ? seat : null, data, name: socket.data.name || '', t: now };
    for (const sid of rm) {
      if (sid === socket.id) continue;   // 自己不回放（自己刚说完听得到）
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('voice:clip', payload);
    }
  });
  /* ══════════════════════════════════════════════════════════════════════
   * v0.12.0（R3-2）房间表情互动
   * ----------------------------------------------------------------------
   * 快捷短语解决「说话」，表情解决「情绪」。牌桌上最常用的情绪表达是：
   * 点赞、鼓掌、大笑、大笑到哭、庆祝、上火、无语、加冕。
   * 走独立事件 room:emote 而不是塞进 chat，原因有三：
   *   ① 表情不进聊天记录 —— 刷屏的是情绪，不是信息，记录里只留文字；
   *   ② 客户端按事件做飞入动画，带 seat 定位，不解析文本；
   *   ③ 白名单 + 限频在服务端做 —— 白名单挡住任意字符串注入，
   *      限频挡住「连点表情刷屏」这种最廉价的骚扰。
   * ══════════════════════════════════════════════════════════════════════ */
  /* v0.12.0（R3-2）房间表情互动白名单 */
  const EMOTE_FACE = { thumb: '👍', clap: '👏', laugh: '😂', cry: '😭', party: '🎉', fire: '🔥', speechless: '🙃', crown: '👑' };
  const emoteLast = new Map();          // pid -> ts，1.2s 限频
  socket.on('room:emote', (p) => {
    const { emote } = sd(p, ['emote']);
    const r = findRoom(socket.data.pid); if (!r) return;
    const id = String(emote || '');
    if (!Object.prototype.hasOwnProperty.call(EMOTE_FACE, id)) return;
    const now = Date.now();
    const last = emoteLast.get(socket.data.pid) || 0;
    if (now - last < 1200) return;      // 限频：1.2s 一个，防刷屏
    emoteLast.set(socket.data.pid, now);
    const seat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    /* 房间广播不走 socket.io 命名房间，而是 adapter.rooms.get(裸房号) ——
     * 与 broadcastRoom 同一套约定（见 broadcastRoom 实现），别自创 'room:CODE'。 */
    const rm = io.sockets.adapter.rooms.get(r.code);
    if (!rm) return;
    const payload = {
      code: r.code, seat: seat >= 0 ? seat : null, emote: id,
      face: EMOTE_FACE[id], name: socket.data.name || '', t: now,
    };
    for (const sid of rm) { const s = io.sockets.sockets.get(sid); if (s) s.emit('room:emote', payload); }
  });
  /* v0.10.12：结算后「继续 / 换桌」投票。
   * choice = 'continue' | 'switch'
   * 同一人改票会先撤销旧票（避免既在 yes 又在 no 里）。 */
  socket.on('room:vote', (p) => {
    const { choice } = sd(p, ['choice']);
    const r = findRoom(socket.data.pid); if (!r || !r.vote) return;
    const pid = socket.data.pid;
    if (!pid) return;
    if (Date.now() >= r.vote.deadline) { try { resolveVote(r, null); } catch (e) { } return; }
    r.vote.yes.delete(pid);
    r.vote.no.delete(pid);
    /* v0.10.12：**换桌一票即走**。
     * 投票的意义是「让想走的人能马上走」，不是「拦住想走的人等别人点头」。
     * 所以 switch 投下即刻解散，不再等待其他玩家表态。 */
    if (choice === 'switch') {
      r.vote.no.add(pid);
      try { resolveVote(r, 'switch'); } catch (e) { broadcastRoom(r); }
      return;
    }
    r.vote.yes.add(pid);
    const hs = humansOf(r);
    /* 继续：必须全员同意才开下一局（有人掉线/没表态就等超时，超时按继续算） */
    if (r.vote.yes.size >= hs.length) {
      try { resolveVote(r, null); } catch (e) { broadcastRoom(r); }
    } else {
      broadcastRoom(r);
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
   * v0.17.0（R4-6）主动托管 / 接回
   * ----------------------------------------------------------------------
   * 与超时托管共用 seat.trusted / auto 字段，外加 seat.manual 区分「本人点的」。
   * 广播回执 room:trustee 的 kind 字段告诉前端这是哪一种：
   *   kind='manual'  我点了托管
   *   kind='resume'  我接回了
   *   kind='timeout' 超时被代打（原有路径）
   * 主动托管时不发「第 N 手」这种计时口径的文案，避免语义冲突。
   * ══════════════════════════════════════════════════════════════════════ */
  socket.on('room:trustee', (p) => {
    const { on } = sd(p, ['on']);
    const r = findRoom(socket.data.pid); if (!r) return;
    if (isExt(GAMES[r.game])) return socket.emit('error:msg', { msg: '该游戏不支持托管' });
    const mySeat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    if (mySeat < 0) return socket.emit('error:msg', { msg: '观战状态无法托管' });
    const seat = r.seats[mySeat];
    const want = !!on;
    if (want === !!seat.manual) { broadcastRoom(r); return; }   // 幂等：重复点不重复播报

    seat.manual = want;
    if (want) {
      /* 托管立刻生效：轮到我就直接出（不等计时），没轮到我则后续回合秒出 */
      seat.auto = true;
      seat.trusted = Math.max(seat.trusted || 0, 1);
      io.to(r.code).emit('room:trustee', {
        code: r.code, seat: mySeat, name: seat.name || '玩家', kind: 'manual', manual: true,
      });
      broadcastRoom(r);
      playIfMyTurn(r, mySeat);
      return;
    }
    /* 接回：清掉托管标记，重新计时（不因为之前托管过而只剩 5 秒） */
    seat.auto = false;
    seat.trusted = 0;
    delete seat.trustedAt;
    io.to(r.code).emit('room:trustee', {
      code: r.code, seat: mySeat, name: seat.name || '玩家', kind: 'resume', manual: false,
    });
    try { armTurnTimer(r); } catch (e) { }
    broadcastRoom(r);
  });

  /* v0.10.12：房主/任何人想直接续局（跳过投票，用于单人 + AI 场景） */  socket.on('room:rematch', () => {
    const r = findRoom(socket.data.pid); if (!r) return;
    if (isExt(GAMES[r.game])) return;
    if (!r.finished) return;
    /* 只要有一个人按「再来一局」且房内真人已全部同意（或只有一人），立即开 */
    const hs = humansOf(r);
    if (hs.length <= 1) { startNextRound(r); broadcastRoom(r); broadcastLobby(); return; }
    if (!r.vote) openVote(r);
    r.vote.yes.add(socket.data.pid);
    if (r.vote.yes.size >= hs.length) { startNextRound(r); broadcastRoom(r); broadcastLobby(); }
    else broadcastRoom(r);
  });

  /* ══════════════════════════════════════════════════════════════════════
   * v0.12.0（R2-1）牌谱：当前房间 / 历史列表 / 单局读取
   * ----------------------------------------------------------------------
   * 旧实现只回 { moves: raw[], winner }，前端拿它渲染一排 JSON ——
   * 「牌谱复盘与导出」等于没做。现在走 replay.js：
   *   · room:replay       → 当前房间的结构化牌谱（含逐手可读文本）
   *   · replay:list       → 我最近的对局牌谱列表（退出房间也能翻）
   *   · replay:open       → 按 id 取某一局完整牌谱
   *   · replay:export     → 按 fmt 生成 { name, mime, data } 供前端直接下载
   * ══════════════════════════════════════════════════════════════════════ */
  socket.on('room:replay', () => {
    const r = findRoom(socket.data.pid); if (!r) return;
    const rp = replayLib.buildReplay(r, (GAMES[r.game] && GAMES[r.game].label) || r.game);
    socket.emit('replay', rp);
  });
  socket.on('replay:list', () => {
    socket.emit('replay:list', { items: store.listReplays(socket.data.pid), keep: store.REPLAY_KEEP });
  });
  /* ══════════════════════════════════════════════════════════════════════
   * v0.17.0（R4-7）点座位 → 看牌友档案 / 改自己昵称
   * ----------------------------------------------------------------------
   * 座位上只放得下三行信息（头像、名字、牌数+段位），想看「这人到底什么水平」
   * 就得点开。profile:get 返回该座位在该游戏维度的真实统计；改名走同一个
   * 通道（profile:name），复用 account 的校验与落盘。
   * 安全：profile:get 只读、只回白名单字段，绝不回 pid / 密码 / 原始分数。
   * ══════════════════════════════════════════════════════════════════════ */
  socket.on('profile:get', (p) => {
    const { seat } = sd(p, ['seat']);
    const r = findRoom(socket.data.pid); if (!r) return;
    const i = Number(seat);
    const s = (i >= 0 && i < r.seats.length) ? r.seats[i] : null;
    if (!s) return;
    const out = {
      seat: i, game: r.game, name: s.name || '', type: s.type,
      avatar: s.avatar || null, color: s.color || null,
      aiLevel: s.aiLevel || null, pts: 0, mine: s.pid === socket.data.pid,
      /* v0.20.0（R8-4）：档案卡带管理员标识 —— 身份一目了然 */
      isAdmin: !!(s.pid && settings.isAdminUid(s.pid)),
    };
    try {
      const st0 = (r.roomStats && r.roomStats.seats || [])[i];
      out.pts = st0 ? (st0.points || 0) : 0;
      const rs = (r.roomStats && r.roomStats.seats || [])[i];
      if (rs) Object.assign(out, { rGames: rs.games || 0, rWins: rs.wins || 0, rDraws: rs.draws || 0 });
    } catch (e) { }
    if (s.type === 'human' && s.pid) {
      try {
        const pr = store.getProfile(s.pid);
        if (pr) {
          const gv = (pr.byGame && pr.byGame[r.game]) || null;
          out.games = pr.games; out.wins = pr.wins; out.draws = pr.draws;
          out.tier = pr.tier ? pr.tier.name : '定级中';
          if (gv) {
            out.gGames = gv.games || 0;
            out.gTier = rating.tierOf(gv.everRated ? gv.rating : 1000, gv.games || 0).name;
            out.gWinRate = gv.games ? Math.round(((gv.wins || 0) / gv.games) * 100) : 0;
          }
        }
      } catch (e) { }
    }
    socket.emit('profile:data', out);
  });
  socket.on('profile:name', (p) => {
    const { name } = sd(p, ['name']);
    const r = findRoom(socket.data.pid); if (!r) return;
    const res = account.rename(socket.data.pid, String(name || ''));
    if (!res || !res.ok) return socket.emit('error:msg', { msg: (res && res.msg) || '改名失败' });
    const mySeat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    if (mySeat >= 0) r.seats[mySeat].name = String(name).trim().slice(0, 16);
    if (socket.data.identity) socket.data.identity.name = r.seats[mySeat] ? r.seats[mySeat].name : socket.data.identity.name;
    socket.emit('profile:renamed', { name: r.seats[mySeat] ? r.seats[mySeat].name : name });
    broadcastRoom(r); broadcastLobby();
  });
  socket.on('replay:open', (p) => {
    const { id, code, round } = sd(p, ['id', 'code', 'round']);
    let rp = id ? store.getReplay(socket.data.pid, id) : null;
    /* 没存过（比如看的是别人刚打完的房）→ 若还当前房间就直接现算 */
    if (!rp) {
      const r = findRoom(socket.data.pid);
      if (r && (!code || r.code === code)) rp = replayLib.buildReplay(r, (GAMES[r.game] && GAMES[r.game].label) || r.game);
    }
    if (!rp) return socket.emit('error:msg', { msg: '牌谱不存在或已过期' });
    socket.emit('replay', rp);
  });
  socket.on('replay:export', (p) => {
    const { id, code, round, fmt } = sd(p, ['id', 'code', 'round', 'fmt']);
    let rp = id ? store.getReplay(socket.data.pid, id) : null;
    if (!rp) {
      const r = findRoom(socket.data.pid);
      if (r) rp = replayLib.buildReplay(r, (GAMES[r.game] && GAMES[r.game].label) || r.game);
    }
    if (!rp) return socket.emit('error:msg', { msg: '没有可导出的牌谱' });
    const stamp = new Date(rp.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '');
    const base = `HomeArena-${rp.gameLabel}-${rp.code}-${stamp}`;
    if (fmt === 'txt') {
      socket.emit('replay:file', { name: base + '.txt', mime: 'text/plain;charset=utf-8', data: replayLib.toText(rp) });
    } else {
      socket.emit('replay:file', { name: base + '.json', mime: 'application/json', data: JSON.stringify(rp, null, 2) });
    }
  });

  socket.on('game:advice', async () => {
    const r = findRoom(socket.data.pid); if (!r) return;
    const seat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    if (seat < 0) return socket.emit('advice', { advice: null });
    if (r.state.winner != null || r.state.draw) return socket.emit('advice', { advice: { text: '对局已结束' } });
    let raw = null;
    try {
      /* v0.20.0（R8-2）：智囊建议尊重房间引擎开关 —— 「内置引擎」直接走启发式
       * （不再探测 DouZero）；「DouZero 增强」先试 NN，失败落启发式。 */
      if (r.game === 'doudizhu') raw = (r.aiEngine === 'douzero') ? await dz.suggest('doudizhu', r.state, seat) : null;
      else raw = await GAMES[r.game].ai(r.state, seat + 1, 'super');
    } catch (e) { raw = null; }
    // 降级：DouZero 未部署 / 超人级无服务时，用内置启发式补一个建议。
    // 否则智囊对普通用户永远是「暂无可参考的走法」，等于功能不可用。
    if (!raw) {
      try {
        if (r.game === 'doudizhu') raw = await doudizhu.ai(r.state, seat + 1, 'hard');
        else raw = await GAMES[r.game].ai(r.state, seat + 1, 'hard');
      } catch (e) { raw = null; }
    }
    const advice = normalizeAdvice(r, raw, seat);
    socket.emit('advice', { advice });
  });

  // ── 智能出牌提示（第二波 M2）────────────────────────────────────────
  // 与 game:advice 的区别：advice 是「智囊」给一个最优解；
  // hint 给「所有可选项」，前端连点循环切换，由玩家自己决策。
  // 返回 { plays:[{cards:[id], type, label, text, wholeHand}], prevText, handSummary }
  // 注意：socket.io 客户端不传 payload 时形参可能是 null（不是 undefined），
  // 用 `({index} = {})` 会抛 TypeError 并让整个进程退出。必须显式兜底。
  socket.on('game:hint', async (payload) => {
    const index = payload && Number.isInteger(payload.index) ? payload.index : 0;
    try {
    const r = findRoom(socket.data.pid); if (!r) return;
    const seat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    if (seat < 0) return socket.emit('hint', { plays: [], text: '旁观者无法提示' });
    if (r.state.winner != null || r.state.draw) return socket.emit('hint', { plays: [], text: '对局已结束' });

    // v0.10.15：候选面板扩展到斗地主/掼蛋；双升/麻将规则差异大，先给 AI「推荐一手」
    // （单候选会被前端自动选中，不弹面板；后续波次再补完整候选枚举）
    if (r.state.phase && r.state.phase !== 'playing') {
      return socket.emit('hint', { plays: [], text: '叫分阶段无需提示' });
    }
    if (r.state.current != null && r.state.current !== seat) {
      return socket.emit('hint', { plays: [], text: '还没轮到你出牌' });
    }

    const hand = r.state.hands[seat] || [];
    const isLead = r.state.leadBy === seat || !r.state.lastPlay;
    const prevCombo = isLead ? null : (r.state.lastPlay && r.state.lastPlay.combo) || null;
    const prevText = prevCombo ? hint.describe(r.state.lastPlay.cards) : '';

    let plays = [];
    const g = r.game;
    try {
      if (g === 'doudizhu') {
        const raw = hint.suggestPlays(hand, prevCombo, { limit: 6 });
        plays = raw.map(p => ({ cards: p.cards.map(c => c.id), type: p.type, label: p.label, text: p.text, wholeHand: !!p.wholeHand }));
      } else if (g === 'guandan') {
        plays = GAMES.guandan.hintPlays(hand, r.state, seat) || [];
      } else if (g === 'shengji' || g === 'mahjong') {
        const mv = await GAMES[g].ai(r.state, seat + 1, 'hard');
        if (mv && mv.type === 'play' && mv.cards && mv.cards.length) {
          plays = [{ cards: mv.cards, type: mv.type, label: '推荐', text: 'AI 推荐的一手', wholeHand: mv.cards.length === hand.length }];
        }
      }
    } catch (e) {
      return socket.emit('hint', { plays: [], text: '提示计算失败' });
    }

    const reply = {
      plays,
      prevText,
      isLead,
      handSummary: (g === 'doudizhu') ? hint.handSummary(hand) : '',
      index,
    };
    if (!reply.plays.length) reply.text = prevText ? '没有能压过的牌，建议过牌' : '无牌可出';
    socket.emit('hint', reply);
    } catch (e) {
      // 提示是辅助功能，任何异常都不该打断牌局或拖垮进程
      console.error('[game:hint]', e && e.message);
      try { socket.emit('hint', { plays: [], text: '提示计算失败' }); } catch (_) { }
    }
  });

  socket.on('game:move', (p) => {
    const { move: rawMove } = sd(p, ['move']);
    // 各游戏 applyMove 会直接解构 move（如 const {x,y}=move），
    // 非法/空载荷必须先挡在分发层，否则异常会冒泡终止进程。
    const move = (rawMove && typeof rawMove === 'object') ? rawMove : null;
    if (!move) return socket.emit('error:msg', { msg: '非法操作' });
    const r = findRoom(socket.data.pid); if (!r) return;
    const mySeat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    if (mySeat < 0) return socket.emit('error:msg', { msg: '你不在座位上' });
    // 外部游戏（h5/cocos 插件）：不走原生引擎，move 原样组播给房内其他成员，
    // 由游戏自身的联机协议决定怎么消费（权威端模拟 / 状态同步等）
    if (isExt(GAMES[r.game])) {
      /* v0.10.13：外部游戏结算回传。
       * 之前 recordGame 只认原生 state.winner / state.draw，
       * 外部游戏的 state 恒为 { ext:true, v:1 } —— 于是「本房战绩」永远是 0 局
       * （用户截图里的「本房 0 局、积分全 0」就是这个原因）。
       * 现在游戏包在分出胜负后发 { __result: { winners:[座位号...], draw?, detail? } }，
       * 通过这里写入战绩与房间记分板。服务端做**白名单校验**，不信任包的任意字段。 */
      if (rawMove && rawMove.__result) {
        const pay = rawMove.__result || {};
        const seats = Array.isArray(pay.winners)
          ? pay.winners.filter(i => Number.isInteger(i) && i >= 0 && i < r.seats.length)
          : [];
        const draw = !!pay.draw;
        if (!draw && !seats.length) return socket.emit('error:msg', { msg: '结算数据缺少赢家座位' });
        try {
          recordExtResult(r, { winners: seats, draw, detail: pay.detail });
        } catch (e) { /* 结算失败不影响对局 */ }
        return;
      }
      if (rawMove && rawMove.__peer) {
        // 游戏经桥发的任意透传消息（非走子）
        socket.to(r.code).emit('ext:msg', { from: mySeat, data: rawMove.data });
      } else {
        socket.to(r.code).emit('ext:msg', { from: mySeat, data: { __move: move } });
      }
      return;
    }
    if (r.state.winner != null || r.state.draw) return;
    if (mySeat !== r.state.current) return;
    // 引擎兜底：任何游戏 applyMove 抛异常都只回一条错误，绝不终止进程
    let res;
    try {
      res = GAMES[r.game].apply(r.state, move, mySeat + 1);
    } catch (e) {
      console.error('[game:move]', r.game, e && e.message);
      return socket.emit('error:msg', { msg: '出牌失败，请重试' });
    }
    if (!res || !res.ok) { socket.emit('error:msg', { msg: (res && res.reason) || 'illegal' }); return; }
    /* v0.13.0（S4）本人真的操作了 → 立刻收回托管状态。
     * 旧版**从来没在这里清过** trusted：只要超时一次，整局头像旁都挂着
     * 「托管」红标，哪怕之后每一手都是自己在打（截图里正是如此）。
     * 现在「托管中」只表示**当前确实无人操作**，人一回来就消失。 */
    if (r.seats[mySeat]) { r.seats[mySeat].trusted = 0; r.seats[mySeat].auto = !!r.seats[mySeat].manual; }
    try {
      const act = actionFromMove(r.game, move, mySeat, r.state);
      if (act) io.to(r.code).emit('table:action', act);
    } catch (e) { /* 播报失败不影响对局 */ }
    afterMove(r, res.next);
  });

  // 外部游戏双向透传通道：游戏面板里的聊天/表情/同步等任意消息
  socket.on('ext:msg', (p) => {
    const r = findRoom(socket.data.pid); if (!r) return;
    if (!isExt(GAMES[r.game])) return;
    const mySeat = r.seats.findIndex(s => s.type === 'human' && s.pid === socket.data.pid);
    const data = (p && typeof p === 'object') ? p.data : null;
    if (data == null) return;
    // 组播给房内其他人（含观战者），字节数限制防滥用
    socket.to(r.code).emit('ext:msg', { from: mySeat, data });
  });

  /* ── v0.23.0（R11-2）同房比分赛三事件 ────────────────────────────── */
  socket.on('match:config', (p) => {
    const r = findRoom(socket.data.pid); if (!r) return;
    if (!isExt(GAMES[r.game])) return socket.emit('error:msg', { msg: '仅外部游戏房支持比分赛' });
    if (!r.seats.some(s => s.type === 'human' && s.pid === socket.data.pid)) return;
    const t = Math.max(1, Math.min(20, Math.round(Number(p && p.rounds) || 3)));
    const m = matchEnsure(r);
    m.target = t; m.done = false; m.champion = null;
    broadcastRoom(r);
  });
  socket.on('match:score', (p) => {
    const r = findRoom(socket.data.pid); if (!r) return;
    if (!isExt(GAMES[r.game])) return;
    const seat = r.seats.find(s => s.type === 'human' && s.pid === socket.data.pid);
    if (!seat) return socket.emit('error:msg', { msg: '你不在座位上' });
    const n = Math.round(Number(p && p.score));
    if (!Number.isFinite(n) || n < 0 || n > 1000000) return socket.emit('error:msg', { msg: '分数需为 0~1000000 的整数' });
    const m = matchEnsure(r);
    if (m.done) return socket.emit('error:msg', { msg: '本场比分赛已收官，重置后可再战' });
    const row = m.scores[socket.data.pid] || (m.scores[socket.data.pid] = { name: seat.name, rounds: [], total: 0 });
    row.name = seat.name;
    row.rounds.push({ n, ts: Date.now() });
    row.total += n;
    /* 全员达标 → 收官：总分最高者夺冠（同分取先到者） */
    const hs = humansOf(r);
    if (hs.length && hs.every(s => m.scores[s.pid] && m.scores[s.pid].rounds.length >= m.target)) {
      m.done = true;
      let best = null;
      for (const s of hs) {
        if (!best || m.scores[s.pid].total > m.scores[best].total) best = s.pid;
      }
      m.champion = best;
      const cname = (m.scores[best] && m.scores[best].name) || '';
      io.to(r.code).emit('table:action', { seat: null, text: `比分赛收官 · ${cname} 以 ${m.scores[best].total} 分夺冠` });
    }
    broadcastRoom(r);
  });
  socket.on('match:reset', () => {
    const r = findRoom(socket.data.pid); if (!r) return;
    if (!isExt(GAMES[r.game]) || !r.match) return;
    if (!r.seats.some(s => s.type === 'human' && s.pid === socket.data.pid)) return;
    r.match.scores = {}; r.match.done = false; r.match.champion = null;
    broadcastRoom(r);
  });

  socket.on('disconnect', () => {
    /* v0.33.0（R21-2）：先摘掉画像观察者。
     * 必须放在 `if (!pid) return` **之前** —— 游客/未登录连接同样可能
     * 订阅过（未绑定管理员时任一登录账号可看），若在 return 之后就漏了，
     * 集合会越积越大，5 秒定时器每次都要给一堆死 socket 发消息。 */
    try { analyticsWatchers.delete(socket); } catch (e) { /* ignore */ }
    const pid = socket.data.pid;
    if (!pid) return;
    /* v0.30.0（R18-1）重连竞态防护（本轮核心修复）：
     * socket.io 断线重连会新建 socket，旧 socket 的 disconnect 事件可能
     * **晚于**新 socket 的 takeReconnect 到达。旧实现不做任何校验就清座位，
     * 于是刚恢复的座位被再清一次 → seatOfSocket 变 -1 → 客户端把本人
     * 当观战者（「开局途中无故退出、自动以观战视角进入」）。
     * 同一 pid 只要还有活跃连接，就绝不触碰座位/观战席。 */
    let alive = false;
    try {
      for (const s of io.sockets.sockets.values()) {
        if (s.id !== socket.id && s.connected && s.data && s.data.pid === pid) { alive = true; break; }
      }
    } catch (e) { /* 遍历失败按无活跃连接处理（保守清理） */ }
    if (alive) return;
    /* v0.43.0（R32）：断线也按「一人一房」全量处理。旧版 findRoom() 只看
     * 第一间，其余房间的座位一直挂着这个 pid → 大厅里一排「幽灵房」。
     * 另外：外部游戏房（H5 / Cocos）**不写保座**。iframe 里的进度随页面
     * 销毁，重连回填只会重新加载空壳，正是「杀后台重开还在游戏里」的根因。 */
    const mine = roomsOfPid(pid);
    let keptSeat = false;
    for (const r of mine) {
      const idx = r.seats.findIndex(s => s.type === 'human' && s.pid === pid);
      const wasSpectator = idx < 0 && r.spectators.includes(pid);
      const ext = isExt(GAMES[r.game]);
      if (!ext && !keptSeat && (idx >= 0 || wasSpectator) && socket.data.boot) {
        // 棋牌房：同一页面内重连（boot 校验在 takeReconnect）才保座
        store.markDisconnected(pid, r.code, idx >= 0 ? idx : -1, socket.data.boot);
        keptSeat = true;
      }
      if (idx >= 0) r.seats[idx].pid = null;
      r.spectators = r.spectators.filter(p => p !== pid);
      try { socket.leave(r.code); } catch (e) { }
      const humans = r.seats.filter(x => x.type === 'human' && x.pid);
      if (!humans.length && !r.spectators.length && ext) {
        // ext 房无人即回收，不留到下次启动
        clearTurnTimer(r.code);
        store.rooms.delete(r.code);
        try { io.in(r.code).socketsLeave(r.code); } catch (e) { }
      } else {
        /* v0.12.0（R2-4）：断线后该座位变成「空位」，计时应立刻作废，
         * 由 maybeAITurn 以 fun 档代打。宽限期内重连（takeReconnect）再恢复。 */
        try { clearTurnTimer(r.code); r.turnDeadline = null; maybeAITurn(r); } catch (e) { }
        broadcastRoom(r);
      }
    }
    if (mine.length) broadcastLobby();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * v0.28.0（R16-6）区域特色玩法预设（服务端权威）
 * --------------------------------------------------------------------------
 * 用户要求「建房初期可选区域规则，房号后体现玩法名」。
 * 原则：**每个玩法都必须真实改变引擎行为**，不做只有标签的假玩法。
 *   · 斗地主：湖北叫分经典 / 快枪封顶 ×16 / 江浙高分封顶 ×64
 *   · 麻将  ：通用推倒胡 / 四川缺一门（胡牌时最多两门花色）
 *   · 五子棋：15 / 13 / 9 路
 *   · 围棋  ：中国 19 路贴 7.5 / 日韩 19 路贴 6.5 / 13 路 / 9 路
 *   · 象棋·国象：45 秒标准 / 20 秒快棋
 *   · 掼蛋·双升：2 起打 / 10 起打
 *   · 德州  ：1000 / 5000 / 500 筹码
 * mode 在服务端按白名单取预设，**忽略客户端传的具体数值** —— 防止手改报文
 * 造出「贴目 -100」这类非法房间。
 * ══════════════════════════════════════════════════════════════════════════ */
const MODES = {
  doudizhu: [
    { id: 'classic', name: '经典叫分', short: '经典', tag: '湖北', desc: '3 人标准叫分，倍数不封顶', rules: { multiplierCap: 0 } },
    { id: 'rapid', name: '快枪局', short: '快枪', tag: '湖北', desc: '倍数封顶 ×16，一局更快', rules: { multiplierCap: 16 } },
    { id: 'high', name: '高分场', short: '高分', tag: '江浙', desc: '倍数封顶 ×64，敢叫敢炸', rules: { multiplierCap: 64 } },
  ],
  mahjong: [
    { id: 'classic', name: '推倒胡', short: '推倒胡', tag: '通用', desc: '只认基本胡型，自摸/点炮均可', rules: { variant: 'classic' } },
    { id: 'sichuan', name: '缺一门', short: '川麻', tag: '四川', desc: '胡牌时手牌与副露最多两门花色', rules: { variant: 'sichuan' } },
  ],
  gomoku: [
    { id: 'std15', name: '标准 15 路', short: '15路', tag: '标准', desc: '15×15，五连即胜', rules: { boardSize: 15 } },
    { id: 'quick13', name: '快棋 13 路', short: '13路', tag: '快棋', desc: '13×13，更快进入中盘', rules: { boardSize: 13 } },
    { id: 'mini9', name: '入门 9 路', short: '9路', tag: '入门', desc: '9×9，适合新手与短局', rules: { boardSize: 9 } },
  ],
  go: [
    { id: 'cn19', name: '中国规则', short: '中国', tag: '19 路 · 贴 7.5 目', desc: '标准 19 路，中国数子，黑贴 7.5 目', rules: { boardSize: 19, komi: 7.5 } },
    { id: 'jp19', name: '日韩规则', short: '日韩', tag: '19 路 · 贴 6.5 目', desc: '标准 19 路，黑贴 6.5 目', rules: { boardSize: 19, komi: 6.5 } },
    { id: 'quick13', name: '快棋 13 路', short: '13路', tag: '快棋 · 贴 6.5 目', desc: '13 路，适合十分钟一局', rules: { boardSize: 13, komi: 6.5 } },
    { id: 'mini9', name: '入门 9 路', short: '9路', tag: '入门 · 贴 5.5 目', desc: '9 路，新手先学死活与收官', rules: { boardSize: 9, komi: 5.5 } },
  ],
  chess: [
    { id: 'std', name: '标准棋', short: '标准', tag: '45 秒/步', desc: '标准国际象棋，每步 45 秒', rules: { turnMs: 45000 } },
    { id: 'blitz', name: '快棋', short: '快棋', tag: '20 秒/步', desc: '每步 20 秒，超时由 AI 代走', rules: { turnMs: 20000 } },
  ],
  xiangqi: [
    { id: 'std', name: '标准棋', short: '标准', tag: '45 秒/步', desc: '标准中国象棋，每步 45 秒', rules: { turnMs: 45000 } },
    { id: 'blitz', name: '快棋', short: '快棋', tag: '20 秒/步', desc: '每步 20 秒，超时由 AI 代走', rules: { turnMs: 20000 } },
  ],
  guandan: [
    { id: 'std', name: '经典掼蛋', short: '经典', tag: '2 起打', desc: '从 2 打起，双上 +2 级', rules: { startLevel: 2 } },
    { id: 'rush', name: '冲关', short: '冲关', tag: '10 起打', desc: '从 10 打起，一局定胜负', rules: { startLevel: 10 } },
  ],
  shengji: [
    { id: 'std', name: '经典双升', short: '经典', tag: '2 起打', desc: '从 2 打起，80 分过庄', rules: { startLevel: 2 } },
    { id: 'rush', name: '冲关', short: '冲关', tag: '10 起打', desc: '从 10 打起，快节奏', rules: { startLevel: 10 } },
  ],
  texas: [
    { id: 'std', name: '标准桌', short: '标准', tag: '1000 筹码', desc: '1000 起始筹码，小盲 10 / 大盲 20', rules: { startingChips: 1000 } },
    { id: 'deep', name: '深筹桌', short: '深筹', tag: '5000 筹码', desc: '5000 起始筹码，适合慢打', rules: { startingChips: 5000 } },
    { id: 'short', name: '短筹桌', short: '短筹', tag: '500 筹码', desc: '500 起始筹码，推推乐节奏', rules: { startingChips: 500 } },
  ],
  reversi: [
    { id: 'std', name: '标准 8×8', short: '标准', tag: '经典', desc: '8×8 标准黑白棋', rules: {} },
  ],
  connect4: [
    { id: 'std', name: '标准 7×6', short: '标准', tag: '经典', desc: '7 列 × 6 行，四连即胜', rules: {} },
  ],
};

const RULE_SCHEMAS = {
  gomoku: (x) => ({ boardSize: [9, 13, 15].indexOf(+x.boardSize) >= 0 ? +x.boardSize : 15 }),
  go: (x) => ({
    boardSize: [9, 13, 19].indexOf(+x.boardSize) >= 0 ? +x.boardSize : 19,
    komi: [5.5, 6.5, 7.5].indexOf(+x.komi) >= 0 ? +x.komi : 7.5,
  }),
  texas: (x) => ({ startingChips: Number.isFinite(+x.startingChips) ? Math.min(100000, Math.max(200, Math.round(+x.startingChips))) : 1000 }),
  doudizhu: (x) => ({ multiplierCap: [16, 32, 64].indexOf(+x.multiplierCap) >= 0 ? +x.multiplierCap : 0 }),
  mahjong: (x) => ({ variant: x.variant === 'sichuan' ? 'sichuan' : 'classic' }),
  guandan: (x) => ({ startLevel: [2, 5, 10].indexOf(+x.startLevel) >= 0 ? +x.startLevel : 2 }),
  shengji: (x) => ({ startLevel: [2, 5, 10].indexOf(+x.startLevel) >= 0 ? +x.startLevel : 2 }),
  chess: (x) => ({ turnMs: [20000, 45000].indexOf(+x.turnMs) >= 0 ? +x.turnMs : 45000 }),
  xiangqi: (x) => ({ turnMs: [20000, 45000].indexOf(+x.turnMs) >= 0 ? +x.turnMs : 45000 }),
};
function sanitizeRules(game, x) { return RULE_SCHEMAS[game] ? RULE_SCHEMAS[game](x || {}) : null; }
function modeOf(game, id) {
  const list = MODES[game] || [];
  if (!list.length) return null;
  return list.filter(m => m.id === id)[0] || null;
}
function modeInfoOf(m) { return m ? { id: m.id, name: m.name, short: m.short, tag: m.tag, desc: m.desc } : null; }

function createRoom(socket, game, seats, name, visibility, password, bet, rules, aiEngine, modeId) {
  const def = GAMES[game]; if (!def) return socket.emit('error:msg', { msg: '未知游戏' });
  /* v0.43.0（R32）一人一房：建房前先把旧房全部退干净。
   * 旧版直接新建，用户在大厅连点几次「开桌」就挂出好几间房，
   * 每间的 seats 里都是同一个 pid，退出时又只清得掉一间。 */
  leaveAllRooms(socket);
  try { store.clearDisconnected(socket.data.pid); } catch (e) { }
  const code = genCode();
  /* 玩法：优先按 mode 取预设；旧客户端只传 rules 时按参数反查最接近的玩法，
   * 保证升级服务端后旧客户端仍能建房。 */
  let modeObj = modeId ? modeOf(game, modeId) : null;
  if (!modeObj) {
    const list = MODES[game] || [];
    const want = JSON.stringify(sanitizeRules(game, rules || {}));
    modeObj = list.filter(m => JSON.stringify(sanitizeRules(game, m.rules)) === want)[0] || list[0] || null;
  }
  const cleanRules = modeObj ? sanitizeRules(game, modeObj.rules) : null;
  const modeInfo = modeInfoOf(modeObj);
  const seatArr = (seats && seats.length ? seats : Array.from({ length: def.seats }, () => ({ type: 'human' }))).map((s, si) => {
    if (s.type === 'ai') {
      const lv = s.aiLevel || 'fun';
      const av = ROBOT_AVATARS[Math.floor(Math.random() * ROBOT_AVATARS.length)];
      /* v0.10.20：原来每个难度只有一个固定名字（strong 恒为「小强」），
         一桌两个 strong 就会重名，座位条上完全分不清谁是谁。
         改成名字池 + 座位号取模错开：同桌三座必然是三个不同名字。 */
      const pool = AI_NAME_POOL[lv] || AI_NAME_POOL.fun;
      return { type: 'ai', name: pool[si % pool.length], aiLevel: lv, pid: null, avatar: av, color: '#7c8aa5' };
    }
    return { type: 'human', name: null, pid: null, avatar: null, color: null };
  });
  /* v0.10.13 彩头：只对牌类/麻将生效，棋类忽略（棋类没有「多局累加赌注」概念）。
   * 服务端做上下限夹取，不信任客户端 —— 手改报文也不至于出现 1e9 的离谱分数。 */
  const BET_GAMES = { doudizhu: 1, guandan: 1, shengji: 1, texas: 1, mahjong: 1 };
  let betVal = 0;
  if (BET_GAMES[game]) {
    const n = Math.round(Number(bet));
    betVal = Number.isFinite(n) ? Math.min(10000, Math.max(1, n)) : 0;
  }
  const room = {
    code, game, name: name || def.label,
    visibility: visibility === 'private' ? 'private' : 'public',
    password: password ? String(password) : null,
    bet: betVal,
    rules: cleanRules,
    /* v0.28.0（R16-6）：玩法随房间走，续局/复盘重建 state 时一并带回 */
    mode: modeInfo,
    /* v0.20.0（R8-2）AI 引擎开关（房间属性，创建时定）：
     *   builtin —— 内置启发式（默认，零外部依赖、行为确定）；
     *   douzero —— 超人档优先走 DouZero 神经网络，服务不可达自动降级内置。
     * 只对斗地主的超人档实际生效（唯一接入 NN 的游戏）。 */
    aiEngine: aiEngine === 'douzero' ? 'douzero' : 'builtin',
    seats: seatArr, state: def.state ? def.state(cleanRules) : { ext: true, v: 1 }, spectators: [], chat: [], createdAt: Date.now(),
    finished: false, recorded: false,
    /* v0.10.12：桌局生命周期。
     * 一局结束后不再只能「退出房间」——房内玩家可以投票决定
     *   continue：原班人马再来一局（重置 state，保留座位与记分）
     *   switch  ：换桌（解散本房，各自回大厅）
     * vote = { after: 已结束局号, yes:Set<pid>, no:Set<pid>, deadline }，不落盘。 */
    round: 1,
    vote: null,
    /* v0.10.11：本房间记分板（下半区「牌友积分记分区」的数据源） */
    roomStats: { round: 0, seats: seatArr.map(() => ({ games: 0, wins: 0, losses: 0, draws: 0, points: 0 })) },
  };
  store.rooms.set(code, room);
  // 必须把密码一并传给 joinRoom，否则房主自己会被密码校验拦下（v0.4.4 修复）
  joinRoom(socket, code, 'seat', firstEmpty(seatArr), room.password);
  broadcastLobby();
}

function joinRoom(socket, code, kind, seat, password, opts) {
  opts = opts || {};
  const r = store.rooms.get(code);
  if (!r) return socket.emit('error:msg', { msg: '房间不存在' });
  /* v0.43.0（R32）：进新房前退出所有其它房（目标房保留，避免重复加入时
   * 把自己刚坐下的座位又清掉）。顺手作废断线保座，防止旧记录在重连时
   * 把用户拉回上一间房。 */
  leaveAllRooms(socket, code);
  try { store.clearDisconnected(socket.data.pid); } catch (e) { }
  socket.join(code); socket.data.room = code;
  if (kind === 'seat') {
    if (seat == null || seat < 0) seat = firstEmpty(r.seats);
    // 先验密码：避免在密码错误时泄露房间占用情况
    if (r.password && password !== r.password) {
      socket.leave(code); socket.data.room = null;
      return socket.emit('error:msg', { msg: '房间密码错误' });
    }
    if (seat < 0 || !r.seats[seat] || r.seats[seat].type !== 'human' || r.seats[seat].pid) {
      /* v0.12.0（R3-3）邀请链接进房：座位满了不再硬报错。
       * 朋友拿链接来最尴尬的场面就是「无空座位」四个字 —— 桌上明明打着牌。
       * 转观战（能看到全部动作），想下场由房主腾位/换桌，体验顺滑不拦人。
       * v0.30.0（R18-1）：**只有邀请链接**才允许转观战。
       * 旧实现在「房内没有真人」时也转观战 —— 快速匹配误选到房主断线的
       * 宽限空房时，用户点「快速开始」会莫名其妙变成观战者，且退不出去。
       * 普通加入满员应当明确报错，让客户端提示/重试，绝不静默降级。 */
      if (opts.invite) return joinRoom(socket, code, 'spectator');
      // 落座失败必须退出 socket.io 房间，否则会继续收到该房间广播（v0.4.4 修复）
      socket.leave(code); socket.data.room = null;
      return socket.emit('error:msg', { msg: '无空座位' });
    }
    r.seats[seat].pid = socket.data.pid;
    // 座位身份随账号走：有账号用账号昵称与形象，没有则用默认名
    const ident = socket.data.identity;
    if (ident) {
      r.seats[seat].name = ident.name;
      r.seats[seat].avatar = ident.avatar;
      r.seats[seat].color = ident.color;
      r.seats[seat].guest = !!ident.guest;
    } else {
      /* v0.12.0：兜底名修正。原来拼的是 '玩家' + 房号前两位，
       * 房号里含数字时就出现「玩家0L」这种读不通的名字（截图里就是这样）。
       * 现在优先用 socket.data.name（握手时可能已带昵称），
       * 再退回「房号 + 座位号」的短标识，至少能区分是谁。 */
      r.seats[seat].name = r.seats[seat].name
        || socket.data.name
        || ('牌友' + code.slice(0, 2) + (seat + 1));
      // 未登录玩家也要有形象，否则座位环上是空白头像
      assignFallbackAvatar(r.seats[seat], socket.data.pid);
    }
  } else if (!r.spectators.includes(socket.data.pid)) r.spectators.push(socket.data.pid);
  // 观战者传 -1：各游戏 view 据此隐藏手牌；传 NaN 会让 view 取到 undefined
  /* v0.12.0（R2-4）：新的人坐下后立刻重置托管状态与计时 ——
   * 之前如果这个座位被 AI 托管过，counter 还挂着「托管中」，
   * 本人回来坐下会看到自己的座位显示「托管中」，很怪。
   * 同时若此刻正轮到他，计时必须重新开始（不是从上一手算起）。 */
  if (kind === 'seat' && seat >= 0 && r.seats[seat]) {
    r.seats[seat].trusted = 0;
    r.seats[seat].auto = false;
    r.seats[seat].manual = false;        // v0.17.0：新人落座 = 结束托管
    delete r.seats[seat].trustedAt;
    try { armTurnTimer(r); } catch (e) { }
  }
  socket.emit('room:state', serializeRoom(r, kind === 'spectator' ? -1 : Math.max(0, seat)));
  broadcastRoom(r); broadcastLobby();
  maybeAITurn(r);
}

/** 把各游戏 AI 的返回归一化成前端统一消费的建议结构
 *  统一返回：{ move: {...}, cells: [[x,y],...], text: '推荐说明' }
 *  前端只按 cells / move 两类高亮渲染，无须逐游戏判断。
 */
function normalizeAdvice(r, raw, seat) {
  if (!raw) return { text: '这一步暂无可参考的走法' };
  const g = r.game;
  const pos = (x, y) => [[x, y]];
  const algToXY = (a) => [ 'abcdefgh'.indexOf(String(a)[0]), 8 - Number(String(a).slice(1)) ];

  if (g === 'gomoku' || g === 'reversi' || g === 'go' || g === 'connect4') {
    if (raw.pass) return { move: { pass: true }, text: '建议虚手（Pass）' };
    if (raw.col != null) return { move: { col: raw.col }, text: `建议落在第 ${raw.col + 1} 列` };
    if (raw.x != null && raw.y != null) {
      const posName = `(${raw.x + 1}, ${raw.y + 1})`;
      return { move: { x: raw.x, y: raw.y }, cells: pos(raw.x, raw.y), text: `建议下在 ${posName}` };
    }
    return { text: '这一步暂无可参考的走法' };
  }
  if (g === 'chess') {
    if (raw.from != null && raw.to != null) {
      const [fx, fy] = Array.isArray(raw.from) ? raw.from : algToXY(raw.from);
      const [tx, ty] = Array.isArray(raw.to) ? raw.to : algToXY(raw.to);
      const nm = (Array.isArray(raw.from) ? '' : `${raw.from}→${raw.to}`);
      return { move: { from: [fx, fy], to: [tx, ty] }, cells: [[fx, fy], [tx, ty]], text: nm || '已标出推荐走法' };
    }
    return { text: '这一步暂无可参考的走法' };
  }
  if (g === 'xiangqi') {
    const f = raw.from || raw.fromXY, t = raw.to || raw.toXY;
    if (Array.isArray(f) && Array.isArray(t)) {
      return { move: { from: f, to: t }, cells: [f, t], text: `建议 ${'abcdefghi'[f[0]]}${10 - f[1]} → ${'abcdefghi'[t[0]]}${10 - t[1]}` };
    }
    return { text: '这一步暂无可参考的走法' };
  }
  if (g === 'doudizhu' || g === 'guandan' || g === 'shengji') {
    if (Array.isArray(raw.cards) && raw.cards.length) {
      // 用牌型库还原「建议出什么」，不要只说「建议出 5 张」
      let txt = `建议出 ${raw.cards.length} 张`;
      try {
        const hand = (r.state.hands && r.state.hands[seat]) || [];
        const byId = new Map(hand.map(c => [c.id, c]));
        const picked = raw.cards.map(id => byId.get(id)).filter(Boolean);
        if (picked.length === raw.cards.length) txt = `建议出「${hint.describe(picked)}」`;
      } catch (e) { /* 保持兜底文案 */ }
      return { move: { cards: raw.cards }, text: txt };
    }
    if (raw.pass || raw.type === 'pass') return { move: { type: 'pass' }, text: '建议不出（过牌）' };
    return { text: '这一步暂无可参考的走法' };
  }
  if (g === 'mahjong') {
    if (raw.discard || raw.tile) {
      const t = raw.discard || raw.tile;
      return { move: { tile: t.id || t }, cells: [], text: '建议打出高亮的牌' };
    }
    return { text: '这一步暂无可参考的走法' };
  }
  if (g === 'texas') {
    if (raw.type) return { move: raw, text: `建议：${{ fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: '全下' }[raw.type] || raw.type}` };
    return { text: '这一步暂无可参考的走法' };
  }
  return { text: raw.text || '已标出推荐走法' };
}

function syncSeatProfile(r) {
  for (const s of r.seats) {
    if (s.type !== 'human' || !s.pid) continue;
    const u = account.users.get(s.pid) || account.guests.get(s.pid);
    if (u) { s.name = u.name; s.avatar = u.avatar; s.color = u.color; s.guest = !!u.guest; }
    else assignFallbackAvatar(s, s.pid);
  }
}

/* v0.19.0（R7-1）：匿名 / 已登出座位的兜底形象改用 12 个精绘角色，与 avatar.js v4 一致 */
const FALLBACK_AVATARS = ['longzhao', 'fengyi', 'qilin', 'baihu', 'xuanwu', 'jiuwei', 'pixiu', 'jinchan', 'xianhe', 'xingzhe', 'lianhua', 'moke'];
const FALLBACK_COLORS = ['#ff6b6b', '#4f8cff', '#3ddc84', '#ffb03a', '#a06bff', '#20c9c9'];
/** 匿名 / 已登出的座位也要有稳定形象：按 pid 哈希选，刷新不变 */
function assignFallbackAvatar(seat, pid) {
  if (!seat || seat.avatar) return;
  let h = 0; const k = String(pid || '');
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  seat.avatar = FALLBACK_AVATARS[h % FALLBACK_AVATARS.length];
  seat.color = FALLBACK_COLORS[(h >> 4) % FALLBACK_COLORS.length];
}

/* M4 播报：把本次 move 转成可读文本（不暴露暗牌），由 game:move 与 AI 行动
 * 成功后各 emit 一次 table:action。任何异常都返回 null，绝不影响主流程。 */
const ACTION_VL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
const actionVName = v => ACTION_VL[v] || String(v);
/* ════════════════════════════════════════════════════════════════════════
 * v0.14.0 语音报牌全面化 —— 用户硬要求：「打单张需要报牌，打每一手都需要语音报牌，
 * 准确及时」。旧实现的缺口（截图实测 + 代码审计）：
 *   ① 德州扑克**没有任何分支** —— 弃牌/过牌/跟注/加注/全下全程静默；
 *   ② 斗地主/掼蛋只报「出3张（9）」—— 不报牌型，单张也听不出是哪张；
 *   ③ 麻将只报「打出一张牌」—— 不报哪张（打3万和打九筒听不出区别）。
 * 现在：
 *   · 牌类出牌统一走 lib/cards 的 parseCombo 报「单张9 / 对K / 三带二 /
 *     顺子3到7 / 连对 / 飞机 / 炸弹2 / 王炸」；
 *   · 麻将报「打3万」—— 牌名从 apply 后的 state.lastDiscard 取
 *     （apply 已把牌从手牌移走，lastDiscard 是唯一可靠来源）；
 *   · 德州报「弃牌 / 过牌 / 跟注 / 加注到X / 全下」。
 * 所有播报仍走 table:action 单通道，客户端气泡 + TTS 共用，绝不重复造轮子。
 * ════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
 * v0.17.0（R5-1）结构化语音片段：act.v = ['dan','n9']（「单张 九」）
 * 前端用内置真人录音片段拼接播放（sfx/v/*.mp3），任一片段缺失才回落 TTS。
 * 点数 → 片段 key 映射（前端录音库的命名，见 sound.js VSEG）。
 * ══════════════════════════════════════════════════════════════════════════ */
const RANK_SEG = { 11: 'nJ', 12: 'nQ', 13: 'nK', 14: 'nA', 15: 'n2', 16: 'nw1', 17: 'nw2' };
const rankSeg = v => RANK_SEG[v] || ('n' + v);
function describeCardCombo2(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  let c = null;
  try { c = cardsLib.parseCombo(cards); } catch (e) { }
  if (!c) return { text: `出${cards.length}张`, v: null };
  const N = rankSeg(c.rank);
  switch (c.type) {
    case 'single': return { text: `单张${actionVName(c.rank)}`, v: ['dan', N] };
    case 'pair': return { text: `对${actionVName(c.rank)}`, v: ['dui', N] };
    case 'trio': return { text: `三张${actionVName(c.rank)}`, v: ['sange', N] };
    case 'trio_single': return { text: '三带一', v: ['sdai1'] };
    case 'trio_pair': return { text: '三带二', v: ['sdai2'] };
    case 'straight': {
      const endRank = c.rank + (c.len || cards.length) - 1;
      return { text: `顺子${actionVName(c.rank)}到${actionVName(endRank)}`, v: ['shunzi', N, 'dao', rankSeg(endRank)] };
    }
    case 'straight_pair': return { text: `连对${actionVName(c.rank)}起`, v: ['liandui', N, 'qi'] };
    case 'plane': case 'plane_single': case 'plane_pair': return { text: '飞机', v: ['feiji'] };
    case 'bomb': return { text: `炸弹${actionVName(c.rank)}`, v: ['zhadan', N] };
    case 'rocket': return { text: '王炸', v: ['wangzha'] };
    default: return { text: `出${cards.length}张`, v: null };
  }
}
function describeCardCombo(cards) {
  const d = describeCardCombo2(cards);
  return d ? d.text : null;
}
/* 麻将数字 → 片段（2/3 复用牌点 n2/n3，其余 m 系列） */
const MJ_NUM_SEG = { 1: 'm1', 2: 'n2', 3: 'n3', 4: 'm4', 5: 'm5', 6: 'm6', 7: 'm7', 8: 'm8', 9: 'm9' };
function actionFromMove(game, mv, seatIdx, st) {
  try {
    if (!mv || typeof mv !== 'object') return null;
    if (game === 'doudizhu' || game === 'guandan') {
      if (mv.type === 'pass') return { seat: seatIdx, text: '不出', v: ['buyao'] };
      if (mv.type === 'bid') {
        return mv.score > 0
          ? { seat: seatIdx, text: `叫${mv.score}分`, v: ['jiao' + mv.score] }
          : { seat: seatIdx, text: '不叫', v: ['bujiao'] };
      }
      /* v0.14.0：move.cards 是**牌 id**（applyMove 用 includes(c.id) 解析），
       * 直接 parseCombo 得到的 rank 全是 NaN（实测播报「单张NaN」）。
       * 真牌对象在 apply 之后的 state.lastPlay.cards 里（seat 校验防串台）；
       * 拿不到 lastPlay 时才退回原始 cards（兼容直传对象的历史路径）。 */
      const lp = st && st.lastPlay;
      let cards = null;
      if (lp && lp.seat === seatIdx && Array.isArray(lp.cards) && lp.cards.length) cards = lp.cards;
      else if (Array.isArray(mv.cards) && mv.cards.length && typeof mv.cards[0] === 'object') cards = mv.cards;
      const d = describeCardCombo2(cards || mv.cards);
      return d ? { seat: seatIdx, text: d.text, v: d.v } : null;
    }
    if (game === 'mahjong') {
      /* v0.14.0：麻将 s 是花色**索引**（0=万 1=条 2=筒，见 mahjong.js SUITS），
       * 直接拼「打20」是错的 —— 报牌要读人话：「打2万」。 */
      const mjName = t => (t && typeof t.s === 'number') ? `${t.r}${['万', '条', '筒'][t.s] || ''}` : (t ? `${t.r}${t.s || ''}` : '');
      if (mv.type === 'discard') {
        /* apply 已把牌从手牌移进 discards：lastDiscard 是刚打出的那张 */
        const ld = st && st.lastDiscard;
        if (ld && ld.seat === seatIdx) {
          const suitSeg = ['wan', 'tiao', 'tong'][ld.s] || 'wan';
          const numSeg = MJ_NUM_SEG[ld.r] || null;
          return {
            seat: seatIdx, text: `打${mjName(ld)}`,
            v: numSeg ? ['da', numSeg, suitSeg] : null,
          };
        }
        return { seat: seatIdx, text: '打出一张牌', v: null };
      }
      if (mv.type === 'claim') {
        const seg = mv.kind === 'gang' ? ['gang'] : mv.kind === 'peng' ? ['peng'] : mv.kind === 'chi' ? ['chi'] : null;
        return { seat: seatIdx, text: mv.kind === 'gang' ? '杠' : mv.kind === 'peng' ? '碰' : mv.kind === 'chi' ? '吃' : '鸣牌', v: seg };
      }
      if (mv.type === 'angang') return { seat: seatIdx, text: '暗杠', v: ['angang'] };
      if (mv.type === 'jiagang') return { seat: seatIdx, text: '加杠', v: ['jiagang'] };
      if (mv.type === 'hu') return { seat: seatIdx, text: '胡', v: ['hu'] };
      if (mv.type === 'zimo') return { seat: seatIdx, text: '自摸', v: ['zimo'] };
      if (mv.type === 'pass') return { seat: seatIdx, text: '不鸣', v: ['buming'] };
      return null;
    }
    if (game === 'texas') {
      if (mv.type === 'fold') return { seat: seatIdx, text: '弃牌', v: ['qipai'] };
      if (mv.type === 'check') return { seat: seatIdx, text: '过牌', v: ['guopai'] };
      if (mv.type === 'call') return { seat: seatIdx, text: '跟注', v: ['genzhu'] };
      if (mv.type === 'raise') return { seat: seatIdx, text: (mv.to || mv.amount) ? `加注到${mv.to || mv.amount}` : '加注', v: ['jiazhu'] };
      if (mv.type === 'allin') return { seat: seatIdx, text: '全下', v: ['quanxia'] };
      return null;
    }
    if (game === 'shengji') {
      if (mv.type === 'declare') return { seat: seatIdx, text: mv.suit === 'N' ? '叫无主' : '叫主', v: [mv.suit === 'N' ? 'jiaowuzhu' : 'jiaozhu'] };
      if (mv.type === 'pass') return { seat: seatIdx, text: '不叫', v: ['bujiao'] };
      if (Array.isArray(mv.cards) && mv.cards.length) return { seat: seatIdx, text: `出${mv.cards.length}张`, v: null };
      return null;
    }
  } catch (e) { /* 播报失败不影响对局 */ }
  return null;
}

function afterMove(r, next) {
  const st = r.state;
  if (st.winner != null || st.draw) {
    clearTurnTimer(r.code); r.turnDeadline = null;
    recordGame(r); broadcastRoom(r); broadcastLobby(); return;
  }
  if (next != null) st.current = ((next % r.seats.length) + r.seats.length) % r.seats.length;
  else st.current = (st.current + 1) % r.seats.length;
  const onStart = GAMES[r.game].onTurnStart;
  if (onStart) onStart(st, st.current + 1);
  if (st.winner != null || st.draw) { clearTurnTimer(r.code); r.turnDeadline = null; recordGame(r); }
  /* v0.12.0（R2-4）：先排计时再广播 —— 保证客户端收到的这一帧里就带 turnDeadline，
   * 进度条从一开始就是对的，不会「先满后跳」。 */
  armTurnTimer(r);
  broadcastRoom(r);
  maybeAITurn(r);
}

async function maybeAITurn(r) {
  if (isExt(GAMES[r.game])) return;   // 外部游戏没有服务端 AI
  if (r.state.winner != null || r.state.draw) return;
  const seat = r.seats[r.state.current];
  /* v0.10.17 修复「真人不够就卡死」：
   *
   * 旧逻辑只在 seat.type === 'ai' 时推进 AI 行动。但座位上还有第三种状态 ——
   * **空位**（type:'human' 但 pid 为 null，即还没人入座）。
   * 两个真人开一桌 3 人斗地主时，第 3 位永远空着，轮到它时既不是 AI、
   * 也没人操作 → 牌局永久停在那里，且界面上没有任何提示。
   * 这正是「开房能开、但打着打着不动了」的根因。
   *
   * 现在把「空位」也纳入托管：轮到一个没人坐的座位，就用 AI 代打。
   * 注意不改 seat.type —— 空位仍是空位，后来的人随时能坐下来接管，
   * 这样「先和朋友打着，中途有人进来」也不会把座位永久变成机器。
   *
   * 托管等级用 'fun'（轻松），避免空位打得比真人还强，破坏游戏体验。 */
  const isVacant = !!(seat && seat.type === 'human' && !seat.pid);
  if (seat && (seat.type === 'ai' || isVacant)) {
    // v0.12.0（R2-4）：轮到 AI / 空位时不可能是真人计时，清掉避免误托管
    clearTurnTimer(r.code); r.turnDeadline = null;
    const level = seat.type === 'ai' ? (seat.aiLevel || 'fun') : 'fun';
    setTimeout(async () => {
      const r2 = store.rooms.get(r.code); if (!r2 || r2.state.winner != null || r2.state.draw) return;
      /* 二次确认：这 420ms 里可能刚有人坐下，那就交给真人，不要抢他的回合 */
      const s2 = r2.seats[r2.state.current];
      if (!s2 || (s2.type === 'human' && s2.pid)) return;
      try {
        const mv = await GAMES[r2.game].ai(r2.state, r2.state.current + 1, level, { engine: r2.aiEngine });
        if (mv) {
          /* v0.14.0（P1）播报座位必须在 apply 之前取 —— 斗地主/麻将等游戏的
           * applyMove 内部就把 state.current 推进到下家，apply 之后再取会
           * 把 A 出的牌报成下家 B 的名字（实测确认的真实错报）。 */
          const mover = r2.state.current;
          const res = GAMES[r2.game].apply(r2.state, mv, r2.state.current + 1);
          if (res.ok) {
            try {
              const act = actionFromMove(r2.game, mv, mover, r2.state);
              if (act) io.to(r2.code).emit('table:action', act);
            } catch (e) { /* ignore */ }
            afterMove(r2, res.next);
          }
          else console.error('AI move rejected', r2.game, res.reason);
        }
      } catch (e) { console.error('AI error', e && e.message); }
    }, isVacant ? 620 : 420);
  }
}

const PORT = process.env.PORT || 8088;
server.listen(PORT, () => console.log('HomeArena hub v' + VERSION + ' listening on :' + PORT));

/* ══════════════════════════════════════════════════════════════════════
 * v0.45.0（R34-1）：局域网服务端自动发现
 * ----------------------------------------------------------------------
 * 旧架构里，手机要连家里的 NAS 只能手填 `https://nas.local:7999`。
 * 填错一次就整机断联，而用户根本不知道该填什么 —— 这不是用户的问题。
 *
 * 现在服务端每 2 秒向 255.255.255.255:47621 广播一条 t:'server' 报文，
 * 原生 UDP 桥（安卓 / 鸿蒙）原样交给 lan.js，模式选择页直接列出
 * 「发现家庭服务端 · 一键连接」。浏览器与 NAS 页面本身收不到 UDP，
 * 但它们本来就是服务端下发的页面，不需要发现。
 * ══════════════════════════════════════════════════════════════════════ */
const LAN_DISCOVER_PORT = 47621;
function lanOrigin() {
  const fixed = process.env.HOMEARENA_PUBLIC_URL;
  if (fixed) return String(fixed).replace(/\/+$/, '');
  try {
    const nets = require('os').networkInterfaces();
    for (const k of Object.keys(nets)) {
      for (const a of nets[k] || []) {
        if (a && a.family === 'IPv4' && !a.internal) return 'http://' + a.address + ':' + PORT;
      }
    }
  } catch (e) { }
  return 'http://127.0.0.1:' + PORT;
}
function startLanBeacon() {
  try {
    const dgram = require('dgram');
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => { try { sock.close(); } catch (e) { } });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (e) { }
      const payload = Buffer.from(JSON.stringify({
        t: 'server', app: 'homearena', origin: lanOrigin(),
        name: process.env.HOMEARENA_NAME || 'HomeArena 家庭棋牌', v: VERSION,
      }));
      const tick = () => {
        try { sock.send(payload, 0, payload.length, LAN_DISCOVER_PORT, '255.255.255.255'); } catch (e) { }
      };
      tick();
      const timer = setInterval(tick, 2000);
      timer.unref && timer.unref();
    });
    sock.unref && sock.unref();
  } catch (e) {
    console.warn('[lan] 服务端广播未启动：', e && e.message);
  }
}
startLanBeacon();
