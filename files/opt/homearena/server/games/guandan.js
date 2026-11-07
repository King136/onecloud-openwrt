// 掼蛋（v0.4.4 增强）：2v2、108 张、级牌/升级、团队胜负、**百搭（逢人配）**、级牌大小优先级
// 百搭规则：当前级牌的「红桃」那张为逢人配，可代替除大小王外的任意牌组成牌型（两副牌共 2 张）
// 级牌大小：大王 > 小王 > 级牌 > A > K > ... > 2（2 为最小点）
const { makeDeck108, parseCombo, canBeat, sortHand } = require('./lib/cards');

const TEAMS = [[0, 2], [1, 3]]; // 队友关系

/** 级牌「称呼」→ 牌库点数：打 2 时级牌是 v=15 的牌；其余 3..A 与点数一致 */
function levelValue(level) { return level === 2 ? 15 : level; }
/** 是否百搭（红桃级牌） */
function isWild(c, state) { return c.suit === '♥' && c.v === levelValue(state.level); }
/** 点数比较键：级牌升到 A 之上、仅次小王；2 为最小点 */
function makeKey(level) {
  const lv = levelValue(level);
  return (v) => {
    if (v === 17) return 18;      // 大王
    if (v === 16) return 17;      // 小王
    if (v === lv) return 16;      // 级牌（打几，几就是级牌）
    if (v === 15) return 2;       // 掼蛋中 2 最小（除非它是级牌）
    return v;                     // 3..14
  };
}
/**
 * 解析一手牌（含百搭替换）。
 * 返回 { combo, assign } —— assign 为百搭牌 id → 替代点数；无法组成牌型则返回 null。
 */
function resolveCombo(sel, state, prevCombo) {
  const wilds = sel.filter(c => isWild(c, state));
  if (!wilds.length) {
    const combo = parseCombo(sel);
    return combo ? { combo, assign: {} } : null;
  }
  const key = makeKey(state.level);
  const cands = [];
  for (let v = 3; v <= 15; v++) cands.push(v);   // 百搭不能替代大小王
  const results = [];
  const chosen = new Map();
  const MAXW = 2; // 两副牌最多 2 张红桃级牌，限制爆炸
  const walk = (i) => {
    if (i >= wilds.length) {
      const cards = sel.map(c => (chosen.has(c.id) ? { ...c, v: chosen.get(c.id) } : c));
      const combo = parseCombo(cards);
      if (combo) results.push({ combo, assign: Object.fromEntries(chosen) });
      return;
    }
    if (i >= MAXW) return;
    for (const v of cands) { chosen.set(wilds[i].id, v); walk(i + 1); chosen.delete(wilds[i].id); }
  };
  walk(0);
  if (!results.length) return null;
  if (!prevCombo) {
    // 领出：优先张数多（多出牌），其次点数小
    results.sort((a, b) => (b.combo.cnt || 0) - (a.combo.cnt || 0) || key(a.combo.rank) - key(b.combo.rank));
  } else {
    const ok = results.filter(r => canBeat(prevCombo, r.combo, key));
    if (!ok.length) return null;
    ok.sort((a, b) => {
      // 炸弹/王炸留后手：能用普通牌压就用最小普通牌
      const bigA = a.combo.type === 'bomb' || a.combo.type === 'rocket' ? 1 : 0;
      const bigB = b.combo.type === 'bomb' || b.combo.type === 'rocket' ? 1 : 0;
      return bigA - bigB || key(a.combo.rank) - key(b.combo.rank);
    });
    return ok[0];
  }
  return results[0];
}

