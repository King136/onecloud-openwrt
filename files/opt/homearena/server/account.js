// 账号与虚拟形象（v0.9.0 / v0.12.0 会话持久化）
// 设计取舍：
//   · 家庭 NAS 场景，无外网依赖 —— 纯本地账号，不接 OAuth；
//   · 密码用 scrypt + 随机盐，绝不明文；比较用 timingSafeEqual 防时序侧信道；
//   · **登录态用 HMAC 签名 token，不依赖内存 Map** —— 见下方 v0.12.0 说明；
//   · 游客（guest）不落盘，只在内存里有个临时身份，可直接开局；
//   · 账号与战绩绑定：pid 即账号 ID（u_xxx），历史战绩迁移沿用同一个 key。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = (() => {
  const cand = process.env.TRIM_PKGVAR || process.env.HOMEARENA_DATA || path.join(__dirname, 'data');
  try { fs.mkdirSync(cand, { recursive: true }); } catch (e) { }
  return cand;
})();
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'session.key');

/** 内置虚拟形象：v0.19.0（R7-1）起为 12 个精绘「古风神话」全身角色
 *  （青龙·昭 / 朱雀·仪 / 麒麟·麟 / 白虎·贲 / 玄武·真 / 九尾·璃 /
 *   貔貅·招 / 金蟾·蟾 / 仙鹤·松 / 齐天·圣 / 莲花·娃 / 墨客·书），
 *  每个角色独立设计、配色固定，不再有 [0-7] 换色变体；前端 avatar.js v4
 *  负责渲染。旧 8 造型（fox/panda…）与 v3 的 loong/phoenix… 等 id 仍合法，
 *  并自动映射到新角色（见 avatar.js LEGACY_BASE），老用户无需重选。 */
const AV_PROTOS = ['longzhao', 'fengyi', 'qilin', 'baihu', 'xuanwu', 'jiuwei', 'pixiu', 'jinchan', 'xianhe', 'xingzhe', 'lianhua', 'moke'];
/* 旧 id（v2 八造型 + v3 的 11 原型×8 变体）仍允许入库，避免老账号记录的
 * 旧 avatar 字段在 setAvatar 时被正则拒掉。渲染时 avatar.js 会自动映射。 */
const LEGACY_IDS = '(?:loong|phoenix|qilin|baihu|xuanwu|jiuweihu|pixiu|jinchanchan|xianhe|xingzhe|xiantong)[0-7]|(?:fox|panda|cat|bear|rabbit|penguin|tiger|owl)';
const AVATAR_ID_RE = new RegExp('^(?:' + AV_PROTOS.join('|') + ')$|^(?:' + LEGACY_IDS + ')$');
const AVATARS = AV_PROTOS.map(id => ({ id, name: id }));
const COLORS = ['#ff6b6b', '#4f8cff', '#3ddc84', '#ffb03a', '#a06bff', '#20c9c9'];

const users = new Map();       // uid -> { uid, name, pass, salt, avatar, color, createdAt, lastSeen }
const guests = new Map();      // gid -> { gid, name, avatar, color, createdAt }

