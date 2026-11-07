// 系统设置（v0.10.21 新增）
// ─────────────────────────────────────────────────────────────────────────────
// 【为什么需要这一层】用户从 v0.9.0 起就提「健全账号体系和注册开关」，但一直
// 只有账号、没有"开关"。家庭 NAS 场景里这不是可选项：
//   · 孩子用帐号玩，家长不希望他随手注册一堆小号刷战绩；
//   · 来客人时想临时放开注册，客人走了再关掉；
//   · 关掉注册后老用户必须还能登录 —— 这是最容易被做错的地方
//     （很多人把"注册关闭"实现成"账号系统关闭"，老用户一起被锁在外面）。
//
// 【设计要点】
//   ① **开关只影响 register()，绝不影响 login() / resolve() / guest()**；
//   ② 游客永远是开的 —— 否则关掉注册后新朋友连进来看一眼都不行，
//      而游客本来就不落盘、不影响战绩库，风险为零；
//   ③ 管理员可随时改，配置落盘到 DATA_DIR/settings.json，重启保持；
//   ④ 前端能读到 `allowRegister` 来决定「注册」按钮是显示还是禁用 +
//      给出明确原因，而不是让用户点了之后才被服务端拒绝。
//
// 【谁能改】家庭 NAS 默认「本机 + 房主」。这里用最简单的模型：
//   · 环境变量 HOMEARENA_ADMIN_TOKEN 存在时，改设置需带该 token；
//   · 不存在（默认）时，视为"家庭内网可信"，任一已登录账号可改。
//   这是刻意的取舍：家庭场景不需要 RBAC，加了反而每天都要找密码。
const fs = require('fs');
const path = require('path');

const DATA_DIR = (() => {
  const cand = process.env.TRIM_PKGVAR || process.env.HOMEARENA_DATA || path.join(__dirname, 'data');
  try { fs.mkdirSync(cand, { recursive: true }); } catch (e) { }
  return cand;
})();
const FILE = path.join(DATA_DIR, 'settings.json');

/** 默认值 —— 全部"友好"，装完就能用，不需要先配置 */
const DEFAULTS = {
  /* 是否允许新账号注册。关闭后：老账号照常登录、游客照常进入。 */
  allowRegister: true,
  /* 关闭时展示给用户的说明（前端原样显示，改这里就能换文案） */
  /* v0.34.0（R22-2）：默认文案改为中性表述。
   * 原文案是「…可直接以游客身份游玩；如需开通请联系管理员」——在
   * 「关注册 + 关游客」（membersOnly）的部署里，这句话直接把用户往一个
   * 会被服务端拒绝的按钮上引：点游客 → GUEST_CLOSED → 用户以为是 bug。
   * 前端会在 allowGuest 关闭时再追加一句说明，所以这里只保留与模式无关的事实。 */
  registerClosedHint: '本厅仅对已注册成员开放，如需开通账号请联系厅主。',
  /* 是否允许游客（不注册直接玩）。默认开。
   * v0.34.0（R22-2）：这个字段 v0.10.21 就存在，但**从来没有被任何逻辑读过** ——
   * 只是存下来、随快照发出去，然后就没有然后了。于是「关闭注册」之后
   * 游客入口照常亮着、照常能进，用户提的正是这个。
   *
   * 现在它是硬开关：
   *   · false → 服务端 socket.use 全局准入拦截所有业务事件；
   *             account:guest 直接拒绝；前端渲染全屏登录墙。
   *   · 与 allowRegister 联动：把 allowRegister 从 true 改成 false 时，
   *     若本次没显式带 allowGuest，则一并关掉（关闭注册 = 只留已有成员）。
   *     想保留「关注册但仍允许游客」的部署，显式传 allowGuest:true 即可。 */
  /* v0.45.0（R34-1）：默认值改为 false —— 平台不再允许游客。
   *   所有玩家必须注册登录；单机 / 局域网则由本地牌友身份承担同一职责。
   *   存量部署里显式写过 allowGuest=true 的仍尊重原值（升级不突袭），
   *   但客户端不再为游客提供入口。 */
  allowGuest: process.env.HA_ALLOW_GUEST === '1',
  /* 单次会话内同一 IP 的注册次数上限（防误操作连点 / 恶意刷号）。0 = 不限 */
  registerPerHour: 6,
  /* 昵称长度（中英文均按字符数算） */
  nameMin: 2,
  nameMax: 16,
  /* v0.12.0（R2-4）：回合超时秒数，超时后由 AI 托管代打。0 = 不限时。
     家庭局有人喜欢慢慢想，所以做成可关；默认 30s 兼顾「不卡桌」与「不为难人」。 */
  turnLimit: 30,
  /* v0.18.0（R6-3）管理员 uid。空 = 尚未指定 → 首个注册账号自动成为管理员
     （见 index.js account:register 的 ensureAdmin）。也可用环境变量
     HOMEARENA_ADMIN_UID 覆盖。管理面板里可以转让。 */
  adminUid: '',
  /* v0.31.0（R19-4）大厅公告。存 JSON 字符串（这样 load() 的
     typeof 一致性校验不用为对象特判），snapshot() 时解析成对象下发。
     形如 {"on":true,"level":"info","title":"","body":"","speed":22,"updatedAt":0} */
  notice: '',
};