function group(hand) { const m = new Map(); for (const c of hand) { if (!m.has(c.v)) m.set(c.v, []); m.get(c.v).push(c); } return m; }
function createState(rules) {
  const deck = makeDeck108();
  const hands = [deck.slice(0, 27), deck.slice(27, 54), deck.slice(54, 81), deck.slice(81, 108)];
  /* v0.28.0（R16-6）起打级：2 / 5 / 10（A=14）。级牌即当前打的牌，
   * 红桃级牌为百搭 —— 起打级不同，牌力与百搭牌都会真正改变。 */
  const lv = rules && [2, 5, 10].indexOf(+rules.startLevel) >= 0 ? +rules.startLevel : 2;
  return {
    phase: 'playing', current: 0, hands,
    level: lv, levelLabel: lv === 14 ? 'A' : String(lv), out: [false, false, false, false], outOrder: [],
    lastPlay: null, passes: 0, leadBy: null, winner: null, draw: false, moves: [],
  };
}
function view(state, seat) {
  const hands = state.hands.map((h, i) => i === seat ? sortHand(h) : { hidden: true, n: h.length });
  // 仅把自己的百搭（红桃级牌）告诉本人，用于前端高亮
  const wildIds = state.hands[seat] ? state.hands[seat].filter(c => isWild(c, state)).map(c => c.id) : [];
  return { ...state, hands, _ownSeat: seat, wildIds, levelCard: state.levelLabel };
}
function nextActive(state, seat) { for (let k = 1; k <= 4; k++) { const s = (seat + k) % 4; if (!state.out[s]) return s; } return seat; }
function applyMove(state, move, player) {
  const seat = player - 1;
  if (state.phase === 'ended' || state.winner != null) return { ok: false, reason: 'ended' };
  if (state.current !== seat || state.out[seat]) return { ok: false, reason: 'noturn' };
  if (move && move.type === 'pass') {
    if (state.leadBy === seat) return { ok: false, reason: 'must_lead' };
    state.passes++;
    const active = 4 - state.out.filter(Boolean).length;
    if (state.passes >= active - 1) { state.lastPlay = null; state.passes = 0; const nx = nextActive(state, state.leadBy); state.current = nx; state.leadBy = nx; return { ok: true, next: nx }; }
    const nx = nextActive(state, seat); state.current = nx; return { ok: true, next: nx };
  }
  if (!move || move.type !== 'play' || !Array.isArray(move.cards)) return { ok: false, reason: 'badmove' };
  const hand = state.hands[seat];
  const sel = hand.filter(c => move.cards.includes(c.id));
  if (sel.length !== move.cards.length) return { ok: false, reason: 'notinyourhand' };
  const key = makeKey(state.level);
  const prevCombo = state.lastPlay ? state.lastPlay.combo : null;
  const r = resolveCombo(sel, state, prevCombo);
  if (!r) return { ok: false, reason: state.lastPlay ? 'cannotbeat' : 'invalidcombo' };
  const combo = r.combo;
  state.hands[seat] = hand.filter(c => !move.cards.includes(c.id));
  state.lastPlay = { seat, combo, cards: sel, wild: r.assign || {} };
  state.passes = 0; state.leadBy = seat;
  state.moves.push({ seat, type: 'play', combo: combo.type, rank: combo.rank, n: sel.length, ranks: sel.map(c => c.v), wild: Object.keys(r.assign || {}).length > 0 });
  if (state.hands[seat].length === 0) {
    state.out[seat] = true; state.outOrder.push(seat);
    const team = TEAMS.findIndex(t => t.includes(seat));
    if (state.out[TEAMS[team][0]] && state.out[TEAMS[team][1]]) {
      state.winner = team; state.draw = false; state.phase = 'ended';
      // 升级：双上 +2 级，否则 +1 级
      const bothOutFirst = state.outOrder.length <= 2;
      let lv = state.level + (bothOutFirst ? 2 : 1);
      if (lv > 14) lv = 14;
      state.level = lv; state.levelLabel = lv === 14 ? 'A' : String(lv);
      return { ok: true };
    }
    // 出牌者出局，本圈结束，下家领出
    state.lastPlay = null; state.passes = 0; const nx = nextActive(state, seat); state.leadBy = nx; state.current = nx; return { ok: true, next: nx };
  }
  const nx = nextActive(state, seat); state.current = nx; return { ok: true, next: nx };
}

