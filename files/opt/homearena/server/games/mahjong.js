// 麻将（v0.4.4 增强版）：万/条/筒 108 张、发牌13、摸打、自摸/点炮
// 新增：碰 / 明杠 / 暗杠 / 加杠 / 吃（限上家）/ 听牌提示（tenpai 与待牌）
// 契约：createState / applyMove / ai / view / onTurnStart
// 回合流程：摸牌 → 打牌 →（其他家可碰杠吃胡）→ 下家摸牌
const SUITS = ['万', '条', '筒'];
let _mid = 0;
function t(s, r) { return { id: 'm' + (_mid++), s, r }; }

function buildWall() {
  const w = [];
  for (let s = 0; s < 3; s++) for (let r = 1; r <= 9; r++) for (let k = 0; k < 4; k++) w.push(t(s, r));
  for (let i = w.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[w[i], w[j]] = [w[j], w[i]]; }
  return w;
}

/* ---------------- 胡牌判定 ---------------- */
function isWinningHand(tiles) {
  if (tiles.length % 3 !== 2 || tiles.length < 2) return false;
  const cnt = {}; for (const x of tiles) { const k = x.s + '-' + x.r; cnt[k] = (cnt[k] || 0) + 1; }
  for (const p of Object.keys(cnt)) {
    if (cnt[p] >= 2) { const c2 = { ...cnt }; c2[p] -= 2; if (formMelds(c2)) return true; }
  }
  return false;
}
function formMelds(cnt) {
  const ks = Object.keys(cnt).filter(k => cnt[k] > 0).sort((a, b) => {
    const [as, ar] = a.split('-').map(Number); const [bs, br] = b.split('-').map(Number); return as - bs || ar - br;
  });
  if (ks.length === 0) return true;
  const k = ks[0]; const [s, r] = k.split('-').map(Number);
  if (cnt[k] >= 3) { cnt[k] -= 3; if (formMelds(cnt)) { cnt[k] += 3; return true; } cnt[k] += 3; }
  if (r <= 7) {
    const k1 = s + '-' + r, k2 = s + '-' + (r + 1), k3 = s + '-' + (r + 2);
    if (cnt[k1] && cnt[k2] && cnt[k3]) {
      cnt[k1]--; cnt[k2]--; cnt[k3]--;
      if (formMelds(cnt)) { cnt[k1]++; cnt[k2]++; cnt[k3]++; return true; }
      cnt[k1]++; cnt[k2]++; cnt[k3]++;
    }
  }
  return false;
}

/** 13 张（或 3n+1 张）手的待牌：返回能胡的牌型数组。que 为「缺门」花色下标（-1 = 不限制） */
function waitingTiles(hand, que) {
  if (hand.length % 3 !== 1) return [];
  // 手里还有缺门牌 → 必须先打完，不可能听牌
  if (que != null && que >= 0 && hand.some(t => t.s === que)) return [];
  const out = [];
  for (let s = 0; s < 3; s++) for (let r = 1; r <= 9; r++) {
    if (que != null && que >= 0 && s === que) continue;   // 缺门怎么能胡
    const probe = { id: 'probe', s, r };
    if (isWinningHand(hand.concat([probe]))) out.push({ s, r, label: r + SUITS[s] });
  }
  return out;
}

/** 14 张手：哪些打法能保持/进入听牌 */
function tingAdvice(hand, que) {
  if (hand.length % 3 !== 2) return [];
  if (que != null && que >= 0 && hand.some(t => t.s === que)) return [];  // 先打缺门
  const res = [];
  const uniq = new Map();
  for (const c of hand) if (!uniq.has(c.s + '-' + c.r)) uniq.set(c.s + '-' + c.r, c);
  for (const c of uniq.values()) {
    const rest = hand.filter(x => x.id !== c.id);
    const w = waitingTiles(rest, que);
    if (w.length) res.push({ tile: c.id, label: c.r + SUITS[c.s], waits: w });
  }
  return res;
}

/* ---------------- 建局 ---------------- */
/** v0.28.0（R16-6）四川「缺一门」：发牌后自动定缺（手牌最少的一门），
 *  定缺花色必须先打完才能胡 —— 与「胡牌时最多两门」等价，但玩家可感知、AI 可执行。 */
