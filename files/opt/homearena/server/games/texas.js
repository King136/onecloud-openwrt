// 德州扑克（Texas Hold'em，无限注，4 人桌）
// 契约：createState() / applyMove(state, move, seatNo) / ai(state, seatNo, level) / view(state, seat)
// 牌：id 形如 'sA','h10','cK','d2'；rank 2..14（11=J 12=Q 13=K 14=A）；suit s/h/c/d。
// 座位：state.current 为 0 基座位号；applyMove 的 seatNo 为 1 基。

const SUITS = ['s', 'h', 'c', 'd'];
const SEATS = 4;
const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

function rankName(r) { return ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' })[r] || String(r); }
function cardId(suit, r) { return suit + (r === 10 ? '10' : rankName(r)); }
function parseId(id) { return { suit: id[0], r: id.slice(1) === '10' ? 10 : ({ A: 14, K: 13, Q: 12, J: 11 })[id.slice(1)] || +id.slice(1) }; }

function freshDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(cardId(s, r));
  // Fisher-Yates
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/* v0.12.0（R3-4）自定义规则：createState(rules) 支持 startingChips（200~100000） */
function createState(rules) {
  let chips = START_CHIPS;
  if (rules && Number.isFinite(+rules.startingChips)) chips = Math.min(100000, Math.max(200, Math.round(+rules.startingChips)));
  const st = {
    game: 'texas',
    current: 0,
    phase: 'idle',
    deck: [],
    community: [],
    players: Array.from({ length: SEATS }, (_, i) => ({
      seat: i, chips, hole: [], folded: false, allin: false,
      bet: 0, total: 0, out: false, acted: false, lastAct: '',
    })),
    button: 0, pot: 0, currentBet: 0, minRaise: BIG_BLIND,
    handNo: 0, maxHands: 12, winner: null, draw: false, finished: false, showdown: false,
    moves: [], log: [], smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND,
    legal: null,
  };
  startHand(st);
  return st;
}

function activePlayers(st) { return st.players.filter(p => !p.folded && !p.out && p.chips + p.bet > 0); }

function startHand(st) {
  st.handNo++;
  st.deck = freshDeck();
  st.community = [];
  st.pot = 0;
  st.currentBet = 0;
  st.minRaise = BIG_BLIND;
  st.showdown = false;
  st.phase = 'preflop';
  st.winner = null;
  st.draw = false;
  for (const p of st.players) {
    p.hole = []; p.folded = false; p.allin = false; p.bet = 0; p.total = 0; p.acted = false; p.lastAct = '';
    if (!p.out && p.chips <= 0) p.out = true; // 安全兜底（正常已在终局处理）
  }
  const live = st.players.filter(p => !p.out);
  // 庄位轮转
  st.button = live.length ? ((st.button + 1) % SEATS) : 0;
  // 找存活的庄家
  while (st.players[st.button] && st.players[st.button].out) st.button = (st.button + 1) % SEATS;
  // 发牌
  for (const p of live) for (let k = 0; k < 2; k++) p.hole.push(st.deck.pop());
  // 盲注
  const sbSeat = nextLive(st, st.button);
  const bbSeat = nextLive(st, sbSeat);
  postBlind(st, sbSeat, SMALL_BLIND);
  postBlind(st, bbSeat, BIG_BLIND);
  st.currentBet = BIG_BLIND;
  // 行动从大盲后一位开始
  st.current = nextLive(st, bbSeat);
  computeLegal(st);
}

function nextLive(st, from) {
  let i = from;
  for (let k = 0; k < SEATS; k++) { i = (i + 1) % SEATS; if (!st.players[i].out && !st.players[i].folded) return i; }
  return from;
}

function postBlind(st, seat, amt) {
  const p = st.players[seat];
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; p.total += pay; st.pot += pay;
  if (p.chips === 0) p.allin = true;
}

function toCall(st, seat) { return Math.max(0, st.currentBet - st.players[seat].bet); }

function computeLegal(st) {
  const p = st.players[st.current];
  const tc = toCall(st, st.current);
  const maxBet = p.bet + p.chips;
  const legal = { fold: true, check: tc === 0, call: tc > 0, callAmount: tc, canRaise: false, minRaise: 0, maxRaise: maxBet, allin: p.chips > 0 };
  if (p.chips > 0) {
    const targetRaise = st.currentBet + st.minRaise;
    if (targetRaise <= maxBet) { legal.canRaise = true; legal.minRaise = targetRaise; }
  }
  st.legal = legal;
  return legal;
}

function applyMove(state, move, seatNo) {
  const seat = seatNo - 1;
  if (state.finished) return { ok: false, reason: '已终局' };
  if (state.phase === 'done' || state.phase === 'idle') return { ok: false, reason: '非下注阶段' };
  if (seat !== state.current) return { ok: false, reason: 'noturn' };
  const p = state.players[seat];
  const tc = toCall(state, seat);
  const maxBet = p.bet + p.chips;
  const type = move && move.type;
  let amount = 0, desc = '';

  if (type === 'fold') {
    p.folded = true; desc = '弃牌';
  } else if (type === 'check') {
    if (tc !== 0) return { ok: false, reason: '有人加注，不能过牌' };
    desc = '过牌';
  } else if (type === 'call') {
    if (tc === 0) return { ok: false, reason: '无需跟注' };
    amount = Math.min(tc, p.chips);
    p.chips -= amount; p.bet += amount; p.total += amount; state.pot += amount;
    if (p.chips === 0) p.allin = true;
    desc = '跟注 ' + amount;
  } else if (type === 'bet' || type === 'raise') {
    let target = move.amount;
    if (target == null) return { ok: false, reason: 'badmove' };
    target = Math.max(0, Math.min(maxBet, Math.floor(target)));
    if (type === 'bet') {
      // 翻牌前已有盲注（currentBet>0），bet 语义降级为 raise，按最小加注额校验，避免客户端卡死
      if (state.currentBet !== 0) {
        const need = state.currentBet + state.minRaise;
        if (target < need) return { ok: false, reason: '加注至少到 ' + need };
      } else if (target < state.minRaise) return { ok: false, reason: '下注至少 ' + state.minRaise };
    } else {
      const need = state.currentBet + state.minRaise;
      if (target < need) return { ok: false, reason: '加注至少到 ' + need };
    }
    const add = target - p.bet;
    if (add > p.chips) return { ok: false, reason: '筹码不足，请 allin' };
    p.chips -= add; p.bet += add; p.total += add; state.pot += add;
    const inc = target - state.currentBet;
    if (inc >= state.minRaise) state.minRaise = inc; // 最小加注额随加注增大
    state.currentBet = target; state.lastAggressor = seat;
    if (p.chips === 0) p.allin = true;
    desc = (type === 'bet' ? '下注 ' : '加注到 ') + target;
  } else if (type === 'allin') {
    const add = p.chips;
    p.bet += add; p.total += add; state.pot += add; p.chips = 0; p.allin = true;
    if (p.bet > state.currentBet) {
      state.minRaise = Math.max(state.minRaise, p.bet - state.currentBet);
      state.currentBet = p.bet; state.lastAggressor = seat;
    }
    desc = '全下 ' + p.bet;
  } else return { ok: false, reason: 'badmove' };

  p.acted = true; p.lastAct = desc;
  state.moves.push({ seat, type, amount: p.bet, phase: state.phase });
  state.log.push('玩家' + (seat + 1) + ' ' + desc);
  advance(state);
  return { ok: true, next: state.finished ? null : state.current, done: state.finished };
}

function roundComplete(st) {
  const contenders = st.players.filter(p => !p.folded && !p.out && !p.allin);
  if (contenders.length === 0) {
    // 全员 all-in，直接发完公共牌进入摊牌
    return true;
  }
  for (const p of contenders) {
    if (!p.acted) return false;
    if (p.bet !== st.currentBet) return false;
  }
  return true;
}

function advance(st) {
  // 只剩一名未弃牌者
  const liveNoFold = st.players.filter(p => !p.folded && !p.out);
  if (liveNoFold.length === 1) { endHandByFold(st, liveNoFold[0].seat); return; }

  if (roundComplete(st)) {
    // 进入下一街 / 摊牌
    if (st.phase === 'river') { showdown(st); return; }
    st.phase = st.phase === 'preflop' ? 'flop' : st.phase === 'flop' ? 'turn' : 'river';
    st.currentBet = 0; st.minRaise = BIG_BLIND;
    for (const p of st.players) { p.bet = 0; p.acted = false; }
    if (st.phase === 'flop') for (let i = 0; i < 3; i++) st.community.push(st.deck.pop());
    else st.community.push(st.deck.pop());
    // 若仅剩一名非 all-in，发完牌后摊牌
    const canAct = st.players.filter(p => !p.folded && !p.out && !p.allin);
    if (canAct.length <= 1) { while (st.community.length < 5) st.community.push(st.deck.pop()); showdown(st); return; }
    st.current = nextLive(st, st.button);
    computeLegal(st);
    return;
  }
  // 找下一位需要行动的玩家
  let i = st.current;
  for (let k = 0; k < SEATS; k++) {
    i = (i + 1) % SEATS;
    const p = st.players[i];
    if (p.folded || p.out || p.allin) continue;
    if (!p.acted || p.bet !== st.currentBet) { st.current = i; computeLegal(st); return; }
  }
  // 无更多行动者：兜底发牌（理论不会到这）
  if (st.phase === 'river') showdown(st);
  else { st.phase = 'flop'; for (let x = 0; x < 3; x++) st.community.push(st.deck.pop()); computeLegal(st); }
}

function endHandByFold(st, seat) {
  st.players[seat].chips += st.pot; st.pot = 0;
  st.log.push('玩家' + (seat + 1) + ' 赢得底池');
  finishIfOver(st);
}

// ---- 牌型评估 ----
function evaluate7(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  // 统计
  const rc = {}; for (const r of ranks) rc[r] = (rc[r] || 0) + 1;
  const sc = {}; for (const s of suits) sc[s] = (sc[s] || 0) + 1;
  const isFlush = Object.values(sc).some(n => n >= 5);
  // 顺子（含 A2345 轮子）
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  for (let i = 0; i <= uniq.length - 5; i++) {
    if (uniq[i] - uniq[i + 4] === 4) { straightHigh = uniq[i]; break; }
  }
  if (!straightHigh && uniq.includes(14) && uniq.includes(5) && uniq.includes(4) && uniq.includes(3) && uniq.includes(2)) straightHigh = 5;
  const flushSuit = isFlush ? Object.keys(sc).find(s => sc[s] >= 5) : null;
  let best = [0]; // category
  // 同花顺
  if (flushSuit) {
    const fRanks = cards.filter(c => c.suit === flushSuit).map(c => c.r).sort((a, b) => b - a);
    const fu = [...new Set(fRanks)];
    let sf = 0;
    for (let i = 0; i <= fu.length - 5; i++) if (fu[i] - fu[i + 4] === 4) { sf = fu[i]; break; }
    if (!sf && fu.includes(14) && fu.includes(5) && fu.includes(4) && fu.includes(3) && fu.includes(2)) sf = 5;
    if (sf) return [8, sf];
  }
  // 四条
  const quads = Object.keys(rc).filter(r => rc[r] === 4).map(Number);
  const trips = Object.keys(rc).filter(r => rc[r] === 3).map(Number);
  const pairs = Object.keys(rc).filter(r => rc[r] === 2).map(Number);
  if (quads.length) {
    const k = quads[0];
    const kicker = Math.max(...ranks.filter(r => r !== k));
    return [7, k, kicker];
  }
  if (trips.length && (trips.length >= 2 || pairs.length)) {
    const t = trips.sort((a, b) => b - a);
    const pairFor = trips.length >= 2 ? t[1] : pairs[0];
    return [6, t[0], pairFor];
  }
  if (straightHigh) return [5, straightHigh];
  if (isFlush) {
    const fRanks = cards.filter(c => c.suit === flushSuit).map(c => c.r).sort((a, b) => b - a).slice(0, 5);
    return [4, ...fRanks];
  }
  if (trips.length) return [3, trips[0], ...ranks.filter(r => r !== trips[0]).slice(0, 2)];
  if (pairs.length >= 2) {
    const ps = pairs.sort((a, b) => b - a);
    const kicker = Math.max(...ranks.filter(r => r !== ps[0] && r !== ps[1]));
    return [2, ps[0], ps[1], kicker];
  }
  if (pairs.length === 1) return [1, pairs[0], ...ranks.filter(r => r !== pairs[0]).slice(0, 3)];
  return [0, ...ranks.slice(0, 5)];
}

function cmpArr(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; }

function showdown(st) {
  st.showdown = true;
  const contenders = st.players.filter(p => !p.folded && !p.out);
  const parsed = {};
  for (const p of contenders) parsed[p.seat] = p.hole.map(parseId).concat(st.community.map(parseId));
  // 边池
  const contribs = st.players.map(p => p.total);
  const levels = [...new Set(contribs.filter(c => c > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const lvl of levels) {
    const layer = (lvl - prev);
    const inLayer = st.players.filter(p => p.total >= lvl);
    const pot = layer * inLayer.length;
    if (pot <= 0) { prev = lvl; continue; }
    const eligible = contenders.filter(p => p.total >= lvl);
    if (eligible.length === 0) { st.pot += 0; prev = lvl; continue; }
    let bestSeat = eligible[0].seat, bestVal = evaluate7(parsed[eligible[0].seat]);
    for (const p of eligible) { const v = evaluate7(parsed[p.seat]); if (cmpArr(v, bestVal) > 0) { bestVal = v; bestSeat = p.seat; } }
    // 平分（多赢家）
    const winners = eligible.filter(p => cmpArr(evaluate7(parsed[p.seat]), bestVal) === 0);
    const share = Math.floor(pot / winners.length);
    let rem = pot - share * winners.length;
    for (const w of winners) { w.chips += share + (rem > 0 ? 1 : 0); rem--; }
    st.log.push('玩家' + (bestSeat + 1) + ' 摊牌赢 ' + pot + (winners.length > 1 ? '（平分）' : ''));
    prev = lvl;
  }
  st.pot = 0;
  finishIfOver(st);
}

function finishIfOver(st) {
  const live = st.players.filter(p => !p.out && p.chips > 0);
  const maxHands = st.maxHands || 12;
  // 只剩一人，或打到手数上限：本局结束（否则 AI 互相对局可能打上百手，永远不结算）
  if (live.length <= 1 || st.handNo >= maxHands) {
    st.finished = true;
    st.phase = 'done';
    st.legal = null;
    if (live.length === 1) {
      st.winner = live[0].seat;
    } else {
      const best = Math.max(...st.players.map(p => p.chips));
      const tops = st.players.filter(p => p.chips === best);
      if (tops.length === 1) st.winner = tops[0].seat;
      else { st.winner = null; st.draw = true; }   // 筹码并列第一按平局
      st.log.push('手数达上限 ' + maxHands + '，按筹码结算');
    }
    return;
  }
  // 继续下一手
  startHand(st);
}

/* ---- 暗牌裁剪 ---- */
function view(state, seat) {
  const v = JSON.parse(JSON.stringify(state));
  for (const p of v.players) {
    if (seat >= 0 && p.seat === seat) continue;
    if (state.showdown && !p.folded) continue;
    p.hole = { hidden: true, n: p.hole.length };
  }
  return v;
}

/* ---- AI ---- */
const FULL_DECK = (() => { const a = []; for (const s of SUITS) for (let r = 2; r <= 14; r++) a.push(cardId(s, r)); return a; })();

function equity(hole, community, nOpp, iters) {
  const known = new Set(hole.concat(community));
  const rem = FULL_DECK.filter(id => !known.has(id));
  let wins = 0, ties = 0;
  for (let it = 0; it < iters; it++) {
    const pool = rem.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]; }
    const need = 5 - community.length;
    const board = community.concat(pool.slice(0, need));
    let idx = need;
    const oppVals = [];
    for (let o = 0; o < nOpp; o++) {
      const oh = pool.slice(idx, idx + 2); idx += 2;
      oppVals.push(evaluate7(oh.map(parseId).concat(board.map(parseId))));
    }
    const myVal = evaluate7(hole.map(parseId).concat(board.map(parseId)));
    let beat = true, tie = false;
    for (const ov of oppVals) { const c = cmpArr(myVal, ov); if (c < 0) { beat = false; break; } if (c === 0) tie = true; }
    if (beat && !tie) wins++; else if (tie) ties++;
  }
  return wins / iters + 0.5 * ties / iters;
}

async function ai(state, seatNo, level) {
  const seat = seatNo - 1;
  const p = state.players[seat];
  if (!state.legal) return null;
  const legal = state.legal;
  const nOpp = state.players.filter(x => !x.folded && !x.out && x.seat !== seat).length;
  const iters = level === 'super' ? 240 : level === 'strong' ? 120 : 50;
  const eq = equity(p.hole, state.community, nOpp, iters);
  const tc = legal.callAmount || 0;
  const potOdds = tc > 0 ? tc / (state.pot + tc) : 0;
  const rnd = level === 'fun' ? 0.12 : 0;

  // 决策
  if (tc === 0) {
    // 可过牌/下注
    if (eq > 0.72 - rnd && legal.canRaise) {
      const target = Math.max(legal.minRaise || BIG_BLIND, Math.min(legal.maxRaise, Math.round(state.pot * (level === 'super' ? 0.66 : 0.5))));
      // 翻牌前大盲已使 currentBet>0，此时只能 raise，用 bet 会被判非法
      return { type: state.currentBet === 0 ? 'bet' : 'raise', amount: clampRaise(state, seat, target) };
    }
    return { type: 'check' };
  }
  // 需要跟注
  if (eq > Math.max(potOdds + 0.05, 0.5)) {
    if (eq > 0.82 - rnd && legal.canRaise) {
      const target = Math.round(state.pot * (level === 'super' ? 0.75 : 0.6)) + state.currentBet;
      const amt = clampRaise(state, seat, target);
      // 筹码不足最小加注额时退回跟注，避免产生非法着
      if (amt != null) return { type: 'raise', amount: amt };
    }
    return { type: 'call' };
  }
  // 偶尔诈唬跟注（super）
  if (level === 'super' && Math.random() < 0.08 && tc < p.chips * 0.25) return { type: 'call' };
  // 否则弃牌（除非跟注极小且有一定胜率）
  if (tc <= Math.min(20, p.chips * 0.1) && eq > potOdds) return { type: 'call' };
  return { type: 'fold' };
}

// 返回合法的加注目标额（数字）；筹码不足最小加注额时返回 null，交由调用方降级为跟注
function clampRaise(state, seat, target) {
  const p = state.players[seat];
  const maxBet = p.bet + p.chips;
  const need = state.currentBet + state.minRaise;
  if (maxBet < need) return null;
  return Math.max(need, Math.min(Math.floor(target), maxBet));
}

module.exports = { label: '德州扑克', seats: SEATS, createState, applyMove, ai, view, evaluate7, winnerBase: 0 };
