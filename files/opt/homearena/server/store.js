// 存储层（v0.4.4）
// 1) 房间：内存 Map（热数据）；可选持久化到磁盘，Hub 重启后可恢复
// 2) 战绩：按 pid 累计，落盘保存
// 3) 可选 Redis：设置 REDIS_URL 且已安装 ioredis 时用它承载战绩（未安装则自动退回文件持久化）
const fs = require('fs');
const path = require('path');
const rating = require('./rating');

// 数据目录优先级：
//   1) TRIM_PKGVAR（飞牛 fnOS 运行时数据目录 /var/apps/homearena/var）—— 升级/重装不丢数据
//   2) HOMEARENA_DATA（自定义，便于本地调试）
//   3) <server>/data（本地开发兜底）
// 注意：绝不能只写在包内目录，否则应用升级会覆盖掉用户战绩。
const DATA_DIR = (() => {
  const cand = process.env.TRIM_PKGVAR || process.env.HOMEARENA_DATA || path.join(__dirname, 'data');
  try { fs.mkdirSync(cand, { recursive: true }); } catch (e) { }
  return cand;
})();
const DATA_FILE = path.join(DATA_DIR, 'arena.json');

const rooms = new Map();
const stats = new Map();          // pid -> { name, games, wins, losses, draws, byGame: {} }
const disconnected = new Map();   // pid -> { roomCode, seat, at }  断线宽限期，用于重连回座

/* ---------------- 可选 Redis ---------------- */
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    redis = new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', () => { /* 静默降级：Redis 不可用时退回文件持久化 */ });
    console.log('[store] Redis 已配置：' + process.env.REDIS_URL);
  } catch (e) {
    console.log('[store] 未安装 ioredis，使用文件持久化（Redis 可选）');
    redis = null;
  }
}

/* ---------------- 战绩 ---------------- */
function statOf(pid) {
  if (!stats.has(pid)) stats.set(pid, { games: 0, wins: 0, losses: 0, draws: 0, byGame: {}, seq: [] });
  const s = stats.get(pid);
  if (!s.byGame) s.byGame = {};
  if (!s.seq) s.seq = [];              // 最近对局序列（用于趋势图），最多保留 30 条
  return s;
}
/* ═══════════════════════════════════════════════════════════════════════
 * v0.12.0（R2-2）真实 Elo 积分
 * -----------------------------------------------------------------------
 * 老 store 只记 games/wins/losses 这些**计数**，没有任何「水平」维度，
 * 于是前端只能拿局数硬凑段位（levelOf 那套），看起来就假。
 *
 * 现在 recordResult 多接收一个 `ratings` 参数：
 *   ratings = { [pid]: { delta, rating, before, exp } }   ← rating.js 算好的
 * 并在 s.byGame[game] 里维护 rating / peak / games / lastDelta。
 * 计分本身不在这里做 —— 因为真实 Elo 需要「同桌所有对手的分」，
 * 只有 index.js 的 recordGame 才有这个视野。store 只负责落账。
 * 这样拆分的好处：离线单机版（无对手概念）可以不传 ratings，
 * 行为与旧版完全一致，不会因缺字段把分数写坏。
 * ═══════════════════════════════════════════════════════════════════════ */