function queOf(hand) {
  const c = [0, 0, 0];
  for (const t of hand) c[t.s]++;
  let q = 0;
  for (let s = 1; s < 3; s++) if (c[s] < c[q]) q = s;
  return q;
}
function hasQue(state, seat, extra) {
  const q = state.que ? state.que[seat] : -1;
  if (!(q >= 0)) return false;
  if (state.hands[seat].some(t => t.s === q)) return true;
  if (extra && extra.s === q) return true;
  return (state.melds[seat] || []).some(m => (m.tiles || []).some(t => t.s === q));
}
/** 胡牌判定：牌型成立 + 缺一门约束 */
function canWin(state, seat, extra) {
  const hand = extra ? state.hands[seat].concat([extra]) : state.hands[seat];
  if (!isWinningHand(hand)) return false;
  if (state.variant !== 'sichuan') return true;
  return !hasQue(state, seat, extra);
}

function createState(rules) {
  const variant = rules && rules.variant === 'sichuan' ? 'sichuan' : 'classic';
  const wall = buildWall();
  const hands = [wall.slice(0, 13), wall.slice(13, 26), wall.slice(26, 39), wall.slice(39, 52)];
  const st = {
    phase: 'playing',           // playing | claim | ended
    current: 0, hands, wall: wall.slice(52),
    melds: [[], [], [], []],    // 公开的副露（碰/杠/吃）
    discards: [], lastDiscard: null, drawn: null,
    needDraw: true, claimQueue: [], winner: null, draw: false,
    winType: null, moves: [], turn: 0,
    variant,
    que: variant === 'sichuan' ? hands.map(queOf) : [-1, -1, -1, -1],
  };
  drawFor(st, 0); st.needDraw = false;
  return st;
}

function drawFor(state, seat) {
  if (state.wall.length === 0) { state.draw = true; state.phase = 'ended'; return null; }
  const tile = state.wall.pop();
  state.hands[seat].push(tile);
  state.drawn = tile.id;
  if (canWin(state, seat, null)) { state.winner = seat; state.winType = '自摸'; state.phase = 'ended'; }
  return tile;
}

function view(state, seat) {
  const hands = state.hands.map((h, i) =>
    i === seat ? h.slice().sort((a, b) => a.s - b.s || a.r - b.r) : { hidden: true, n: h.length });
  // 听牌提示只给自己看
  const que = state.variant === 'sichuan' ? (state.que ? state.que[seat] : -1) : -1;
  let ting = null, waits = null;
  const my = state.hands[seat];
  if (my && my.length % 3 === 2 && state.phase !== 'ended') ting = tingAdvice(my, que).slice(0, 8);
  if (my && my.length % 3 === 1 && state.phase !== 'ended') waits = waitingTiles(my, que);
  return { ...state, hands, _ownSeat: seat, ting, waits, myQue: que };
}

function onTurnStart(state, player) {
  if (state.phase === 'ended') return;
  state.turn++;
  if (state.phase === 'playing' && state.needDraw) { drawFor(state, player - 1); state.needDraw = false; }
}

/* ---------------- 副露 / 鸣牌 ---------------- */
function countSame(hand, s, r) { return hand.filter(c => c.s === s && c.r === r).length; }
function takeFromHand(hand, s, r, n) {
  const out = [];
  for (let i = 0; i < hand.length && out.length < n; i++) {
    if (hand[i].s === s && hand[i].r === r) { out.push(hand[i]); hand.splice(i, 1); i--; }
  }
  return out;
}

/** 计算某家对 lastDiscard 的可鸣牌（不含胡，胡在打牌时即时判定） */
function claimsFor(state, seat) {
  const d = state.lastDiscard;
  if (!d || d.seat === seat) return [];
  const hand = state.hands[seat];
  const out = [];
  if (countSame(hand, d.s, d.r) >= 3) out.push({ seat, kind: 'gang', tiles: [{ s: d.s, r: d.r }] });
  if (countSame(hand, d.s, d.r) >= 2) out.push({ seat, kind: 'peng', tiles: [{ s: d.s, r: d.r }] });
  // 吃：只能吃上家（(seat+3)%4 是本家的上家）
  if ((seat + 3) % 4 === d.seat) {
    const r = d.r;
    const combos = [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]];
    for (const [a, b] of combos) {
      if (a >= 1 && b <= 9 && countSame(hand, d.s, a) >= 1 && countSame(hand, d.s, b) >= 1) {
        out.push({ seat, kind: 'chi', tiles: [{ s: d.s, r: a }, { s: d.s, r: b }] });
      }
    }
  }
  return out;
}

const PRIO = { gang: 3, peng: 2, chi: 1 };
function buildClaimQueue(state, discarder) {
  const q = [];
  for (let k = 1; k < 4; k++) {
    const seat = (discarder + k) % 4;
    q.push(...claimsFor(state, seat));
  }
  // 优先级高者优先；同级按离打牌者的距离（近者优先）
  q.sort((a, b) => (PRIO[b.kind] - PRIO[a.kind]) || (((a.seat - discarder + 4) % 4) - ((b.seat - discarder + 4) % 4)));
  return q;
}