/* ══════════════════════════════════════════════════════════════════════════
 * v0.12.0（P0-1）登录态跨版本丢失 —— 根因与修复
 * --------------------------------------------------------------------------
 * 用户反馈：「登录后升级版本无法保留登录状态」。
 *
 * 老实现的 `sessions` 是**纯内存 Map**（token -> uid）。NAS / 安卓 / 鸿蒙
 * 每次升级必然重启 Node 进程，Map 一清，所有 token 立刻失效 ——
 * 前端虽然把 token 存在 localStorage 里，但服务端已经不认了，
 * 于是每个人升级完都静默掉回游客。这不是偶发 bug，是设计缺陷。
 *
 * 为什么不用「sessions 落盘」这种最直觉的补法：
 *   · 落盘文件会被高频写（每次登录/心跳都变），NAS 上磁盘 IO 无谓放大；
 *   · 多端同时登录时并发写有覆盖风险；
 *   · 还有一层更隐蔽的问题 —— 落盘的 token 是**明文长期凭证**，
 *     文件一旦被读到就等于永久登录权。
 *
 * 改用 **HMAC 签名 token（无状态会话）**：
 *     token = base64url(payload) + '.' + base64url(hmac_sha256(payload))
 *     payload = { u: uid, iat: 签发时间, exp: 过期时间 }
 *   · 服务端只校验签名与有效期，**不需要存任何东西** → 重启天然不失效；
 *   · 密钥 session.key 落盘一次（0600），重启后密钥不变 → 旧 token 继续有效；
 *   · 载荷是明文可读的（只有 uid 与时间，无敏感信息），签名保证不可篡改；
 *   · 有效期默认 180 天（家庭场景「装好就一直登着」），可 env 覆盖。
 *
 * 退出登录怎么办 —— 无状态 token 的经典难点：
 *   用一张**撤销名单**（内存 Set，只存被主动登出的 token 的签名摘要，
 *   附过期时间，到期自动清）。名单只在「主动退出」时增长，
 *   一天也涨不了几条，重启丢失的最坏后果是「已退出的旧 token 又能用了」，
 *   对家庭局域网可接受；真正的安全边界是 token 本身的 180 天有效期。
 * ══════════════════════════════════════════════════════════════════════════ */

const SESSION_TTL_MS = Number(process.env.HOMEARENA_SESSION_DAYS || 180) * 86400000;
const revoked = new Map();     // sig -> exp（主动登出的 token 摘要）

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s && s.length >= 32) return Buffer.from(s, 'hex');
  } catch (e) { /* 首次运行或文件丢失，下面重新生成 */ }
  const buf = crypto.randomBytes(32);
  try {
    fs.writeFileSync(SECRET_FILE, buf.toString('hex'), { mode: 0o600 });
    console.log('[account] 已生成会话密钥 session.key');
  } catch (e) {
    console.log('[account] 会话密钥落盘失败，本次运行使用临时密钥（重启后需重新登录）');
  }
  return buf;
}
const SECRET = loadSecret();

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function sign(payloadB64) { return b64u(crypto.createHmac('sha256', SECRET).update(payloadB64).digest()); }

function newToken(uid) {
  const now = Date.now();
  const payload = b64u(JSON.stringify({ u: uid, iat: now, exp: now + SESSION_TTL_MS, j: crypto.randomBytes(4).toString('hex') }));
  return payload + '.' + sign(payload);
}

function resolve(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // 定长比较，避免签名被逐字节试探
  const want = sign(payloadB64);
  if (want.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  } catch (e) { return null; }
  if (revoked.has(sig)) return null;
  let p;
  try { p = JSON.parse(unb64u(payloadB64).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.u || !p.exp || p.exp < Date.now()) return null;
  const u = users.get(p.u);
  if (!u) return null;
  // 滚动续期：剩余不足 1/3 时向前端下发新 token（见 index.js account:refresh）
  return u;
}

/** 判断某个 token 是否「快过期」，需要客户端换新 */
function needsRefresh(token) {
  const dot = String(token || '').indexOf('.');
  if (dot <= 0) return false;
  try {
    const p = JSON.parse(unb64u(String(token).slice(0, dot)).toString('utf8'));
    return p && p.exp && (p.exp - Date.now()) < SESSION_TTL_MS / 3;
  } catch (e) { return false; }
}

function logout(token) {
  const dot = String(token || '').indexOf('.');
  if (dot <= 0) return;
  const sig = token.slice(dot + 1);
  let exp = Date.now() + SESSION_TTL_MS;
  try { exp = JSON.parse(unb64u(token.slice(0, dot)).toString('utf8')).exp || exp; } catch (e) { }
  revoked.set(sig, exp);
  // 顺手清掉已过期的撤销项，名单不会无限长
  const now = Date.now();
  for (const [k, v] of revoked) if (v < now) revoked.delete(k);
}

function normalizeName(n) { return String(n || '').trim().slice(0, 16); }

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 64).toString('hex');
}