function recordResult(pid, gameId, outcome, meta) {   // outcome: 'win' | 'loss' | 'draw'
  const s = statOf(pid);
  /* v0.12.0（R2-3）：排行榜要显示名字/头像，但老 store 只存计数，
   * 前端每次都得另去 account 查一遍。这里落账时顺手把身份字段更新一遍
   * （改名/换头像后下次对局即生效，不需要额外事件同步）。 */
  if (meta) {
    if (meta.name) s.name = String(meta.name).slice(0, 24);
    if (meta.avatar != null) s.avatar = meta.avatar;
    if (meta.color != null) s.color = meta.color;
    if (meta.guest != null) s.guest = !!meta.guest;
  }
  s.games++;
  if (outcome === 'win') { s.wins++; s.streak = (s.streak || 0) > 0 ? s.streak + 1 : 1; s.best = Math.max(s.best || 0, s.streak); }
  else if (outcome === 'loss') { s.losses++; s.streak = (s.streak || 0) < 0 ? s.streak - 1 : -1; }
  else { s.draws++; s.streak = 0; }
  s.byGame[gameId] = s.byGame[gameId] || { games: 0, wins: 0, losses: 0, draws: 0 };
  s.byGame[gameId].games++;
  s.byGame[gameId][outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws']++;
  /* v0.12.0：积分落账。ratings 里带这个 pid 才更新，否则跳过（兼容离线版）。 */
  let delta = 0, nowRating = null;
  if (meta && meta.ratings && meta.ratings[pid]) {
    const r = meta.ratings[pid];
    delta = r.delta || 0;
    nowRating = r.rating;
    const g = s.byGame[gameId];
    if (!g.everRated) { g.rating = r.before || rating.BASE; g.peak = r.before || rating.BASE; g.everRated = true; }
    g.rating = Math.round(r.rating);
    g.peak = Math.max(g.peak || g.rating, g.rating);
    g.lastDelta = delta;
  }
  s.seq.push({ g: gameId, o: outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : 'D', t: Date.now(), d: delta });
  if (s.seq.length > 30) s.seq = s.seq.slice(-30);
  // 对局明细（战绩详情页用）：对手、房号、手数、耗时
  if (!s.history) s.history = [];
  s.history.push({
    g: gameId,
    o: outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : 'D',
    t: Date.now(),
    opp: (meta && meta.opp) || '—',
    rc: (meta && meta.rc) || '',
    n: (meta && meta.n) || 0,
    dur: (meta && meta.dur) || 0,
    d: delta,                    // 本局积分增减（前端表格里显示 +12 / -8）
    r: nowRating != null ? nowRating : undefined,
  });
  if (s.history.length > 60) s.history = s.history.slice(-60);
  s.lastPlayed = Date.now();
  scheduleSave();
  if (redis) { try { redis.set('ha:stat:' + pid, JSON.stringify(s)).catch(() => { }); } catch (e) { } }
  return s;
}

// 大厅用：精简战绩（不把完整 seq 全量下发，只给最近 12 条）
function publicStatOf(pid) {
  const s = statOf(pid);
  return {
    games: s.games, wins: s.wins, losses: s.losses, draws: s.draws,
    streak: s.streak || 0, best: s.best || 0,
    byGame: s.byGame || {},
    seq: (s.seq || []).slice(-12),
    lastPlayed: s.lastPlayed || 0,
    ...ratingSummary(s),
  };
}

/** v0.12.0：把分散在各游戏的 rating 汇总成「主分 + 段位 + 分项」 */
function ratingSummary(s) {
  const list = Object.entries(s.byGame || {})
    .filter(([, v]) => v.games > 0)
    .map(([g, v]) => ({
      g, games: v.games,
      rating: v.everRated ? (v.rating || rating.BASE) : rating.BASE,
      peak: v.peak || rating.BASE,
      lastDelta: v.lastDelta || 0,
      rated: !!v.everRated,
      tier: rating.tierOf(v.everRated ? v.rating : rating.BASE, v.games),
    }))
    .sort((a, b) => b.games - a.games);
  /* 主分取「局数最多的那个游戏」，而不是加权平均：
   * 加权平均会让「只打过一局的象棋」把斗地主的主力分拉平，
   * 用户看到的段位就和自己最上心的那个游戏对不上。 */
  const main = list.find(x => x.rated) || list[0] || null;
  const mainRating = main ? main.rating : rating.BASE;
  const totalGames = main ? main.games : 0;
  return {
    rating: mainRating,
    ratingGame: main ? main.g : null,
    peak: list.reduce((m, x) => Math.max(m, x.peak), rating.BASE),
    tier: rating.tierOf(mainRating, totalGames),
    ratings: list,
  };
}

// 战绩详情页：完整汇总 + 最近 40 局明细
function detailStatOf(pid) {
  const s = statOf(pid);
  const rate = s.games ? Math.round((s.wins / s.games) * 100) : 0;
  const byGame = Object.entries(s.byGame || {}).map(([g, v]) => ({
    g, games: v.games, wins: v.wins, losses: v.losses, draws: v.draws,
    rate: v.games ? Math.round((v.wins / v.games) * 100) : 0,
  })).sort((a, b) => b.games - a.games);
  const sum = ratingSummary(s);
  return {
    games: s.games, wins: s.wins, losses: s.losses, draws: s.draws, rate,
    streak: s.streak || 0, best: s.best || 0, lastPlayed: s.lastPlayed || 0,
    byGame: byGame.map(v => {
      const r = sum.ratings.find(x => x.g === v.g);
      return { ...v, rating: r ? r.rating : null, tier: r ? r.tier : null, peak: r ? r.peak : null, lastDelta: r ? r.lastDelta : 0 };
    }),
    history: (s.history || []).slice(-40).reverse(),
    seq: (s.seq || []).slice(-20),
    rating: sum.rating, ratingGame: sum.ratingGame, peak: sum.peak, tier: sum.tier, ratings: sum.ratings,
    ratingGames: (sum.ratings.find(x => x.g === sum.ratingGame) || {}).games || 0,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * v0.12.0（R2-1）牌谱留存
 * ----------------------------------------------------------------------
 * 之前的复盘只能看「当前房间」，退出即丢；而牌谱的价值恰恰在事后翻看。
 * 这里按 pid 保留最近 REPLAY_KEEP 局（默认 20），每局只存结构化摘要 + 文本，
 * **不存原始 state** —— 一手牌局 state 可能几十 KB，20 局就能把 arena.json
 * 撑到几 MB，NAS 上每次 scheduleSave 都要全量序列化，代价太大。
 * 需要完整 JSON 时由 replay.js 从当前房间实时生成。
 * ══════════════════════════════════════════════════════════════════════ */
const REPLAY_KEEP = Number(process.env.HOMEARENA_REPLAY_KEEP || 20);

function saveReplay(pid, rp) {
  if (!pid || !rp) return;
  const s = statOf(pid);
  if (!s.replays) s.replays = [];
  // 同一房间同一局不重复记（重连可能触发二次结算）
  const key = rp.code + '#' + rp.round;
  if (s.replays.some(x => (x.code + '#' + x.round) === key)) return;
  s.replays.push({
    id: key,
    code: rp.code, game: rp.game, gameLabel: rp.gameLabel,
    round: rp.round, at: rp.at, result: rp.result, winners: rp.winners,
    totalMoves: rp.totalMoves,
    seats: rp.seats,
    moves: rp.moves.map(m => ({ n: m.n, seat: m.seat, who: m.who, text: m.text })),
  });
  if (s.replays.length > REPLAY_KEEP) s.replays = s.replays.slice(-REPLAY_KEEP);
  scheduleSave();
}

function listReplays(pid) {
  const s = statOf(pid);
  return (s.replays || []).slice().reverse().map(x => ({
    id: x.id, code: x.code, game: x.game, gameLabel: x.gameLabel,
    round: x.round, at: x.at, result: x.result, totalMoves: x.totalMoves,
  }));
}

function getReplay(pid, id) {
  const s = statOf(pid);
  return (s.replays || []).find(x => x.id === id) || null;
}

/* ══════════════════════════════════════════════════════════════════════
 * v0.12.0（R2-3）家庭排行榜
 * ----------------------------------------------------------------------
 * 「家庭排行榜」和「公开天梯」是两件事：
 *   · 公开天梯要比「绝对水平」，得防刷、得有人口基数、得有反作弊，
 *     一家人打牌根本不需要这些，反而会因为人少而分数剧烈震荡。
 *   · 家庭榜要的是「这周谁最能打」「谁被虐得最惨」—— 好玩、有话题、
 *     能让一家人围着一台 NAS 吵起来，这才是留存的关键。
 *
 * 所以两套榜分开算，口径写死在这里：
 *   week  周榜：本周一 00:00 起算，按【胜场】降序，胜场相同比【胜率】，
 *               再相同比【对局数】。用胜场不用积分 —— 一周内积分波动小，
 *               胜场更直观且天然向好动的人倾斜。
 *   all   总榜：全部历史，按【主力游戏 Elo 分】降序，同分比总胜场。
 *
 * 过滤规则：
 *   · AI 座位不进榜（stats 里根本没有 AI 的 pid）
 *   · 游客（g_ 前缀 / guest 标记）不进正式榜，单列 guests，避免
 *     「用游客身份反复刷」把榜搞乱
 *   · 一局没打的人不进榜（games === 0），否则新注册用户全挂在末尾
 * ══════════════════════════════════════════════════════════════════════ */
function weekStart(now) {
  // 以周一 00:00 为界（中国习惯周一为一周之始）
  const d = new Date(now || Date.now());
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;      // 周一=0 … 周日=6
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function leaderboard(scope) {
  const mode = scope === 'all' ? 'all' : 'week';
  const since = weekStart();
  const rows = [], guests = [];

  for (const [pid, s] of stats) {
    if (!s || !s.games) continue;
    const ident = identityOf(pid, s);
    const isGuest = ident.guest || /^g_/.test(pid);
    const sum = ratingSummary(s);
    // 本周切片：只数 history 里落在本周的
    let wg = 0, ww = 0, wl = 0, wd = 0;
    for (const h of (s.history || [])) {
      if (h.t < since) continue;
      wg++;
      if (h.o === 'W') ww++; else if (h.o === 'L') wl++; else wd++;
    }
    const rec = {
      pid,
      name: ident.name,
      avatar: ident.avatar,
      color: ident.color,
      rating: sum.rating,
      ratingGame: sum.ratingGame,
      tier: sum.tier,
      games: s.games,
      wins: s.wins || 0,
      losses: s.losses || 0,
      draws: s.draws || 0,
      rate: s.games ? Math.round((s.wins / s.games) * 100) : 0,
      weekGames: wg, weekWins: ww, weekLosses: wl, weekDraws: wd,
      weekRate: wg ? Math.round((ww / wg) * 100) : 0,
      lastPlayed: s.lastPlayed || 0,
    };
    if (isGuest) guests.push(rec); else rows.push(rec);
  }

  const cmp = mode === 'week'
    ? (a, b) => (b.weekWins - a.weekWins) || (b.weekRate - a.weekRate) || (b.weekGames - a.weekGames) || (b.lastPlayed - a.lastPlayed)
    : (a, b) => (b.rating - a.rating) || (b.wins - a.wins) || (b.rate - a.rate) || (b.lastPlayed - a.lastPlayed);

  rows.sort(cmp);
  guests.sort(cmp);
  // 周榜里一局未打的人不该占位（他们只是「本周没来」，不是「排最后」）
  const listed = mode === 'week' ? rows.filter(r => r.weekGames > 0) : rows;
  listed.forEach((r, i) => { r.rank = i + 1; });
  guests.forEach((r, i) => { r.rank = i + 1; });

  return {
    scope: mode,
    since: mode === 'week' ? since : 0,
    total: listed.length,
    rows: listed.slice(0, 50),
    guests: guests.slice(0, 20),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * v0.12.0（R2-3）身份回填
 * ----------------------------------------------------------------------
 * 老版本的 store 只存计数，不存名字 —— 于是升级到 v0.12.0 后，
 * 历史战绩里所有人的显示名都是「玩家」，排行榜一屏「玩家 玩家 玩家」，
 * 比不显示还难看。这里在**读取时**从账号库回填，不回写磁盘：
 *   · 名字/头像本来就在 account.js 里是唯一事实源，store 抄一份很容易过期
 *   · 回填只在读取路径上做一次对象合并，代价可忽略
 * 用惰性 require 是为了避开 store ↔ account 的循环依赖
 * （account.js 在初始化时不依赖 store，但 index.js 两个都 require）。
 * ══════════════════════════════════════════════════════════════════════ */
let _account = null;
function accountLib() {
  if (_account === null) { try { _account = require('./account'); } catch (e) { _account = false; } }
  return _account || null;
}
function identityOf(pid, s) {
  const out = {
    // 兜底名用「牌友+pid尾号」：纯 pid 的匿名玩家（没登录也没报过名字）
    // 不该显示成一排一模一样的「玩家」，可读且互不重名
    name: (s && s.name) || ('牌友' + String(pid || '').slice(-4)),
    avatar: s && s.avatar != null ? s.avatar : null,
    color: s && s.color != null ? s.color : null,
    guest: !!(s && s.guest),
  };
  const ac = accountLib();
  if (ac) {
    const u = ac.users.get(pid) || ac.guests.get(pid);
    if (u) {
      // 账号库里的名字是权威值：改名后立刻生效，不用等下一局
      if (u.name) out.name = u.name;
      if (u.avatar != null) out.avatar = u.avatar;
      if (u.color != null) out.color = u.color;
      out.guest = !!u.guest || /^g_/.test(pid);
    }
  }
  if (!out.name) out.name = out.guest ? '游客' : '玩家';
  return out;
}

/* ---------------- 持久化 ---------------- */
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 2000);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      v: 1, at: Date.now(),
      stats: [...stats.entries()],
      rooms: [...rooms.values()].map(r => ({
        code: r.code, game: r.game, name: r.name, visibility: r.visibility,
        hasPassword: !!r.password, createdAt: r.createdAt,
        seats: r.seats.map(s => ({ type: s.type, aiLevel: s.aiLevel, name: s.name, pid: s.pid })),
        spectators: r.spectators, chat: r.chat.slice(-20),
        finished: !!(r.state && (r.state.winner != null || r.state.draw)),
      })),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload));
  } catch (e) { /* 持久化失败不影响运行 */ }
}
function loadNow() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const p = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [k, v] of (p.stats || [])) stats.set(k, v);
    console.log(`[store] 已载入战绩 ${stats.size} 条`);
  } catch (e) { /* 忽略损坏文件 */ }
}
loadNow();