function removeLastDiscard(state) {
  const d = state.lastDiscard;
  if (!d) return null;
  // 从弃牌堆移除最后一张（被鸣牌取走）
  for (let i = state.discards.length - 1; i >= 0; i--) {
    const x = state.discards[i];
    if (x.seat === d.seat && x.s === d.s && x.r === d.r) { state.discards.splice(i, 1); break; }
  }
  const res = { s: d.s, r: d.r };
  state.lastDiscard = null;
  return res;
}

function doClaim(state, seat, claim) {
  const tile = removeLastDiscard(state);
  const used = takeFromHand(state.hands[seat], tile.s, tile.r, claim.kind === 'gang' ? 3 : claim.kind === 'peng' ? 2 : 0);
  const meldTiles = [...used, { s: tile.s, r: tile.r }];
  if (claim.kind === 'chi') {
    for (const ct of claim.tiles) { const g = takeFromHand(state.hands[seat], ct.s, ct.r, 1); meldTiles.unshift(...g); }
    meldTiles.sort((a, b) => a.s - b.s || a.r - b.r);
  }
  state.melds[seat].push({ kind: claim.kind === 'gang' ? '明杠' : claim.kind === 'peng' ? '碰' : '吃', tiles: meldTiles, from: tile });
  state.moves.push({ seat, type: claim.kind, s: tile.s, r: tile.r });
  state.claimQueue = [];
  state.phase = 'playing';
  // 杠后补摸一张（从牌墙尾），碰/吃后直接打牌
  if (claim.kind === 'gang') { drawFor(state, seat); state.needDraw = false; state.meldsNeedDiscard = false; }
  else { state.drawn = null; state.needDraw = false; state.meldsNeedDiscard = true; }
  if (state.winner != null) return { ok: true, next: null, done: true };
  return { ok: true, next: seat };
}

/* ---------------- 主入口 ---------------- */
function applyMove(state, move, player) {
  const seat = player - 1;
  if (state.phase === 'ended' || state.winner != null) return { ok: false, reason: 'ended' };
  if (state.current !== seat) return { ok: false, reason: 'noturn' };
  if (!move) return { ok: false, reason: 'badmove' };

  /* ---- 鸣牌应答阶段 ---- */
  if (state.phase === 'claim') {
    if (move.type === 'pass') {
      state.claimQueue.shift();
      if (state.claimQueue.length) {
        const nxt = state.claimQueue[0].seat;
        state.current = nxt; state.needDraw = false;
        return { ok: true, next: nxt };
      }
      // 无人鸣牌：正常流入下家摸牌
      const nx = (state.lastDiscardSeat != null ? state.lastDiscardSeat : seat) + 1;
      const next = nx % 4;
      state.phase = 'playing'; state.needDraw = true; state.current = next;
      return { ok: true, next };
    }
    if (move.type === 'claim') {
      const claim = state.claimQueue[0];
      if (!claim || claim.seat !== seat) return { ok: false, reason: 'notyourclaim' };
      if (move.kind && move.kind !== claim.kind) return { ok: false, reason: 'nomatch' };
      return doClaim(state, seat, claim);
    }
    return { ok: false, reason: 'badclaim' };
  }

  /* ---- 暗杠 / 加杠（自己回合） ---- */
  if (move.type === 'angang' || move.type === 'jiagang') {
    const tile = state.hands[seat].find(c => c.id === move.tile);
    if (!tile) return { ok: false, reason: 'notinyourhand' };
    const n = countSame(state.hands[seat], tile.s, tile.r);
    if (move.type === 'angang') {
      if (n < 4) return { ok: false, reason: 'need4' };
      const used = takeFromHand(state.hands[seat], tile.s, tile.r, 4);
      state.melds[seat].push({ kind: '暗杠', tiles: used });
      state.moves.push({ seat, type: 'angang', s: tile.s, r: tile.r });
    } else {
      const m = state.melds[seat].find(m => m.kind === '碰' && m.from && m.from.s === tile.s && m.from.r === tile.r);
      if (!m) return { ok: false, reason: 'nopeng' };
      const used = takeFromHand(state.hands[seat], tile.s, tile.r, 1);
      m.kind = '加杠'; m.tiles.push(...used);
      state.moves.push({ seat, type: 'jiagang', s: tile.s, r: tile.r });
    }
    drawFor(state, seat);   // 杠后补摸
    state.needDraw = false;
    state.drawn = state.hands[seat][state.hands[seat].length - 1].id;
    if (state.winner != null) return { ok: true, next: null, done: true };
    return { ok: true, next: seat };
  }

  /* ---- 打牌 ---- */
  if (move.type !== 'discard') return { ok: false, reason: 'baddiscard' };
  const idx = state.hands[seat].findIndex(c => c.id === move.tile);
  if (idx < 0) return { ok: false, reason: 'notinyourhand' };
  const [tile] = state.hands[seat].splice(idx, 1);
  state.drawn = null;
  state.meldsNeedDiscard = false;
  state.discards.push({ seat, s: tile.s, r: tile.r });
  state.lastDiscard = { seat, s: tile.s, r: tile.r };
  state.lastDiscardSeat = seat;
  state.moves.push({ seat, type: 'discard', s: tile.s, r: tile.r });

  // 点炮：有人能胡即胡（规则简化：自动和牌，家庭娱乐最常见设定）
  for (let k = 1; k < 4; k++) {
    const o = (seat + k) % 4;
    if (canWin(state, o, { s: tile.s, r: tile.r })) {
      state.winner = o; state.winType = '点炮'; state.phase = 'ended'; state.draw = false;
      return { ok: true, next: null, done: true };
    }
  }

  const q = buildClaimQueue(state, seat);
  if (q.length) {
    state.claimQueue = q;
    state.phase = 'claim';
    state.needDraw = false;
    const first = q[0].seat;
    state.current = first;
    return { ok: true, next: first };
  }
  const next = (seat + 1) % 4;
  state.phase = 'playing'; state.needDraw = true; state.current = next;
  return { ok: true, next };
}

