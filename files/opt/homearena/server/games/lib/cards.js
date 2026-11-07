// 共享扑克牌型库（斗地主 / 掼蛋 复用）
// 牌值约定：3..10 -> 3..10, J=11, Q=12, K=13, A=14, 2=15, 小王=16, 大王=17
const RANK_LABEL = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '🃏', 17: '🃏' };
const SUITS = ['♠', '♥', '♣', '♦'];

let _id = 0;
function card(v, suit) { return { id: 'c' + (_id++), v, suit: suit || '' }; }

function makeDeck54() {
  const d = [];
  for (let v = 3; v <= 15; v++) for (let s = 0; s < 4; s++) d.push(card(v, SUITS[s]));
  d.push(card(16)); d.push(card(17));
  return shuffle(d);
}
// 掼蛋：两副牌 108 张（含大小王各 4 张）
function makeDeck108() {
  const d = [];
  for (let deck = 0; deck < 2; deck++) for (let v = 3; v <= 15; v++) for (let s = 0; s < 4; s++) d.push(card(v, SUITS[s]));
  for (let deck = 0; deck < 2; deck++) { d.push(card(16)); d.push(card(17)); }
  return shuffle(d);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function counts(cards) { const m = {}; for (const c of cards) m[c.v] = (m[c.v] || 0) + 1; return m; }

// 解析牌型；返回 {type, rank, len, cnt, cards} 或 null
function parseCombo(cards) {
  const n = cards.length; if (n === 0) return null;
  const m = counts(cards);
  const vals = Object.keys(m).map(Number).sort((a, b) => a - b);
  // 单
  if (n === 1) return { type: 'single', rank: vals[0], len: 1, cnt: 1, cards };
  // 对 / 火箭
  if (n === 2) {
    if (vals.length === 1) return { type: 'pair', rank: vals[0], len: 1, cnt: 2, cards };
    if (m[16] === 1 && m[17] === 1) return { type: 'rocket', rank: 100, len: 1, cnt: 2, cards };
    return null;
  }
  // 炸弹（4 张及以上同值；张数越多越大）
  if (n >= 4 && vals.length === 1) return { type: 'bomb', rank: vals[0], len: 1, cnt: n, cards };
  // 三
  if (n === 3 && vals.length === 1) return { type: 'trio', rank: vals[0], len: 1, cnt: 3, cards };
  // 三带一
  if (n === 4 && vals.length === 2) {
    const t = vals.find(v => m[v] === 3), s = vals.find(v => m[v] === 1);
    if (t !== undefined && s !== undefined) return { type: 'trio_single', rank: t, len: 1, cnt: 4, cards };
    return null;
  }
  // 三带二
  if (n === 5 && vals.length === 2) {
    const t = vals.find(v => m[v] === 3), p = vals.find(v => m[v] === 2);
    if (t !== undefined && p !== undefined) return { type: 'trio_pair', rank: t, len: 1, cnt: 5, cards };
  }
  // 顺子 / 连对 / 飞机
  const st = parseStraight(m, vals, n); if (st) return st;
  const sp = parseStraightPair(m, vals, n); if (sp) return sp;
  const pl = parsePlane(m, vals, n); if (pl) return pl;
  return null;
}
function parseStraight(m, vals, n) {
  if (n < 5 || vals.some(v => v > 14) || vals.some(v => m[v] !== 1)) return null;
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) return null;
  return { type: 'straight', rank: vals[0], len: n, cnt: n, cards: null };
}
function parseStraightPair(m, vals, n) {
  if (n < 6 || n % 2 !== 0 || vals.some(v => v > 14) || vals.some(v => m[v] !== 2)) return null;
  const k = n / 2;
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1] + 1) return null;
  return { type: 'straight_pair', rank: vals[0], len: k, cnt: n, cards: null };
}
function parsePlane(m, vals, n) {
  const trioVals = vals.filter(v => m[v] >= 3 && v <= 14);
  if (trioVals.length < 2) return null;
  let best = null;
  for (let i = 0; i < trioVals.length; i++) {
    const run = [trioVals[i]];
    for (let j = i + 1; j < trioVals.length; j++) { if (trioVals[j] === trioVals[j - 1] + 1) run.push(trioVals[j]); else break; }
    const k = run.length;
    const rem = { ...m }; for (const v of run) rem[v] -= 3;
    const remTotal = Object.values(rem).reduce((a, b) => a + (b > 0 ? b : 0), 0);
    if (n === 3 * k && remTotal === 0) { best = { type: 'plane', rank: run[0], len: k, cnt: n, cards: null }; break; }
    if (n === 4 * k && remTotal === k && !Object.entries(rem).some(([, c]) => c === 4)) best = { type: 'plane_single', rank: run[0], len: k, cnt: n, cards: null };
    if (n === 5 * k && remTotal === 2 * k && Object.values(rem).every(c => c % 2 === 0)) best = { type: 'plane_pair', rank: run[0], len: k, cnt: n, cards: null };
  }
  return best;
}

// 比较：cur 能否压过 prev（prev 为当前桌面最大牌型）
// key 为可选的「点数比较键」函数，用于掼蛋级牌（当前级牌 > A，仅次小王）等特殊大小关系；
// 不传则按原始点数比较（斗地主行为不变）。
function canBeat(prev, cur, key) {
  if (!cur) return false;
  const K = key || ((v) => v);
  if (cur.type === 'rocket') return true;
  if (prev == null) return true;
  if (prev.type === 'rocket') return false;
  if (cur.type === 'bomb') {
    if (prev.type === 'bomb') return K(cur.rank) > K(prev.rank) || (K(cur.rank) === K(prev.rank) && cur.cnt > prev.cnt);
    return true;
  }
  if (prev.type === 'bomb') return false;
  return cur.type === prev.type && cur.len === prev.len && K(cur.rank) > K(prev.rank);
}

function sortHand(cards) { return cards.slice().sort((a, b) => b.v - a.v || a.suit.localeCompare(b.suit)); }

module.exports = { RANK_LABEL, SUITS, makeDeck54, makeDeck108, parseCombo, canBeat, sortHand, counts };