/* ---------------- 断线宽限 ----------------
 * R32 / v0.43.0：保座记录带 boot（一次页面加载的唯一标识）。
 * 用户原话：「杀后台重新进入后依然直接重新进入 H5、cocos 游戏」。
 * socket.io 的自动重连发生在同一页面内（boot 不变），该保座才成立；
 * 杀掉后台重新打开 App 会重新加载页面 → 新 boot → 绝不允许按旧记录
 * 把用户硬塞回房间。旧逻辑只认 90 秒时间窗，无论重开几次都会回填
 * room:state，前端 onRoom 一渲染就又进游戏，体感就是「退不出去」。 */
const GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 90000);
function markDisconnected(pid, roomCode, seat, boot) {
  disconnected.set(pid, { roomCode, seat, at: Date.now(), boot: boot || null });
}
function takeReconnect(pid, boot) {
  const d = disconnected.get(pid);
  if (!d) return null;
  /* boot 双方都有且不同 = 新页面会话，丢弃保座，不自动回房 */
  if (d.boot && boot && d.boot !== boot) { disconnected.delete(pid); return null; }
  disconnected.delete(pid);
  return Date.now() - d.at <= GRACE_MS ? d : null;
}
/* v0.30.0（R18-1）：主动退出房间 = 放弃重连保座。
 * 不清这条记录的话，退房后 90 秒内任何一次 socket 重连都会把用户
 * 按旧记录拉回原房（观战者场景 = 「退不出去，反复自动进入」）。 */
function clearDisconnected(pid) { if (pid) disconnected.delete(pid); }
function sweepDisconnected() {
  const now = Date.now();
  for (const [pid, d] of disconnected) if (now - d.at > GRACE_MS) disconnected.delete(pid);
}
setInterval(sweepDisconnected, 30000).unref();
setInterval(saveNow, 60000).unref();

/** v0.16.0（R4-7）座位牌轻量档案：只给牌桌渲染用的几个数，不暴露精确分值。
 *  未打过任何牌的人返回 null（前端据此显示「新人」而不是「定级中 · 0 局」）。 */
function getProfile(pid) {
  if (!pid) return null;
  const s = stats.get(pid);
  if (!s || !s.games) return null;
  const sum = ratingSummary(s);
  return {
    games: s.games, wins: s.wins || 0, draws: s.draws || 0,
    tier: sum.tier, byGame: s.byGame || {},
  };
}

module.exports = {
  rooms, stats, statOf, publicStatOf, detailStatOf, getProfile, recordResult, saveNow, loadNow, ratingSummary,
  saveReplay, listReplays, getReplay, REPLAY_KEEP,
  leaderboard, weekStart,
  markDisconnected, takeReconnect, clearDisconnected, GRACE_MS, redis, DATA_FILE,
};