/* ---------------- AI ---------------- */
function connectivity(hand, tile) {
  let c = 0;
  for (const o of hand) {
    if (o.id === tile.id) continue;
    if (o.s === tile.s) { if (o.r === tile.r) c += 3; else if (Math.abs(o.r - tile.r) <= 2) c += 2; }
  }
  return c;
}
function meldCount(state, seat) { return state.melds[seat].length; }

async function ai(state, player, level) {
  const seat = player - 1;
  const que = state.variant === 'sichuan' ? (state.que ? state.que[seat] : -1) : -1;

  // 鸣牌决策
  if (state.phase === 'claim') {
    const claim = state.claimQueue[0];
    if (claim && claim.seat === seat) {
      // 缺一门：缺门牌一律不鸣（碰了就得拆牌、还永远胡不了）
      if (que >= 0 && state.lastDiscard && state.lastDiscard.s === que) return { type: 'pass' };
      const mc = meldCount(state, seat);
      if (claim.kind === 'gang') return { type: 'claim', kind: 'gang' };
      if (claim.kind === 'peng') {
        // 已有多副露时更谨慎；否则碰（推进向听）
        if (mc < 3 || Math.random() < 0.6) return { type: 'claim', kind: 'peng' };
      }
      if (claim.kind === 'chi' && mc < 2 && Math.random() < 0.5) return { type: 'claim', kind: 'chi' };
      return { type: 'pass' };
    }
    return { type: 'pass' };
  }

  const hand = state.hands[seat];
  if (!hand || !hand.length) return null;

  // 缺一门：手上还有缺门牌，必须先打缺 —— 优先打最孤张的那张
  if (que >= 0) {
    const qs = hand.filter(c => c.s === que);
    if (qs.length) {
      qs.sort((a, b) => connectivity(hand, a) - connectivity(hand, b));
      return { type: 'discard', tile: qs[0].id };
    }
  }

  // 暗杠机会
  if (level !== 'fun') {
    for (const c of hand) if (countSame(hand, c.s, c.r) === 4) return { type: 'angang', tile: c.id };
  }

  // 听牌优先：选择能保持/进入听牌的打法
  const ting = tingAdvice(hand, que);
  if (ting.length) {
    // 打掉后待牌最多者
    ting.sort((a, b) => b.waits.length - a.waits.length);
    return { type: 'discard', tile: ting[0].tile };
  }

  let best = hand[0], bestC = Infinity;
  for (const tile of hand) {
    /* 缺一门下即便没听牌，也尽量把缺门牌往外扔（上面已处理）；
       其余情况保持原启发式：打最孤张。 */
    const c = connectivity(hand, tile) + (level === 'fun' ? Math.random() * 2 : 0);
    if (c < bestC) { bestC = c; best = tile; }
  }
  return { type: 'discard', tile: best.id };
}

module.exports = {
  label: '麻将', seats: 4, createState, applyMove, ai, view, onTurnStart,
  SUITS, isWinningHand, waitingTiles, tingAdvice, canWin, queOf,
};