/* ══════════════════════════════════════════════════════════════════════════
 * v0.31.0（R19-4）公告富文本净化
 * --------------------------------------------------------------------------
 * 公告由管理员在管理中心编辑，允许少量富文本（粗体/斜体/下划线/删除线/
 * 高亮/换行/自定义颜色），换取「视觉冲击力」。但**管理员的输入也不能直接
 * innerHTML** —— 一旦管理员账号被游客猜到口令，公告就成了 XSS 入口。
 *
 * 做法是「先全转义、再放行白名单标签」：
 *   ① 把 & < > " 全部转义 —— 此时无论输入什么，都只是一段纯文本；
 *   ② 再把白名单标签的转义形式还原成真标签。
 * 这样不依赖任何 HTML 解析器，也就不存在「解析器与浏览器理解不一致」的绕过。
 * 代价是不支持嵌套属性的复杂 HTML —— 公告不需要，也不该需要。
 * ══════════════════════════════════════════════════════════════════════════ */
const NOTICE_MAX = 2000;
function sanitizeNotice(raw) {
  let s = String(raw == null ? '' : raw).slice(0, NOTICE_MAX);
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /* 成对的行内标签 */
  s = s.replace(/&lt;(\/?)(b|strong|i|em|u|s|mark|small)&gt;/gi, '<$1$2>');
  /* 换行 */
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  /* 颜色：只接受 #rgb/#rrggbb/rgb()/rgba()，其余一律丢弃（拦住 expression/url） */
  s = s.replace(
    /&lt;span\s+style=&quot;\s*color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]{3,40}\))\s*;?\s*&quot;\s*&gt;/gi,
    '<span style="color:$1">');
  s = s.replace(/&lt;\/span&gt;/gi, '</span>');
  return s;
}

function noticeObj() {
  let o = null;
  try { o = cfg.notice ? JSON.parse(cfg.notice) : null; } catch (e) { o = null; }
  if (!o || typeof o !== 'object') return { on: false, level: 'info', title: '', body: '', speed: 22, updatedAt: 0 };
  return {
    on: !!o.on,
    level: ['info', 'warn', 'hot'].indexOf(o.level) >= 0 ? o.level : 'info',
    title: String(o.title || '').slice(0, 40),
    /* 写入时已净化（update -> sanitizeNotice），读取直接返回。
       若在这里再净化一次，`&lt;` 里的 `&` 会被二次转义成 `&amp;lt;`，
       公告里就会出现字面量 —— 这是本轮实测踩到的。 */
    body: String(o.body || ''),
    speed: Math.max(8, Math.min(60, Number(o.speed) || 22)),
    updatedAt: Number(o.updatedAt) || 0,
  };
}

let cfg = { ...DEFAULTS };

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const o = (p && p.settings) || {};
    for (const k of Object.keys(DEFAULTS)) {
      if (o[k] !== undefined && typeof o[k] === typeof DEFAULTS[k]) cfg[k] = o[k];
    }
    /* v0.34.0（R22-2）旧配置迁移。
     * v0.33.0 及更早的 settings.json 里，allowGuest 只是个存了没人读的字段；
     * 老部署即使 allowRegister=false（明确「不开放注册」），allowGuest 往往
     * 仍是默认 true —— 升级后如果原样沿用，游客照样能进，等于本次修复
     * 对存量部署完全无效。这里以「注册已关」为准做一次性收敛：
     * 只有配置文件里**显式写过** allowGuest 才尊重原值。 */
    if (o.allowGuest === undefined && !cfg.allowRegister) cfg.allowGuest = false;
    console.log('[settings] 已载入系统设置 allowRegister=' + cfg.allowRegister
      + ' allowGuest=' + cfg.allowGuest);
  } catch (e) { /* 文件损坏就用默认值，不能因为设置坏了起不来 */ }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify({ v: 1, at: Date.now(), settings: cfg }, null, 2));
    } catch (e) { console.log('[settings] 落盘失败：' + e.message); }
  }, 400);
}