// 启发式 AI（与斗地主同源思路：领出甩小牌、跟牌压最小、控制牌留给关键局）
function genBeats(hand, prev, key) {
  const K = key || ((v) => v);
  const grp = group(hand); const out = [];
  const vlist = [...grp.keys()].sort((a, b) => K(a) - K(b));
  const add = (cards) => { const c = parseCombo(cards); if (c && canBeat(prev, c, K)) { c.cards = cards; out.push(c); } };
  const gt = (v) => K(v) > K(prev.rank);
  /* ══ v0.34.0（R22-6）与斗地主同源的 P0 ══════════════════════════════
   * 旧写法 `if (A) for (...) if (B) add(...); else if (C) ...`
   * 里那个 else 属于**内层 if**，外层 if 根本没有 else 分支。
   * 后果：只要对方出的不是单张，这里就返回空数组，AI 直接 pass ——
   * 对子、三张、顺子、连对全线不跟。已显式补大括号。 */
  if (prev.type === 'single') {
    for (const v of vlist) if (gt(v) && grp.get(v).length >= 1) add([grp.get(v)[0]]);
  } else if (prev.type === 'pair') {
    for (const v of vlist) if (gt(v) && grp.get(v).length >= 2) add(grp.get(v).slice(0, 2));
  } else if (prev.type === 'trio') {
    for (const v of vlist) if (gt(v) && grp.get(v).length >= 3) add(grp.get(v).slice(0, 3));
  } else if (prev.type === 'straight') {
    for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
      let ok = true; const cs = [];
      for (let v = s; v < s + prev.len; v++) {
        if (!grp.has(v) || grp.get(v).length < 1) { ok = false; break; }
        cs.push(grp.get(v)[0]);
      }
      if (ok) add(cs);
    }
  } else if (prev.type === 'straight_pair') {
    for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
      let ok = true; const cs = [];
      for (let v = s; v < s + prev.len; v++) {
        if (!grp.has(v) || grp.get(v).length < 2) { ok = false; break; }
        cs.push(...grp.get(v).slice(0, 2));
      }
      if (ok) add(cs);
    }
  }
  if (prev.type !== 'rocket') { for (const v of vlist) if (grp.get(v).length >= 4) add(grp.get(v).slice(0, 4)); if (grp.has(16) && grp.has(17)) add([grp.get(16)[0], grp.get(17)[0]]); }
  return out;
}
function lowestStraight(hand, minLen) {
  const grp = group(hand); let best = null;
  for (let s = 3; s <= 10; s++) { let len = 0; const cs = []; for (let v = s; v <= 14; v++) { if (grp.has(v) && grp.get(v).length >= 1) { len++; cs.push(grp.get(v)[0]); if (len >= minLen && (!best || len > best.cs.length)) best = { cs: cs.slice(), len }; } else break; } }
  return best;
}
/** 用百搭（逢人配）构造压牌：覆盖单/对/三/炸弹 等高价值场景 */
function tryWildBeats(state, hand, prev, key) {
  const K = key;
  const wilds = hand.filter(c => isWild(c, state));
  if (!wilds.length) return [];
  const nonWild = hand.filter(c => !isWild(c, state));
  const grp = group(nonWild);
  const out = [];
  const push = (cards) => { const r = resolveCombo(cards, state, prev); if (r) out.push({ ...r, cards }); };

  if (prev.type === 'single' || prev.type === 'pair' || prev.type === 'trio') {
    const need = prev.type === 'single' ? 1 : prev.type === 'pair' ? 2 : 3;
    // 百搭 + (need-1) 张同点普通牌
    for (const [v, cs] of grp) {
      if (K(v) <= K(prev.rank)) continue;
      if (cs.length >= need - 1) push([...cs.slice(0, need - 1), ...wilds.slice(0, Math.min(wilds.length, need - (need - 1)))]);
    }
    // 全百搭
    if (wilds.length >= need) push(wilds.slice(0, need));
  }
  if (prev.type !== 'rocket') {
    // 炸弹：3 张同点 + 百搭，或 2 张同点 + 2 百搭
    for (const [v, cs] of grp) {
      if (cs.length >= 3 && wilds.length >= 1) push([...cs.slice(0, 3), wilds[0]]);
      if (cs.length >= 2 && wilds.length >= 2) push([...cs.slice(0, 2), wilds[0], wilds[1]]);
    }
  }
  return out;
}