function pickAvatar(seed) {
  const h = crypto.createHash('md5').update(String(seed)).digest();
  const id = AV_PROTOS[h[0] % AV_PROTOS.length];
  return { avatar: id, color: COLORS[h[2] % COLORS.length] };
}

function save() {
  try {
    const payload = { v: 1, at: Date.now(), users: [...users.values()] };
    fs.writeFileSync(USERS_FILE, JSON.stringify(payload));
  } catch (e) { /* 落盘失败不影响登录 */ }
}
let saveTimer = null;
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1500); }

function load() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const p = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const u of (p.users || [])) users.set(u.uid, u);
    console.log(`[account] 已载入账号 ${users.size} 个`);
  } catch (e) { /* 文件损坏则重来 */ }
}
load();

function publicUser(u) {
  if (!u) return null;
  return { uid: u.uid, name: u.name, avatar: u.avatar, color: u.color, createdAt: u.createdAt, lastSeen: u.lastSeen || 0 };
}

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/;

function register(name, pass) {
  const n = normalizeName(name);
  if (!NAME_RE.test(n)) return { ok: false, msg: '昵称需 2-16 位，仅中英文、数字、下划线' };
  if (!pass || String(pass).length < 4) return { ok: false, msg: '密码至少 4 位' };
  for (const u of users.values()) if (u.name.toLowerCase() === n.toLowerCase()) return { ok: false, msg: '昵称已被占用' };
  const salt = crypto.randomBytes(16).toString('hex');
  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  const look = pickAvatar(uid);
  const u = { uid, name: n, salt, pass: hashPass(pass, salt), avatar: look.avatar, color: look.color, createdAt: Date.now(), lastSeen: Date.now() };
  users.set(uid, u); scheduleSave();
  return { ok: true, user: publicUser(u), token: newToken(uid) };
}

function login(name, pass) {
  const n = normalizeName(name);
  let hit = null;
  for (const u of users.values()) if (u.name.toLowerCase() === n.toLowerCase()) { hit = u; break; }
  if (!hit) return { ok: false, msg: '账号不存在' };
  const calc = Buffer.from(hashPass(pass, hit.salt), 'hex');
  const want = Buffer.from(hit.pass, 'hex');
  if (calc.length !== want.length || !crypto.timingSafeEqual(calc, want)) return { ok: false, msg: '密码错误' };
  hit.lastSeen = Date.now(); scheduleSave();
  return { ok: true, user: publicUser(hit), token: newToken(hit.uid) };
}

function guest(name) {
  const gid = 'g_' + crypto.randomBytes(5).toString('hex');
  const n = normalizeName(name) || ('游客' + gid.slice(2, 5).toUpperCase());
  const look = pickAvatar(gid);
  const g = { gid, name: n, avatar: look.avatar, color: look.color, guest: true, createdAt: Date.now() };
  guests.set(gid, g);
  return { ok: true, user: { uid: gid, name: g.name, avatar: g.avatar, color: g.color, guest: true, createdAt: g.createdAt } };
}

function setAvatar(uid, avatar, color) {
  const u = users.get(uid) || guests.get(uid);
  if (!u) return { ok: false, msg: '用户不存在' };
  if (avatar != null && !AVATAR_ID_RE.test(String(avatar))) return { ok: false, msg: '形象 ID 不合法' };
  if (avatar && AVATAR_ID_RE.test(String(avatar))) u.avatar = avatar;
  if (color && COLORS.includes(color)) u.color = color;
  if (users.has(uid)) scheduleSave();
  const base = users.has(uid) ? publicUser(u) : { uid, name: u.name, avatar: u.avatar, color: u.color, guest: true };
  return { ok: true, user: base };
}