load();

/** 只读快照（前端用） */
function snapshot() {
  return {
    allowRegister: !!cfg.allowRegister,
    registerClosedHint: String(cfg.registerClosedHint || ''),
    allowGuest: !!cfg.allowGuest,
    /* v0.34.0（R22-2）：派生的准入模式，前端只用它做文案，判定一律以
     * allowGuest / allowRegister 两个原始布尔为准（少一层推导少一处不一致）。
     *   open        注册开、游客开   —— 默认，谁都能进
     *   loginOnly   注册开、游客关   —— 必须注册或登录
     *   guestOnly   注册关、游客开   —— 老部署的「关注册但留游客」
     *   membersOnly 注册关、游客关   —— 仅已有成员，非成员完全不可见 */
    accessMode: (!cfg.allowRegister && !cfg.allowGuest) ? 'membersOnly'
      : (!cfg.allowRegister ? 'guestOnly' : (!cfg.allowGuest ? 'loginOnly' : 'open')),
    /* v0.11.0：补上 registerPerHour。
       原来 snapshot 漏了这个字段，管理面板（R1-2）读不到就渲染成 0，
       显示"每小时注册上限 0"—— 语义上 0 是"不限"，看起来像没配置，
       用户会以为限额没生效。这是典型的"服务端有、前端拿不到"，
       只有真正把 UI 接上去才暴露出来。 */
    registerPerHour: cfg.registerPerHour | 0,
    nameMin: cfg.nameMin | 0,
    nameMax: cfg.nameMax | 0,
    turnLimit: cfg.turnLimit | 0,
    /* v0.18.0（R6-3）：管理员 uid 下发给前端，用于「管理中心」入口显隐。
       家庭场景公开无妨；鉴权永远以服务端为准（socket/HTTP 双侧校验）。 */
    adminUid: adminUidOf(),
    /* v0.31.0（R19-4）公告随设置快照下发：前端顶栏直接读，不需要第二条通道。
       未配置时返回 { on:false }，前端据此把公告栏折叠回版本条。 */
    notice: noticeObj(),
  };
}

/* ═══ v0.18.0（R6-3）管理员身份 ═══════════════════════════════════════
 * 模型：**单管理员**（用户明确要求「游戏导入权仅管理员一人」）。
 *   ① 环境变量 HOMEARENA_ADMIN_UID 优先（运维兜底）；
 *   ② settings.json 的 adminUid 次之（面板可转让）；
 *   ③ 都为空时首个注册账号在 register 后被 ensureAdmin 固化。
 * 管理权覆盖：系统设置、玩家账号（增删改）、游客清理、**游戏导入**。 */
function adminUidOf() {
  return process.env.HOMEARENA_ADMIN_UID || cfg.adminUid || '';
}
function isAdminUid(uid) {
  const a = adminUidOf();
  return !!a && String(uid) === a;
}
/** 首个注册账号成为管理员（幂等：已指定则不覆盖） */
function ensureAdmin(uid) {
  if (adminUidOf() || !uid) return false;
  cfg.adminUid = String(uid);
  save();
  console.log('[settings] 管理员已绑定：' + cfg.adminUid);
  return true;
}
/** v0.32.0（R20 审计 P0-5）：管理权变更的**唯一**正式通道。
 *  通用写入口 settings.update() 已拒绝 adminUid 字段，
 *  只有这里（由 index.js 的 admin:transfer 调用）能改。 */
function setAdminUid(uid) {
  cfg.adminUid = String(uid || '').slice(0, 40);
  save();
  return { ok: true, settings: snapshot() };
}

/** 注册限流：内存里记 ip -> [时间戳]，滑窗 1 小时 */
const regHits = new Map();
function canRegisterFrom(ip) {
  const lim = cfg.registerPerHour | 0;
  if (lim <= 0) return true;
  const now = Date.now();
  const arr = (regHits.get(ip) || []).filter(t => now - t < 3600e3);
  regHits.set(ip, arr);
  return arr.length < lim;
}
function noteRegisterFrom(ip) {
  const arr = regHits.get(ip) || [];
  arr.push(Date.now());
  regHits.set(ip, arr);
  /* 顺手清理：避免长期运行后 Map 无限增长 */
  if (regHits.size > 2000) {
    const now = Date.now();
    for (const [k, v] of regHits) {
      const keep = v.filter(t => now - t < 3600e3);
      if (keep.length) regHits.set(k, keep); else regHits.delete(k);
    }
  }
}

