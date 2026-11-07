// DouZero 超人级牌类 AI 桥 + 智囊(advisor)模式
// 真实接口：向 DOUZERO_URL（自托管 DouZero / 等价服务）POST 局面，取回走法。
// 未配置或不可达时 suggest() 返回 null，调用方回落到内置启发式（保证可运行）。
// 智囊模式与超人模式共用同一服务：建议(hint)给人类玩家时即调用 suggest()。
const URL = process.env.DOUZERO_URL || '';

function serialize(game, state, seat) {
  if (game === 'doudizhu') {
    const hand = state.hands[seat].map(c => c.v);
    const others = state.hands.filter((_, i) => i !== seat).map(h => h.length);
    return {
      game, hand, others,
      landlord: state.landlord,
      last: state.lastPlay ? { combo: state.lastPlay.combo, seat: state.lastPlay.seat } : null,
      leadBy: state.leadBy, isLead: state.leadBy === seat || !state.lastPlay,
    };
  }
  // 其它牌类（掼蛋/麻将）暂由启发式处理；此处返回空以触发降级
  return null;
}
async function post(path, body) {
  if (!URL) return null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
/* v0.11.0（R4-1）：把「配置了 URL」和「服务真的活着」区分开。
 * ------------------------------------------------------------------
 * 原来 available() 只 return !!URL —— 这只是「管理员填了环境变量」，
 * 不代表服务在跑。后果：用户在设置里选「超神」，界面声称是神经网络，
 * 实际每一手都在走启发式，而且没人知道降级发生了。
 *
 * 这里加一个**带 TTL 的健康探测**：GET /health（DouZero 官方服务、
 * 自建 FastAPI 包装通常都带；也可用 /ping）。探不通就标记 offline，
 * probe 结果缓存 30s，避免每次出牌都多打一个 RTT。 */
const PROBE_TTL = 30000;
let probedAt = 0;          // 上次探测时间
let probedOk = false;      // 上次探测结果
let lastLatency = null;    // 探测往返毫秒（给运维看）

async function probe(force) {
  if (!URL) return { configured: false, online: false, url: '', latency: null };
  const now = Date.now();
  if (!force && probedAt && now - probedAt < PROBE_TTL) {
    return { configured: true, online: probedOk, url: URL, latency: lastLatency };
  }
  probedAt = now;
  probedOk = false;
  lastLatency = null;
  for (const p of ['/health', '/ping', '/']) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 1200);
      const r = await fetch(URL + p, { method: 'GET', signal: ctrl.signal });
      clearTimeout(to);
      if (r.status < 500) {          // 200/401/404 都说明端口有人应答
        probedOk = true;
        lastLatency = Date.now() - t0;
        break;
      }
    } catch (e) { /* 换下一个路径 */ }
  }
  return { configured: true, online: probedOk, url: URL, latency: lastLatency };
}

/* 真正的「这一手能不能交给神经网络」判断：配置 + 在线。
 * 用同步签名（读缓存）给渲染/状态上报用，不阻塞出牌路径。 */
function usable() { return !!URL && probedOk; }
function status() {
  return {
    configured: !!URL,
    online: !!URL && probedOk,
    url: URL,
    latency: lastLatency,
    probedAt: probedAt || null,
    /* v0.20.0（R8-2）：文案从「被动告示」改为「主动状态」——内置引擎是一等
     * 公民（默认），DouZero 只是可选增强，不再让用户觉得缺了什么。 */
    hint: !URL
      ? '内置引擎已就绪（默认）· DouZero 未接入，可作可选增强'
      : (probedOk ? 'DouZero 已就绪：开启「DouZero 增强」后超人档走神经网络' : 'DouZero 已配置但不可达：超人档自动使用内置引擎'),
  };
}
// 返回 {type:'play', cards:[ids]} | {type:'pass'} | null
async function suggest(game, state, seat) {
  const body = serialize(game, state, seat); if (!body) return null;
  const res = await post('/predict', body); if (!res) return null;
  if (res.action === 'pass' || res.pass) return { type: 'pass' };
  if (Array.isArray(res.cards) && res.cards.length) {
    const vs = res.cards; const ids = []; const used = new Set();
    for (const v of vs) { const c = state.hands[seat].find(x => x.v === v && !used.has(x.id)); if (c) { ids.push(c.id); used.add(c.id); } }
    if (ids.length === vs.length) return { type: 'play', cards: ids };
  }
  return null;
}
module.exports = { available: () => !!URL, usable, probe, status, suggest };