function rename(uid, name) {
  const n = normalizeName(name);
  if (!NAME_RE.test(n)) return { ok: false, msg: '昵称需 2-16 位，仅中英文、数字、下划线' };
  for (const u of users.values()) if (u.uid !== uid && u.name.toLowerCase() === n.toLowerCase()) return { ok: false, msg: '昵称已被占用' };
  const u = users.get(uid) || guests.get(uid);
  if (!u) return { ok: false, msg: '用户不存在' };
  u.name = n;
  if (users.has(uid)) scheduleSave();
  return { ok: true };
}

/** v0.12.0：改密码。旧 token 不主动失效（家庭场景），改完立刻给一个新 token。 */
function changePass(uid, oldPass, newPass) {
  const u = users.get(uid);
  if (!u) return { ok: false, msg: '用户不存在' };
  const calc = Buffer.from(hashPass(oldPass, u.salt), 'hex');
  const want = Buffer.from(u.pass, 'hex');
  if (calc.length !== want.length || !crypto.timingSafeEqual(calc, want)) return { ok: false, msg: '原密码错误' };
  if (!newPass || String(newPass).length < 4) return { ok: false, msg: '新密码至少 4 位' };
  u.salt = crypto.randomBytes(16).toString('hex');
  u.pass = hashPass(newPass, u.salt);
  scheduleSave();
  return { ok: true, token: newToken(uid) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * v0.18.0（R6-3）管理中心：管理员对玩家账号的绝对管理权
 * 用户要求：「管理员可以增加或修改删除玩家信息」「游戏导入权仅管理员一人」。
 * 服务端为唯一事实源：所有函数都由 index.js 的 admin:* socket 事件调用，
 * 调用前已通过 isAdminUid 鉴权（见 index.js adminOf）。
 * ══════════════════════════════════════════════════════════════════════════ */
function adminListUsers() {
  return [...users.values()].map(u => ({
    ...publicUser(u), guest: false,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function adminListGuests() {
  return [...guests.values()].map(g => ({
    uid: g.gid, name: g.name, avatar: g.avatar, color: g.color,
    createdAt: g.createdAt, lastSeen: 0, guest: true,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
/** 管理员改名：复用 rename（占用校验保留，防止撞名） */
function adminRename(uid, name) { return rename(uid, name); }
/** 管理员重置密码：无需旧密码（管理员绝对权限），重置后旧 token 不主动失效
 *  （家庭场景；如需立即踢出可配合 deleteUser 重建）。 */
function adminResetPass(uid, newPass) {
  const u = users.get(uid);
  if (!u) return { ok: false, msg: '账号不存在（游客无需密码）' };
  if (!newPass || String(newPass).length < 4) return { ok: false, msg: '新密码至少 4 位' };
  u.salt = crypto.randomBytes(16).toString('hex');
  u.pass = hashPass(newPass, u.salt);
  scheduleSave();
  return { ok: true };
}
/** 管理员新增玩家（注册权收归管理员后的补充通道）：直接建号，返回初始密码说明 */
function adminCreateUser(name, pass) {
  const r = register(name, pass || ('ha' + crypto.randomBytes(3).toString('hex')));
  return r;
}
/** 管理员删除账号。注册账号硬删（token 因 users.get() 落空自动失效）；
 *  游客本就不落盘，从内存清掉即可。 */
function adminDeleteUser(uid) {
  if (users.delete(uid)) { scheduleSave(); return { ok: true }; }
  if (guests.delete(uid)) return { ok: true };
  return { ok: false, msg: '用户不存在' };
}
/** 清空游客身份库（游客只在内存，重进会再生成新身份） */
function adminClearGuests() {
  const n = guests.size;
  guests.clear();
  return { ok: true, removed: n };
}

module.exports = {
  AVATARS, COLORS, register, login, logout, resolve, guest, setAvatar, rename, changePass,
  publicUser, newToken, needsRefresh, SESSION_TTL_MS,
  users, guests, USERS_FILE, SECRET_FILE,
  adminListUsers, adminListGuests, adminRename, adminResetPass, adminCreateUser, adminDeleteUser, adminClearGuests,
};
