// 双升 / 升级 / 拖拉机（4 人、2 副牌、2 队对抗，2v2）
// 契约：createState() / applyMove(state, move, seatNo) / ai(state, seatNo, level) / view(state, seat)
// 牌 id：'S14' 黑桃A 'H2' 红桃2 'C11' 梅花J 'JB' 小王 'JR' 大王
// 座位 0 基；state.current 为当前行动座位；state.phase: bidding→bury→play→score→done

const SUITS = ['S', 'H', 'C', 'D'];
const SEATS = 4;

function mkId(suit, r) { return suit + (r === 10 ? '10' : ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' })[r] || r); }
function parse(id) {
  if (id === 'JR') return { suit: 'J', r: 99 };
  if (id === 'JB') return { suit: 'J', r: 98 };
  return { suit: id[0], r: id.slice(1) === '10' ? 10 : ({ A: 14, K: 13, Q: 12, J: 11 })[id.slice(1)] || +id.slice(1) };
}
function freshDeck() {
  const d = [];
  for (let k = 0; k < 2; k++) { for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(mkId(s, r)); d.push('JB', 'JR'); }
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function isTrump(c, trump, level) {
  if (c.suit === 'J') return true; // 大小王恒为主
  if (trump == null) return false;
  return c.suit === trump || c.r === level;
}
function valueOf(c, trump, level) {
  if (c.suit === 'J') return c.r === 99 ? 1000 : 990;     // 大王 > 小王
  const tr = isTrump(c, trump, level);
  if (tr) {
    if (c.r === level) return c.suit === trump ? 980 : 970;  // 主级牌 > 副级牌
    return 900 + c.r;                                        // 主花色普通牌 A 最大
  }
  return 100 + c.r;
}
function pointsOf(c) { return c.r === 5 ? 5 : (c.r === 10 || c.r === 13) ? 10 : 0; }

function createState(rules) {
  /* v0.28.0（R16-6）起打级：2 / 5 / 10（A=14）。级牌直接决定主牌序列与分值排序。 */
  const lv = rules && [2, 5, 10].indexOf(+rules.startLevel) >= 0 ? +rules.startLevel : 2;
  const st = {
    game: 'shengji', current: 0, phase: 'bidding',
    level: lv, trump: null, bankerTeam: 0, banker: 0,
    players: Array.from({ length: SEATS }, (_, i) => ({ seat: i, hand: [], isBanker: false })),
    deck: [], bottom: [], trick: null, tricks: [], trickNo: 0,
    teamPoints: [0, 0], bid: null, bidTurn: 0, won: null, moves: [], log: [],
    score: null,
  };
  deal(st);
  return st;
}

function deal(st) {
  st.deck = freshDeck();
  for (const p of st.players) p.hand = [];
  for (let i = 0; i < 100; i++) st.players[i % SEATS].hand.push(st.deck.pop());
  for (const p of st.players) p.hand.sort((a, b) => handSort(parse(a), parse(b), st.trump, st.level));
  st.bottom = st.deck; if(process.env.SJ_DEBUG) console.error("DEAL hands", st.players.map(p=>p.hand.length));
  st.phase = 'bidding'; st.bid = null; st.bidTurn = 0; st.current = 0; st.trick = null; st.tricks = []; st.trickNo = 0; st.teamPoints = [0, 0];
}

function handSort(a, b, trump, level) {
  const va = valueOf(a, trump, level), vb = valueOf(b, trump, level);
  return vb - va; // 大牌在前
}

// 两副牌：同一牌面会在手牌中出现多次，移除时必须按「数量」精确移除，
// 不能简单 filter(!includes)，否则会把同 id 的多张一并误删导致丢牌。
function removeCards(hand, ids) {
  const need = {};
  for (const id of ids) need[id] = (need[id] || 0) + 1;
  return hand.filter(id => { if (need[id] > 0) { need[id]--; return false; } return true; });
}

function countLevelCards(hand, suit, level) { return hand.filter(id => { const c = parse(id); return c.suit === suit && c.r === level; }).length; }

// ---- 叫主 ----
function applyMove(state, move, seatNo) {
  const seat = seatNo - 1;
  if (state.finished) return { ok: false, reason: '已终局' };
  if (state.phase === 'bidding') return doBid(state, move, seat);
  if (state.phase === 'bury') return doBury(state, move, seat);
  if (state.phase === 'play') return doPlay(state, move, seat);
  return { ok: false, reason: 'noturn' };
}

function doBid(st, move, seat) {
  if (seat !== st.bidTurn) return { ok: false, reason: 'noturn' };
  if (move.type === 'declare') {
    const suit = move.suit; // 'S'|'H'|'C'|'D'|'N'(无主)
    let power = 0;
    if (suit === 'N') {
      const jokers = st.players[seat].hand.filter(id => id === 'JB' || id === 'JR');
      if (jokers.length < 2) return { ok: false, reason: '无主需一对王' };
      power = 3;
    } else {
      const n = countLevelCards(st.players[seat].hand, suit, st.level);
      if (n < 1) return { ok: false, reason: '没有该花色级牌' };
      power = n >= 2 ? 2 : 1;
    }
    // 比现有叫主强才覆盖
    const cur = st.bid ? st.bid.power : 0;
    if (power > cur) {
      st.bid = { seat, suit: suit === 'N' ? null : suit, power };
      st.log.push('玩家' + (seat + 1) + (suit === 'N' ? ' 叫无主' : ' 叫 ' + suit + ' 主'));
    }
  }
  st.bidTurn++;
  if (st.bidTurn < SEATS) { st.current = st.bidTurn; return { ok: true, next: st.bidTurn }; }
  // 叫主结束
  if (st.bid) { st.trump = st.bid.suit; st.banker = st.bid.seat; }
  else { st.trump = 'S'; st.banker = 0; st.log.push('无人叫主，默认♠主，玩家1坐庄'); }
  st.bankerTeam = st.banker % 2;
  for (const p of st.players) { p.isBanker = (p.seat % 2) === st.bankerTeam; }
  // 庄家收底：底牌并入庄家手牌，清空 set-aside（底牌在两副牌中原本各出现 2 次：1 张在玩家手、1 张在底，收底后仅保留手牌那份）
  const b = st.players[st.banker];
  b.hand = b.hand.concat(st.bottom);
  b.hand.sort((a, x) => handSort(parse(a), parse(x), st.trump, st.level));
  st.bottom = [];
  st.phase = 'bury'; st.current = st.banker;
  return { ok: true, next: st.banker };
}

function doBury(st, move, seat) {
  if (seat !== st.banker) return { ok: false, reason: 'noturn' };
  const ids = move.cards || [];
  if (ids.length !== 8) return { ok: false, reason: '需埋 8 张' };
  const b = st.players[st.banker];
  for (const id of ids) { const i = b.hand.indexOf(id); if (i < 0) return { ok: false, reason: '手牌不含 ' + id }; }
  // 优先埋分牌（庄家策略由玩家/AI 决定，这里仅校验）
  b.hand = removeCards(b.hand, ids);
  st.bottom = ids;
  st.bottomSaved = ids.slice();   // M3：底牌回看（扣底公开，全员可查）
  st.phase = 'play'; st.trickNo = 0;
  st.trick = { leader: st.banker, suit: null, plays: [], led: null };
  st.current = st.banker;
  return { ok: true, next: st.banker };
}

// ---- 出牌结构分析 ----
function groupInfo(cards, trump, level) {
  if (cards.length === 0) return null;
  const cs = cards.map(parse);
  if (cards.length === 1) return { type: 'single', count: 1, suit: cs[0].suit, ranks: [cs[0].r] };
  // 是否成对（须同花色，双升规则：不同花色的同点数牌不能组对/拖拉机）
  const byRank = {};
  for (const c of cs) (byRank[c.r] = byRank[c.r] || []).push(c);
  const suit = cs[0].suit;
  const sameSuit = cs.every(c => c.suit === suit);
  const allPairs = sameSuit && cs.length % 2 === 0 && Object.values(byRank).every(g => g.length === 2);
  if (allPairs) {
    const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
    const consec = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
    if (consec && ranks.length >= 2) return { type: 'tractor', count: cs.length, suit, ranks };
    if (ranks.length === 1 && cs.length === 2) return { type: 'pair', count: 2, suit, ranks };
  }
  if (cs.length >= 2 && sameSuit && !isTrump(cs[0], trump, level)) return { type: 'throw', count: cs.length, suit, ranks: cs.map(c => c.r) };
  return null;
}

function doPlay(st, move, seat) {
  if (seat !== st.current) return { ok: false, reason: 'noturn' };
  const ids = move.cards || [];
  const p = st.players[seat];
  for (const id of ids) if (!p.hand.includes(id)) return { ok: false, reason: '手牌不含 ' + id };
  const cs = ids.map(parse);

  if (st.trick.plays.length === 0) {
    // 首家
    const g = groupInfo(ids, st.trump, st.level);
    if (!g) return { ok: false, reason: '出牌组合非法' };
    // 甩牌校验：其余人不能有更大的同花色牌
    if (g.type === 'throw') {
      const ledSuit = g.suit;
      const myMax = Math.max(...cs.filter(c => c.suit === ledSuit).map(c => valueOf(c, st.trump, st.level)));
      for (let i = 0; i < SEATS; i++) {
        if (i === seat) continue;
        for (const id of st.players[i].hand) {
          const c = parse(id);
          if (c.suit === ledSuit && valueOf(c, st.trump, st.level) > myMax) return { ok: false, reason: '甩牌被抓：有更大同花色牌' };
        }
      }
    }
    const trumpLed = ['single', 'pair', 'tractor'].includes(g.type) && isTrump(cs[0], st.trump, st.level);
    st.trick.led = g;
    if (trumpLed) st.trick.led.suit = 'T';
  } else {
    // 跟牌：数量匹配
    const led = st.trick.led;
    if (ids.length !== led.count) return { ok: false, reason: '需出 ' + led.count + ' 张' };
    const ledSuit = led.suit === 'T' ? 'T' : led.suit;
    const inHand = ledSuit === 'T'
      ? p.hand.filter(id => isTrump(parse(id), st.trump, st.level))
      : p.hand.filter(id => parse(id).suit === ledSuit && !isTrump(parse(id), st.trump, st.level));
    if (inHand.length >= led.count) {
      // 该花色充足：必须全部跟该花色
      if (!cs.every(c => ledSuit === 'T' ? isTrump(c, st.trump, st.level) : (c.suit === ledSuit && !isTrump(c, st.trump, st.level))))
        return { ok: false, reason: '有该花色必须跟' };
    } else if (inHand.length > 0) {
      // 部分缺门：必须把已有的该花色全打出，余下可垫/毙
      if (!inHand.every(id => ids.includes(id))) { if (process.env.SJ_DEBUG) console.error('PARTIAL', 'ledSuit', ledSuit, 'led', JSON.stringify(led), 'inHand', inHand, 'ids', ids); return { ok: false, reason: '有该花色必须跟' }; }
    }
    // 其余（完全缺门）随意：可毙主或垫牌
  }

  // 落下（按数量精确移除，兼容两副牌重复牌面）
  p.hand = removeCards(p.hand, ids);
  st.trick.plays.push({ seat, ids, cs });
  st.moves.push({ seat, ids });
  st.log.push('玩家' + (seat + 1) + ' 出 ' + ids.join(' '));

  if (st.trick.plays.length < SEATS) {
    st.current = (seat + 1) % SEATS;
    return { ok: true, next: st.current };
  }
  // 一墩结束
  resolveTrick(st);
  return { ok: true, next: st.current, done: st.finished };
}

function trickStrength(plays, trump, level) {
  // 该墩是否「有资格赢」：主牌 或 与首攻同结构同花色；否则返回 -1（垫牌/错结构，必败）
  const led = plays[0];
  const ledG = groupInfo(led.ids, trump, level);
  const ledSuitIsTrump = ledG && ledG.type === 'single' && isTrump(led.cs[0], trump, level);
  const ledSuit = ledG ? ledG.suit : null;
  let best = -1;
  for (const pl of plays) {
    const g = groupInfo(pl.ids, trump, level);
    let eligible = false;
    if (g && isTrump(pl.cs[0], trump, level)) eligible = true; // 主牌毙（含首攻本身）
    else if (g && !ledSuitIsTrump && ledSuit && g.type === ledG.type && pl.cs.every(c => c.suit === ledSuit && !isTrump(c, trump, level))) eligible = true;
    if (eligible) {
      const top = Math.max(...pl.cs.map(c => valueOf(c, trump, level)));
      best = Math.max(best, top);
    }
  }
  return best;
}

function resolveTrick(st) {
  const plays = st.trick.plays;
  let winIdx = 0, winVal = trickStrength([plays[0]], st.trump, st.level);
  for (let i = 1; i < plays.length; i++) {
    const v = trickStrength([plays[i]], st.trump, st.level);
    if (v > winVal) { winVal = v; winIdx = i; }
  }
  const winner = plays[winIdx].seat;
  // 收分
  let pts = 0;
  for (const pl of plays) for (const c of pl.cs) pts += pointsOf(c);
  const team = winner % 2;
  st.teamPoints[team] += pts;
  st.log.push('玩家' + (winner + 1) + ' 得墩（+' + pts + '）');
  st.tricks.push({ winner, plays: plays.map(p => p.ids) });
  st.trickNo++;
  st.trick = { leader: winner, suit: null, plays: [], led: null };
  st.current = winner;

  if (st.trickNo >= 25) { scoreHand(st); return; }
  if (st.players[st.current].hand.length === 0) { scoreHand(st); return; }
}

function scoreHand(st) {
  const attackerTeam = 1 - st.bankerTeam;
  const ap = st.teamPoints[attackerTeam];
  let delta;
  if (ap === 0) delta = 3;
  else if (ap < 40) delta = 2;
  else if (ap < 80) delta = 1;
  else if (ap < 120) delta = 0;       // 攻方上台，平
  else if (ap < 160) delta = 1;
  else if (ap < 200) delta = 2;
  else delta = 3;

  let winTeam;
  if (ap < 80) { winTeam = st.bankerTeam; st.level += delta; }
  else { winTeam = attackerTeam; st.bankerTeam = attackerTeam; }

  const bankerWon = winTeam === st.bankerTeam;
  st.score = { attackerPoints: ap, delta, bankerWon, level: st.level, bankerTeam: st.bankerTeam };
  st.log.push('攻方得 ' + ap + ' 分，' + (bankerWon ? '庄家守住' : '攻方上台') + '，升级 ' + delta);

  if (st.level > 14) { st.finished = true; st.phase = 'done'; st.winner = winTeam === 0 ? 0 : 1; st.winnerTeam = winTeam; return; }
  // 下一局：新庄家坐庄，重新发牌
  st.phase = 'bidding';
  st.trump = null; st.bid = null; st.bidTurn = 0;
  st.banker = (st.bankerTeam === 0) ? 0 : 1; // 新庄家取该队 0 号座位
  deal(st);
  st.players[st.banker].isBanker = true;
}

/* ---- 暗牌裁剪 ---- */
function view(state, seat) {
  const v = JSON.parse(JSON.stringify(state));
  for (const p of v.players) {
    if (seat >= 0 && p.seat === seat) continue;
    p.hand = { hidden: true, n: p.hand.length };
  }
  return v;
}

/* ---- AI ---- */
function teamHasLowTrump(hand, trump, level) { return hand.some(id => { const c = parse(id); return isTrump(c, trump, level) && c.r !== 99 && c.r !== 98 && c.r !== level; }); }

async function ai(state, seatNo, level) {
  const seat = seatNo - 1;
  const p = state.players[seat];
  if (state.phase === 'bidding') {
    const jokers = p.hand.filter(id => id === 'JB' || id === 'JR');
    if (jokers.length >= 2 && (!state.bid || state.bid.power < 3)) return { type: 'declare', suit: 'N' };
    for (const s of SUITS) { const n = countLevelCards(p.hand, s, state.level); if (n >= 1 && level !== 'fun' && (!state.bid || state.bid.power < (n >= 2 ? 2 : 1))) return { type: 'declare', suit: s }; }
    return { type: 'pass' };
  }
  if (state.phase === 'bury') {
    // 埋掉最小的 8 张（尽量留分牌在手里以抠底）
    const sorted = p.hand.slice().sort((a, b) => valueOf(parse(a), state.trump, state.level) - valueOf(parse(b), state.trump, state.level));
    return { cards: sorted.slice(0, 8) };
  }
  if (state.phase === 'play') {
    const t = state.trick;
    if (t.plays.length === 0) {
      // 领出：有同花色对子先出；否则出最大非主牌
      const bySuitRank = {};
      for (const id of p.hand) { const c = parse(id); const key = c.suit + '_' + c.r; (bySuitRank[key] = bySuitRank[key] || []).push(id); }
      const pairs = Object.entries(bySuitRank).filter(([, g]) => g.length >= 2).sort((a, b) => b[1].length - a[1].length);
      if (pairs.length) return { cards: pairs[0][1].slice(0, 2) };
      const nonTrump = p.hand.filter(id => !isTrump(parse(id), state.trump, state.level));
      return { cards: [nonTrump[0] || p.hand[0]] };
    }
    // 跟牌：保证合法（有该花色必跟，部分缺门补牌，完全缺门可毙/垫）
    const led = t.led;
    const ledIsTrump = led.suit === 'T';
    const ledSuit = ledIsTrump ? null : led.suit;
    const suitCards = ledIsTrump
      ? p.hand.filter(id => isTrump(parse(id), state.trump, state.level))
      : p.hand.filter(id => { const c = parse(id); return c.suit === ledSuit && !isTrump(c, state.trump, state.level); });
    const otherCards = ledIsTrump
      ? p.hand.filter(id => !isTrump(parse(id), state.trump, state.level))
      : p.hand.filter(id => { const c = parse(id); return !(c.suit === ledSuit && !isTrump(c, state.trump, state.level)); });
    let pick;
    if (suitCards.length >= led.count) pick = suitCards.slice(0, led.count);
    else if (suitCards.length > 0) pick = suitCards.concat(otherCards.slice(0, led.count - suitCards.length));
    else pick = otherCards.slice(0, led.count);
    pick.sort((a, b) => valueOf(parse(a), state.trump, state.level) - valueOf(parse(b), state.trump, state.level));
    return { cards: pick.slice(0, led.count) };
  }
  return null;
}

module.exports = { label: '双升', seats: SEATS, createState, applyMove, ai, view, evaluate7: null };