/**
 * 改设置。patch 里只接受已知键，其余忽略（防止前端塞进奇怪字段）。
 * 返回 { ok, settings?, msg? }
 */
function update(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, msg: '参数无效' };
  const next = { ...cfg };
  const registerWasOpen = !!cfg.allowRegister;
  if (patch.allowRegister !== undefined) next.allowRegister = !!patch.allowRegister;
  if (patch.allowGuest !== undefined) next.allowGuest = !!patch.allowGuest;
  /* v0.34.0（R22-2）：关注册 ⇒ 同时关游客。
   * 只在「本次没显式指定 allowGuest」且「allowRegister 由开转关」时触发，
   * 避免每次改别的字段都把管理员手动打开的 allowGuest 冲掉。 */
  if (patch.allowRegister !== undefined && patch.allowGuest === undefined
    && registerWasOpen && !next.allowRegister) {
    next.allowGuest = false;
  }
  if (patch.registerClosedHint !== undefined) {
    const s = String(patch.registerClosedHint).slice(0, 120);
    next.registerClosedHint = s || DEFAULTS.registerClosedHint;
  }
  if (patch.registerPerHour !== undefined) {
    const n = Math.round(Number(patch.registerPerHour));
    next.registerPerHour = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULTS.registerPerHour;
  }
  if (patch.nameMin !== undefined || patch.nameMax !== undefined) {
    let a = patch.nameMin !== undefined ? Math.round(Number(patch.nameMin)) : next.nameMin;
    let b = patch.nameMax !== undefined ? Math.round(Number(patch.nameMax)) : next.nameMax;
    if (!Number.isFinite(a) || a < 2) a = 2;
    if (!Number.isFinite(b) || b > 16) b = 16;
    if (b < a) b = a;
    next.nameMin = a; next.nameMax = b;
  }
  if (patch.turnLimit !== undefined) {
    const n = Math.round(Number(patch.turnLimit));
    // 0 = 不限时；否则夹在 10~180 秒之间（低于 10s 无法正常思考，高于 180s 等于不限）
    next.turnLimit = Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(180, Math.max(10, n))) : DEFAULTS.turnLimit;
  }
  /* v0.18.0（R6-3）管理员转让：只接受 uid 字符串；空串=清空（下个注册者接管）
   * v0.32.0（R20 审计 P0-5）**从通用写入口移除**。
   *   settings.update() 是「什么都能改一点」的白名单写入口，
   *   而 settings:update 只校验「调用者是不是管理员」，不区分敏感键 ——
   *   于是管理权变更可以绕开正式的 admin:transfer 通道
   *   （后者有二次确认与审计日志），且 recordAudit 只记字段名，
   *   不会标记「改绑管理员」。
   *   管理权变更现在**只允许**走 admin:transfer。 */
  if (patch.adminUid !== undefined) {
    return { ok: false, msg: '管理权变更请使用「转让管理员」功能', code: 'ADMIN_UID_PROTECTED' };
  }
  /* v0.31.0（R19-4）公告：对象进、JSON 字符串存。
     只取白名单字段，body 走 sanitizeNotice —— 管理员的富文本也不能直接落库。 */
  if (patch.notice !== undefined) {
    const n = patch.notice && typeof patch.notice === 'object' ? patch.notice : {};
    const obj = {
      on: !!n.on,
      level: ['info', 'warn', 'hot'].indexOf(n.level) >= 0 ? n.level : 'info',
      title: String(n.title || '').slice(0, 40),
      body: sanitizeNotice(n.body || ''),
      speed: Math.max(8, Math.min(60, Number(n.speed) || 22)),
      updatedAt: Date.now(),
    };
    next.notice = JSON.stringify(obj);
  }
  cfg = next;
  save();
  return { ok: true, settings: snapshot() };
}

/** 管理员鉴权：有 token 环境变量就校验，没有就放行（家庭内网模型） */
function isAdmin(token) {
  const need = process.env.HOMEARENA_ADMIN_TOKEN;
  if (!need) return true;
  return String(token || '') === need;
}

function requiresToken() { return !!process.env.HOMEARENA_ADMIN_TOKEN; }

module.exports = {
  get: () => cfg,
  snapshot, update, isAdmin, requiresToken,
  canRegisterFrom, noteRegisterFrom,
  adminUidOf, isAdminUid, ensureAdmin, setAdminUid,
  DEFAULTS, FILE,
};