function ai(state, player) {
  const seat = player - 1; const hand = state.hands[seat]; const grp = group(hand);
  const key = makeKey(state.level);
  if (state.leadBy === seat || !state.lastPlay) {
    // 领出：若手上有百搭，优先用它凑更大的牌型（多出牌）
    const wilds = hand.filter(c => isWild(c, state));
    if (wilds.length) {
      const nonWild = hand.filter(c => !isWild(c, state));
      const ngrp = group(nonWild);
      const tries = [];
      // 凑顺子：百搭补缺
      for (let s = 3; s <= 10; s++) {
        const cs = []; let need = 0;
        for (let v = s; v < s + 5 && v <= 14; v++) {
          if (ngrp.has(v) && ngrp.get(v).length >= 1) cs.push(ngrp.get(v)[0]); else need++;
        }
        if (cs.length >= 3 && need <= wilds.length && cs.length + wilds.length >= 5) {
          tries.push([...cs, ...wilds.slice(0, need)]);
        }
      }
      // 凑对子 / 三张
      for (const [v, cs] of ngrp) {
        if (cs.length === 1 && wilds.length >= 1 && v <= 14) tries.push([cs[0], wilds[0]]);
        if (cs.length === 2 && wilds.length >= 1) tries.push([...cs, wilds[0]]);
        if (cs.length === 3 && wilds.length >= 1) tries.push([...cs, wilds[0]]);
      }
      for (const t of tries) {
        const r = resolveCombo(t, state, null);
        // 注意：resolveCombo 返回 { combo, assign }，牌面要用入参 t（含原始 id）
        if (r && r.combo.type !== 'bomb') return { type: 'play', cards: t.map(c => c.id), wild: r.assign };
      }
    }
    const vlist = [...grp.keys()].sort((a, b) => a - b);
    const st = lowestStraight(hand, 5);
    if (st && st.cs.length >= 5) return { type: 'play', cards: st.cs.map(c => c.id) };
    const pairs = vlist.filter(v => grp.get(v).length >= 2 && v < 15);
    if (pairs.length) return { type: 'play', cards: grp.get(pairs[0]).slice(0, 2).map(c => c.id) };
    const singles = vlist.filter(v => v < 15 && grp.get(v).length >= 1 && grp.get(v).length < 4);
    if (singles.length) return { type: 'play', cards: [grp.get(singles[0])[0].id] };
    const v = vlist[0]; return { type: 'play', cards: [grp.get(v)[0].id] };
  }
  const beats = genBeats(hand, state.lastPlay.combo, key);
  // 百搭补强：把能压过的最小百搭组合也纳入候选
  for (const w of tryWildBeats(state, hand, state.lastPlay.combo, key)) {
    beats.push({ ...w.combo, cards: w.cards, wild: w.assign, wildcard: true });
  }
  if (beats.length === 0) return { type: 'pass' };
  const winMove = beats.find(b => b.cards && b.cards.length === hand.length);
  if (winMove) return { type: 'play', cards: winMove.cards.map(c => c.id), wild: winMove.wild };
  const safe = beats.filter(b => b.type !== 'bomb' && b.type !== 'rocket' && key(b.rank) < 16);
  if (safe.length) {
    safe.sort((a, b) => (a.wildcard ? 1 : 0) - (b.wildcard ? 1 : 0) || key(a.rank) - key(b.rank) || a.cards.length - b.cards.length);
    return { type: 'play', cards: safe[0].cards.map(c => c.id), wild: safe[0].wild };
  }
  const oppLeft = state.hands[state.lastPlay.seat].length; const myLeft = hand.length;
  if (state.lastPlay.combo.type === 'bomb' || oppLeft <= 2 || myLeft <= 6) {
    beats.sort((a, b) => (b.type === 'rocket' ? 1000 : key(b.rank)) - (a.type === 'rocket' ? 1000 : key(a.rank)));
    return { type: 'play', cards: beats[0].cards.map(c => c.id), wild: beats[0].wild };
  }
  return { type: 'pass' };
}
// v0.10.15 智能出牌候选（供前端「提示」候选面板多选项）。
// 复用本模块既有的 genBeats / tryWildBeats（与 AI 同源，正确性继承），
// 领出时再枚举单/对/三/炸/王炸/顺子/连对，统一返回 {cards,type,label,text,wholeHand}。
// 标签文案直接复用 doudizhu 的 lib/hint（牌型体系同构）。
const hint = require('./lib/hint');
function enumerateLeads(hand, state, key) {
  const grp = group(hand); const out = [];
  const add = (cards) => { const r = resolveCombo(cards, state, null); if (r) out.push({ ...r.combo, cards }); };
  for (const cs of grp.values()) { add([cs[0]]); if (cs.length >= 2) add(cs.slice(0, 2)); if (cs.length >= 3) add(cs.slice(0, 3)); if (cs.length === 4) add(cs.slice(0, 4)); }
  if (grp.has(16) && grp.has(17)) add([grp.get(16)[0], grp.get(17)[0]]);
  for (let s = 3; s <= 14; s++) { const cs = []; for (let v = s; v <= 14; v++) { if (grp.has(v) && grp.get(v).length >= 1) cs.push(grp.get(v)[0]); else break; if (cs.length >= 5) add(cs.slice()); } }
  for (let s = 3; s <= 14; s++) { const cs = []; for (let v = s; v <= 14; v++) { if (grp.has(v) && grp.get(v).length >= 2) cs.push(...grp.get(v).slice(0, 2)); else break; if (cs.length >= 6) add(cs.slice()); } }
  return out;
}
function hintPlays(hand, state, seat) {
  const key = makeKey(state.level);
  const isLead = state.leadBy === seat || !state.lastPlay;
  let combos = [];
  if (!isLead && state.lastPlay) {
    combos = genBeats(hand, state.lastPlay.combo, key);
    for (const w of tryWildBeats(state, hand, state.lastPlay.combo, key)) combos.push({ ...w.combo, cards: w.cards, wild: w.assign });
  } else {
    combos = enumerateLeads(hand, state, key);
  }
  const seen = new Set(); const out = [];
  for (const c of combos) {
    const cards = c.cards; if (!cards || !cards.length) continue;
    const ids = cards.map(x => x.id).sort().join(',');
    if (seen.has(ids)) continue; seen.add(ids);
    out.push({
      cards: cards.map(x => x.id),
      type: c.type,
      label: hint.TYPE_LABEL[c.type] || c.type,
      text: hint.describe(cards),
      wholeHand: cards.length === hand.length,
    });
  }
  const rank = (t) => ['rocket', 'bomb', 'straight_pair', 'straight', 'trio', 'pair', 'single'].indexOf(t);
  out.sort((a, b) => (b.wholeHand ? 1 : 0) - (a.wholeHand ? 1 : 0)
    || b.cards.length - a.cards.length
    || (rank(a.type) - rank(b.type)));
  return out.slice(0, 6);
}

module.exports = { label: '掼蛋', seats: 4, createState, applyMove, ai, view, isWild, makeKey, resolveCombo, hintPlays };
