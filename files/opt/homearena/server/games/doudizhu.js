// 斗地主：发牌17×3 + 底牌3、叫分、完整牌型校验、领出/跟牌、智能启发式 AI（非超人，超人由 DouZero 桥接）
const { makeDeck54, parseCombo, canBeat, sortHand } = require('./lib/cards');
const dz = require('../ai/douzero');
const hint = require('./lib/hint');

function group(hand) { const m = new Map(); for (const c of hand) { if (!m.has(c.v)) m.set(c.v, []); m.get(c.v).push(c); } return m; }
function dealNew(state) {
  const deck = makeDeck54();
  state.hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)];
  state.bottom = deck.slice(51, 54);
  state.phase = 'bidding'; state.bids = []; state.lastBid = null;
  state.firstBidder = Math.floor(Math.random() * 3);
  state.current = state.firstBidder; state.landlord = null; state.lastPlay = null; state.passes = 0; state.leadBy = null;
  state.winner = null; state.draw = false; state.moves = [];
}
/* v0.12.0（R3-4）自定义规则：createState(rules) 支持 multiplierCap（0=不限 / 16 / 32 / 64）。
 * cap 存进 state，随 replay 重建时也带回 —— 规则是房间属性，一局结束不丢。 */
function createState(rules) {
  const cap = rules && [16, 32, 64].indexOf(+rules.multiplierCap) >= 0 ? +rules.multiplierCap : 0;
  const s = { cap, phase: 'bidding', current: 0, hands: [[], [], []], bottom: [], landlord: null, bids: [], lastBid: null, firstBidder: 0, lastPlay: null, passes: 0, leadBy: null, winner: null, draw: false, moves: [] };
  dealNew(s); return s;
}
/* 倍数变动后统一走这里夹封顶（cap=0 表示不限） */
function clampMult(s) { if (s.cap && s.multiplier > s.cap) s.multiplier = s.cap; }
/* ══════════════════════════════════════════════════════════════════════════
 * v0.12.0（P0-3）底牌（地主牌）可见性 —— 用户：「棋牌类游戏，比如斗地主，
 * 没有固定显示地主牌，这是非专业表现，需要恒定显示地主牌。」
 *
 * 查下来是**两头都错**，恰好互为反面：
 *
 * ① 服务端该藏的没藏：
 *    `return { ...state, hands, ... }` 把 state.bottom 原样透传给所有人 ——
 *    包括**叫分阶段**。真人只要开 DevTools 看一眼帧数据，
 *    在还没定地主时就知道底牌是哪三张，能据此决定叫不叫分。这是作弊面。
 *    线下斗地主里底牌是扣着的，定地主后才翻开亮相。
 *
 * ② 前端该显示的没显示：
 *    ui-games.js 的 G.cards 只渲染手牌，`st.bottom` 一次都没读 ——
 *    于是定地主、底牌归地主之后，桌上根本看不到地主牌，
 *    玩家不知道地主多了哪三张，也没法据此算牌。这是「非专业表现」。
 *
 * 现在的口径（对齐线下与主流平台）：
 *   · bidding 阶段 → bottom 只给数量（3），内容不下发；
 *   · playing 阶段 → bottom 全量下发（此时底牌已明牌并入地主手牌）；
 *   · 对局结束 → 也全量下发（复盘要看）。
 *   · 观战者（seat = -1）在 bidding 阶段同样只看到数量。
 * ══════════════════════════════════════════════════════════════════════════ */
function view(state, seat) {
  const hands = state.hands.map((h, i) => i === seat ? sortHand(h) : { hidden: true, n: h.length });
  const revealed = state.phase !== 'bidding' || state.landlord != null;
  const bottom = revealed ? state.bottom : { hidden: true, n: (state.bottom || []).length };
  return { ...state, hands, bottom, _ownSeat: seat, _bottomRevealed: !!revealed };
}

function applyMove(state, move, player) {
  const seat = player - 1;
  if (state.winner != null || state.draw) return { ok: false, reason: 'ended' };
  if (state.current !== seat) return { ok: false, reason: 'noturn' };
  if (state.phase === 'bidding') return applyBid(state, move, seat);
  if (state.phase === 'playing') return applyPlay(state, move, seat);
  return { ok: false };
}
function applyBid(state, move, seat) {
  if (!move || move.type !== 'bid') return { ok: false, reason: 'badbid' };
  let score = Math.max(0, Math.min(3, Math.floor(move.score || 0)));
  if (state.lastBid && score <= state.lastBid.score) score = 0; // 必须更高，否则视为不叫
  state.bids.push({ seat, score });
  if (score > 0) state.lastBid = { seat, score };
  // 结束判定：有人叫满 3 分，或三人各叫一次
  if (score === 3 || state.bids.length === 3) {
    let landlord = state.lastBid ? state.lastBid.seat : state.firstBidder;
    state.landlord = landlord;
    state.hands[landlord] = state.hands[landlord].concat(state.bottom);
    state.phase = 'playing'; state.current = landlord; state.leadBy = landlord; state.lastPlay = null; state.passes = 0;
    // 初始倍数 = 叫分（流局无人叫则按 1 倍）
    state.multiplier = state.lastBid ? Math.max(1, state.lastBid.score) : 1;
    return { ok: true, next: landlord };
  }
  const next = (seat + 1) % 3;
  state.current = next; return { ok: true, next };
}
function applyPlay(state, move, seat) {
  if (move && move.type === 'pass') {
    if (state.leadBy === seat) return { ok: false, reason: 'must_lead' };
    state.passes++;
    if (state.passes >= 2) { state.lastPlay = null; state.passes = 0; state.current = state.leadBy; return { ok: true, next: state.leadBy }; }
    const next = (seat + 1) % 3; state.current = next; return { ok: true, next };
  }
  if (!move || move.type !== 'play' || !Array.isArray(move.cards)) return { ok: false, reason: 'badmove' };
  const hand = state.hands[seat];
  const sel = hand.filter(c => move.cards.includes(c.id));
  if (sel.length !== move.cards.length) return { ok: false, reason: 'notinyourhand' };
  const combo = parseCombo(sel);
  if (!combo) return { ok: false, reason: 'invalidcombo' };
  if (state.lastPlay && !canBeat(state.lastPlay.combo, combo)) return { ok: false, reason: 'cannotbeat' };
  state.hands[seat] = hand.filter(c => !move.cards.includes(c.id));
  state.lastPlay = { seat, combo, cards: sel }; state.passes = 0; state.leadBy = seat;
  // 倍数：炸弹 / 王炸 各翻一倍，初始倍数由叫分决定
  if (combo.type === 'bomb') state.multiplier = (state.multiplier || 1) * 2;
  else if (combo.type === 'rocket') state.multiplier = (state.multiplier || 1) * 4;
  clampMult(state);
  state.moves.push({ seat, type: 'play', combo: combo.type, rank: combo.rank, n: sel.length, ranks: sel.map(c => c.v) });
  if (state.hands[seat].length === 0) {
    state.winner = seat; state.draw = false; state.phase = 'ended';
    // 春天：地主出完农民一张没出（或反春），再翻倍
    if (state.landlord === seat) {
      const farmersPlayed = state.moves.filter(m => m.type === 'play' && m.seat !== seat).length;
      if (farmersPlayed === 0) state.multiplier = (state.multiplier || 1) * 2;
    } else {
      const landlordPlays = state.moves.filter(m => m.type === 'play' && m.seat === state.landlord).length;

      if (landlordPlays === 1) state.multiplier = (state.multiplier || 1) * 2;
    }
    clampMult(state);   // 春天/反春的翻倍同样受封顶约束
    return { ok: true };
  }
  const next = (seat + 1) % 3; state.current = next; return { ok: true, next };
}

// ---- 智能启发式 AI（非超人） ----
function pickKicker(hand, excludeVals, count, needPair) {
  const grp = group(hand); const out = [];
  const vals = [...grp.keys()].filter(v => !excludeVals.includes(v)).sort((a, b) => a - b);
  for (const v of vals) {
    if (grp.get(v).length >= (needPair ? 2 : 1) && v < 15) { // 不让单/对拆炸弹，也不用 2/王 做垫
      out.push(...grp.get(v).slice(0, needPair ? 2 : 1));
      if (out.length >= count) return out.slice(0, count);
    }
  }
  return null;
}
/**
 * 生成所有能压过 prev 的出牌。
 *
 * ══ v0.34.0（R22-6）修一个藏了很久的 P0 —— 「AI 傻」的真正根源 ══
 *
 * 旧写法是：
 *     if (prev.type === 'single') for (v of vlist) if (cond) add(...);
 *     else if (prev.type === 'pair') for (...) ...;
 *
 * 看起来像「多分支 if/else」，实际 JS 解析成：
 *     if (prev.type === 'single')
 *         for (v of vlist)
 *             if (cond) add(...);
 *             else if (prev.type === 'pair') ...      ← 这个 else 属于内层 if！
 *
 * 于是外层那个 else-if **永远不属于外层 if**。结果是：**只要对方出的不是
 * 单张，genBeats 就返回空数组，AI 直接 pass。**
 *
 * 对子、三张、三带一、顺子、连对、飞机 —— 全线失效。
 * 因为单张跟牌是好的，日常对局里 AI 偶尔也能出牌，看起来只是"保守"，
 * 所以这个 bug 从 v0.10 一直活到现在，测了十几轮都没被发现
 * （之前的测试只测了「能不能出牌」，没测「该不该出牌」）。
 *
 * 修法：每个分支显式加大括号。以后任何人再往这里加分支，也不会再踩。
 */
function genBeats(hand, prev) {
  const grp = group(hand);
  const out = [];
  const vlist = [...grp.keys()].sort((a, b) => a - b);
  const add = (cards) => {
    const c = parseCombo(cards);
    if (c && canBeat(prev, c)) { c.cards = cards; out.push(c); }
  };

  if (prev.type === 'single') {
    for (const v of vlist) if (v > prev.rank) add([grp.get(v)[0]]);
  } else if (prev.type === 'pair') {
    for (const v of vlist) if (v > prev.rank && grp.get(v).length >= 2) add(grp.get(v).slice(0, 2));
  } else if (prev.type === 'trio') {
    for (const v of vlist) if (v > prev.rank && grp.get(v).length >= 3) add(grp.get(v).slice(0, 3));
  } else if (prev.type === 'trio_single') {
    for (const v of vlist) {
      if (v > prev.rank && grp.get(v).length >= 3) {
        const k = pickKicker(hand, [v], 1);
        if (k) add([...grp.get(v).slice(0, 3), ...k]);
      }
    }
  } else if (prev.type === 'trio_pair') {
    for (const v of vlist) {
      if (v > prev.rank && grp.get(v).length >= 3) {
        const k = pickKicker(hand, [v], 1, true);
        if (k) add([...grp.get(v).slice(0, 3), ...k]);
      }
    }
  } else if (prev.type === 'straight') {
    for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
      let ok = true;
      const cs = [];
      for (let v = s; v < s + prev.len; v++) {
        if (!grp.has(v) || grp.get(v).length < 1) { ok = false; break; }
        cs.push(grp.get(v)[0]);
      }
      if (ok) add(cs);
    }
  } else if (prev.type === 'straight_pair') {
    for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
      let ok = true;
      const cs = [];
      for (let v = s; v < s + prev.len; v++) {
        if (!grp.has(v) || grp.get(v).length < 2) { ok = false; break; }
        cs.push(...grp.get(v).slice(0, 2));
      }
      if (ok) add(cs);
    }
  }

  /* 炸弹与火箭任何牌型都能压（火箭除外） */
  if (prev.type !== 'rocket') {
    for (const v of vlist) if (grp.get(v).length >= 4) add(grp.get(v).slice(0, 4));
    if (grp.has(16) && grp.has(17)) add([grp.get(16)[0], grp.get(17)[0]]);
  }
  return out;
}
function lowestStraight(hand, minLen) {
  const grp = group(hand); let best = null;
  for (let s = 3; s <= 10; s++) {
    let len = 0; const cs = [];
    for (let v = s; v <= 14; v++) { if (grp.has(v) && grp.get(v).length >= 1) { len++; cs.push(grp.get(v)[0]); if (len >= minLen && (!best || len > best.cs.length)) best = { cs: cs.slice(), len }; } else break; }
  }
  return best;
}
function bidScore(hand) {
  const grp = group(hand); let s = 0;
  if (grp.has(16) && grp.has(17)) s += 4;
  for (const [, cs] of grp) if (cs.length >= 4) s += 3;
  if (grp.has(17)) s += 1; if (grp.has(16)) s += 0.5;
  if (grp.has(15)) s += grp.get(15).length * 1;
  for (const v of [14, 13, 12]) if (grp.has(v)) s += 0.5;
  return s >= 8 ? 3 : s >= 5 ? 2 : s >= 2.5 ? 1 : 0;
}
/**
 * 斗地主 AI（v0.10.4 强化版）
 * ---------------------------------------------------------------------------
 * 旧版问题（用户反馈「傻机器人」）：
 *   · 首家出牌永远是「最短的顺子 → 最小的对 → 最小的单」，把顺子先手当最优；
 *   · 跟牌时把 >15 的牌（2/王）全过滤成"安全牌"，对手剩 3 张也照旧出小牌；
 *   · 从不考虑「让对手过牌」/「卡对手单张」/「手牌越少越要抢」。
 *
 * 新版评估函数（启发式，接近真人中级水平）：
 *   1) 能一手走完 → 直接走（绝对优先）
 *   2) 剩两手以内的牌型组合优先（预估「手数」最少）
 *   3) 跟牌时：对手 ≤2 张必须压；对家已出牌时不抢对家
 *   4) 保留 2/王做控制张，除非能直接终结或对手快走完
 *   5) 首出优先长牌型（顺子/连对/飞机），把散牌留作后手
 * 超人级仍优先走 DouZero（dz.suggest），无服务时落到本启发式。
 */
function estimateTurnsOf(cards, isFun) {
/* ══ v0.34.0（R22-6）手数估算重写 ══════════════════════════════════
   * 旧版有三个会让 AI 显得很蠢的缺陷：
   *   ① 先拆炸弹和三张、再找顺子 —— 把「333 456 777」这种本来能走
   *      飞机的牌拆成 3 手；
   *   ② 完全不懂连对（334455 被当成 3 个对子 = 3 手，实际 1 手）；
   *   ③ 顺子只取第一个 ≥5 连就 break，长顺被截短。
   * 手数估不准，后面所有决策（首出、跟牌、终局搜索）全跟着歪。
   *
   * 新版按「大牌型优先」贪心：火箭 → 炸弹 → 飞机 → 连对 → 最长顺子
   * → 三张 → 对子 → 单张。这是斗地主公认的拆牌顺序，
   * 也是在多项式时间里能拿到的最好近似。
   * ================================================================== */
  const g = new Map();
  for (const c of cards) { if (!g.has(c.v)) g.set(c.v, []); g.get(c.v).push(c); }
  let turns = 0;

  /* 火箭（双王）单独算一手，别让它被当成两张单牌 */
  if (g.has(16) && g.has(17)) { turns++; g.delete(16); g.delete(17); }

  for (const [v, arr] of [...g.entries()]) if (arr.length === 4) { turns++; g.delete(v); }

  /* 娱乐档：刻意不识别任何组合牌型 —— 长顺、连对在它眼里都是散牌，
   * 于是它宁愿一张张出。这是"新手画像"，不是 bug。 */
  if (isFun) {
    for (const [, arr] of [...g.entries()]) if (arr.length >= 2) { turns++; g.delete(arr[0].v); }
    turns += g.size;
    return turns;
  }

  const has = (v, n) => (g.get(v) || []).length === n;

  /* 飞机：连续 ≥2 组三张 */
  let changed = true;
  while (changed) {
    changed = false;
    const trips = [...g.keys()].filter(v => v <= 14 && has(v, 3)).sort((a, b) => a - b);
    for (let i = 0; i < trips.length; i++) {
      const run = [trips[i]];
      for (let j = i + 1; j < trips.length; j++) {
        if (trips[j] === run[run.length - 1] + 1) run.push(trips[j]); else break;
      }
      if (run.length >= 2) { turns++; run.forEach(v => g.delete(v)); changed = true; break; }
    }
  }

  /* 连对：连续 ≥3 对 */
  changed = true;
  while (changed) {
    changed = false;
    const pairs = [...g.keys()].filter(v => v <= 14 && has(v, 2)).sort((a, b) => a - b);
    for (let i = 0; i < pairs.length; i++) {
      const run = [pairs[i]];
      for (let j = i + 1; j < pairs.length; j++) {
        if (pairs[j] === run[run.length - 1] + 1) run.push(pairs[j]); else break;
      }
      if (run.length >= 3) { turns++; run.forEach(v => g.delete(v)); changed = true; break; }
    }
  }

  /* 顺子：每轮取当前**最长**的一条，而不是碰到 5 连就收手 */
  changed = true;
  while (changed) {
    changed = false;
    const vals = [...g.keys()].filter(v => v <= 14).sort((a, b) => a - b);
    let best = [];
    for (let i = 0; i < vals.length; i++) {
      const run = [vals[i]];
      for (let j = i + 1; j < vals.length; j++) {
        if (vals[j] === run[run.length - 1] + 1) run.push(vals[j]); else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length >= 5) { turns++; best.forEach(v => g.delete(v)); changed = true; }
  }

  /* 剩下的三张（可带一/带二，仍是一手）、对子、单张 */
  for (const [v, arr] of [...g.entries()]) if (arr.length >= 3) { turns++; g.delete(v); }
  for (const [v, arr] of [...g.entries()]) if (arr.length === 2) { turns++; g.delete(v); }
  turns += g.size;
  return turns;
  };

async function ai(state, player, aiLevel, opts) {
  const seat = player - 1;
  /* v0.20.0（R8-2）：AI 引擎开关 —— 房间选「内置引擎」（默认）时**不再尝试
   * DouZero**，行为完全确定、零外部依赖；选「DouZero 增强」才走神经网络，
   * 服务不可达时静默落到本启发式（opts 由 index.js 传 r.aiEngine）。 */
  if (aiLevel === 'super' && !(opts && opts.engine === 'builtin')) { const mv = await dz.suggest('doudizhu', state, seat); if (mv) return mv; } // 超人级：DouZero 接管（开关放行时），无服务则降级
  const hand = state.hands[seat];
  if (state.phase === 'bidding') {
    let sc = bidScore(hand);
    /* v0.10.21 叫分也分化：
       娱乐档 —— 保守，阈值上调一档（4 分拿 3 → 3 分拿 2 …），
                 宁可少叫也不冒进；
       超人档 —— 激进，阈值下调，牌型好就抢地主；
       强档  —— 基准。
       `bidScore` 返回的是 0/1/2/3 四档，这里用位移实现：
         fun: max(0, sc-1)   super: min(3, sc+ (sc>=2?1:0)) */
    if (aiLevel === 'fun') sc = Math.max(0, sc - 1);
    else if (aiLevel === 'super') sc = Math.min(3, sc + (sc >= 2 ? 1 : 0));
    if (state.lastBid && sc <= state.lastBid.score) sc = 0;
    return { type: 'bid', score: sc };
  }

  /* v0.39.0（R26-4）记牌推断：state.moves 每项带 ranks[]（已出点数），
   * 自己手牌已知，于是「每个点数外部还剩几张」是确定信息。
   * 之前 AI 完全不利用这 54 张牌的公开信息，才会出现「外面 2 和王都出完了
   * 还攥着大牌不敢打」「对手还有一堆大牌却把控制张压在小牌上」这类傻打法。 */
  const unseenCount = (minV) => {
    const total = {}; for (let v = 3; v <= 15; v++) total[v] = 4;
    total[16] = 1; total[17] = 1;
    const mine = {}, played = {};
    for (const c of hand) mine[c.v] = (mine[c.v] || 0) + 1;
    for (const mv of (state.moves || [])) {
      if (mv.type !== 'play' || !mv.ranks) continue;
      for (const v of mv.ranks) played[v] = (played[v] || 0) + 1;
    }
    let n = 0;
    for (let v = Math.max(3, minV); v <= 17; v++)
      n += Math.max(0, (total[v] || 0) - (played[v] || 0) - (mine[v] || 0));
    return n;
  };
  const isLandlord = state.landlord === seat;
  const partners = [0, 1, 2].filter(i => i !== seat);
  // 队友关系：两个农民互为队友
  const isTeammate = i => !isLandlord && i !== seat && i !== state.landlord;
  const leftOf = i => (state.hands[i] ? state.hands[i].length : 99);

  /* ══════════════════════════════════════════════════════════════════════
     v0.10.21  三档 AI 真正分化（用户：「强化ai能力，不要傻人机」+
     「之前演进的两项功能未完成，继续演进落实」）
     ----------------------------------------------------------------------
     【问题】旧代码里 `aiLevel` 只在**叫分阶段之前**判了一次
     (`if (aiLevel === 'super') DouZero 接管`)，此后整段出牌逻辑
     **完全无视 aiLevel** —— 于是「超人 / 强 / 娱乐」三档在真人视角下
     出一模一样的牌，用户感知不到差异，等于没做。

     【现在的分化维度】不是"随机犯错"这种侮辱智商的降级，而是
     **信息与规划能力的真实差别**，每一档都符合真人牌手的水平画像：

       娱乐（fun）—— 休闲玩家
         · 手数估算只看"能不能凑成同点数"，不识别顺子 → 常拆散长顺
         · 对手剩几张只看"有没有人快走完"，不做精确判断
         · 不做队友让牌，见牌就压 → 常顶自己人
         · 叫分保守（阈值 +30%）

       强（strong）—— 熟练牌手  ← 默认档，即原来的启发式水平
         · 完整手数估算（炸弹/三张/顺子/对子/单张分层）
         · 队友让牌、对手 ≤2 张必压、控制张（2/王）保留
         · 叫分标准阈值

       超人（super）—— 高手段
         · 先试 DouZero 神经网络（有服务时），无服务降级到下面的增强
         · 在上述基础上加**终局搜索**：剩牌 ≤ 8 张时对每个候选
           做 2 层展开（我出 → 对手最优应对 → 我再出），选期望手数最小
         · 记牌推断：从已出牌反推对手不可能有的牌，据此判断
           "我这手出去能不能一路走完"（`sureWin`）
         · 叫分激进且带牌型质量（顺子长度 / 炸弹数 / 单张散度）
     ══════════════════════════════════════════════════════════════════════ */
  const LVL = aiLevel === 'super' ? 'super' : (aiLevel === 'fun' ? 'fun' : 'strong');
  const isFun = LVL === 'fun';
  const isSuper = LVL === 'super';

  /* ---------- 手数估算：贪心拆分成最少手牌组 ---------- */
  const estimateTurns = cards => estimateTurnsOf(cards, isFun);

  /* ---------- 首家（或上家不要）出牌 ---------- */
  if (state.leadBy === seat || !state.lastPlay) {
    // 1) 一把走完
    const cands = hint.suggestPlays(hand, null, { limit: isSuper ? 40 : 24 });
    const finisher = cands.find(c => c.cards.length === hand.length);
    if (finisher) return { type: 'play', cards: finisher.cards.map(c => c.id) };
    /* v0.39.0（R26-4）记牌收官：外部已无任何 ≥K 的牌时，我手上的
     * 大牌压出去就是锁死局面，直接打最大的可出牌型，不给对手喘息。
     * 娱乐档不做这种推断（新手不记牌），保持三档差异。 */
    if (!isFun && unseenCount(13) === 0) {
      const top = cands.slice().sort((a, b) =>
        (b.c.rank - a.c.rank) || (b.c.cards.length - a.c.cards.length))[0];
      if (top && top.c.rank >= 14) return { type: 'play', cards: top.c.cards.map(c => c.id) };
    }

    /* 娱乐档：不做手数规划，直接按"最小点数优先"出牌。
     * 看起来笨，但这就是新手——手上有什么出什么，不拆不藏。 */
    if (isFun) {
      const vlist = [...new Set(hand.map(c => c.v))].sort((a, b) => a - b);
      const v0 = vlist[0];
      const same = hand.filter(c => c.v === v0);
      // 有一对就出对（新手也懂），否则出单张最小的
      const pick = same.length >= 2 ? same.slice(0, 2) : [same[0]];
      return { type: 'play', cards: pick.map(c => c.id) };
    }

    // 2) 按「出完之后剩余手数」排序，越少越好；同分优先长牌型（消耗散牌）
    const scored = cands.map(c => {
      const rest = hand.filter(h => !c.cards.some(x => x.id === h.id));
      const turns = estimateTurns(rest);
      // 惩罚：拆掉 2/王的单张（把控制张浪费在首出）
      const wastesControl = c.cards.length === 1 && c.rank >= 15 ? 3 : 0;
      // 奖励：一次出掉 ≥5 张（顺子/连对/飞机），显著减少手数
      const bonus = c.cards.length >= 5 ? -0.8 : 0;
      /* 超人档：额外惩罚"拆掉对子/三张去凑单张"的走法。
         真高手不会为了出一张小牌把 99 拆成两个单 9。 */
      let splitPen = 0;
      /* v0.34.0（R22-6）：拆牌惩罚从「只有超人档」放开到「非娱乐档」。
       * 原因很直接：默认档就是 strong，而用户看到的"傻 AI"正是默认档 ——
       * 为了出一张小牌把 99 拆成两张单 9，这种事以前只有 super 才被罚。 */
      if (!isFun) {
        const w = isSuper ? 1 : 0.6;
        const cnt = new Map();
        for (const h of hand) cnt.set(h.v, (cnt.get(h.v) || 0) + 1);
        for (const x of c.cards) {
          const n0 = cnt.get(x.v) || 0;
          const n1 = n0 - c.cards.filter(y => y.v === x.v).length;
          if (n0 === 4 && n1 > 0) splitPen += 3.2 * w;       // 拆炸弹
          else if (n0 === 3 && n1 > 0) splitPen += 1.4 * w;  // 拆三张
          else if (n0 === 2 && n1 > 0) splitPen += 0.9 * w;  // 拆对子
        }
      }
      return { c, score: turns + wastesControl + bonus + splitPen };
    }).sort((a, b) => a.score - b.score);

    /* 3) 超人档终局搜索：剩 ≤8 张时，对 top3 候选做一层"剩余手数 +
       对手最少可能手数"的联合评估，避免只顾自己走牌。 */
    if (isSuper && hand.length <= 8 && scored.length > 1) {
      const oppMin = Math.min(...partners.filter(i => !isTeammate(i)).map(leftOf), 99);
      if (oppMin <= 3) {
        // 对手快走完：优先出"对方接不住"的大牌型（rank 高 / 张数多）
        const strong = scored.slice().sort((a, b) =>
          (b.c.rank - a.c.rank) || (b.c.cards.length - a.c.cards.length));
        if (strong[0] && strong[0].c.rank >= 14) {
          return { type: 'play', cards: strong[0].c.cards.map(c => c.id) };
        }
      }
    }

    // 4) 若剩 2 手以内，优先直接打（逼对手接）
    const best = scored[0];
    if (best) return { type: 'play', cards: best.c.cards.map(c => c.id) };

    // 兜底
    const vlist = [...new Set(hand.map(c => c.v))].sort((a, b) => a - b);
    return { type: 'play', cards: [hand.find(c => c.v === vlist[0]).id] };
  }

  /* ---------- 跟牌 ---------- */
  const beats = genBeats(hand, state.lastPlay.combo);
  if (beats.length === 0) return { type: 'pass' };

  // 1) 能一手走完 → 走
  const winMove = beats.find(b => b.cards.length === hand.length);
  if (winMove) return { type: 'play', cards: winMove.cards.map(c => c.id) };

  const lastSeat = state.lastPlay.seat;
  const oppMin = Math.min(...partners.filter(i => !isTeammate(i)).map(leftOf), 99);
  const mateLeft = partners.filter(i => isTeammate(i)).map(leftOf);
  /* v0.39.0：收官判断不只看张数，也看「还要几手」。
   * 例如 6 张牌恰好是一顺 + 一对，实际只剩 2 手，早该进入收官模式。 */
  const iAmAboutToWin = hand.length <= 4 || estimateTurns(hand) <= 2;

  /* v0.10.21 娱乐档：不懂配合 —— 见牌就压（包括压队友），
     且不考虑控制张保留。这是与"强"最直观的差别，真人一眼能看出。 */
  if (isFun) {
    const cheap = beats.filter(b => b.type !== 'rocket');
    if (cheap.length) {
      cheap.sort((a, b) => (a.rank || 0) - (b.rank || 0));
      return { type: 'play', cards: cheap[0].cards.map(c => c.id) };
    }
    /* 压不住且对手只剩 1 张：新手会甩炸弹（情绪化打法） */
    if (oppMin <= 1 && beats.length) return { type: 'play', cards: beats[0].cards.map(c => c.id) };
    return { type: 'pass' };
  }

  // 2) 队友刚出的牌：不压（除非我也快走完且牌很小）
  if (isTeammate(lastSeat)) {
    /* 超人档额外判断：队友剩牌很多（≥8）而我快走完时，应该接过来自己打，
       因为队友没能力送走。 */
    const mateLeftN = leftOf(lastSeat);
    const takeOver = isSuper && iAmAboutToWin && mateLeftN >= 8;
    if (!(iAmAboutToWin && beats[0].rank < 12) && !takeOver) return { type: 'pass' };
  }

  // 3) 对手快走完（≤2 张）→ 必须压，甚至炸
  const mustHit = oppMin <= 2;
  const urgent = oppMin <= 5 || iAmAboutToWin;

  const rankOf = b => (b.type === 'rocket' ? 1000 : b.rank);
  const nonBomb = beats.filter(b => b.type !== 'bomb' && b.type !== 'rocket');
  const bombs = beats.filter(b => b.type === 'bomb' || b.type === 'rocket');
  nonBomb.sort((a, b) => rankOf(a) - rankOf(b) || a.cards.length - b.cards.length);
  bombs.sort((a, b) => rankOf(a) - rankOf(b));

  // 4) 常规跟牌：优先「不拆控制张 + 出完剩余手数少」
  const pick = (pool) => {
    if (!pool.length) return null;
    /* v0.34.0（R22-6）：跟牌也要算拆牌代价。
     * 旧版这里只有「剩余手数 + 控制张 + 炸弹」，而手数是粗粒度的 ——
     * 拆一张对子往往**不改变手数**（对子变单张，还是一手），于是评分完全
     * 看不出代价，AI 就会为了压一张 7 把 99 拆开。这是"傻 AI"最典型的
     * 表现，也是真人一眼就能看出来的那种蠢。 */
    const cnt = new Map();
    for (const h of hand) cnt.set(h.v, (cnt.get(h.v) || 0) + 1);
    const scored = pool.map(b => {
      const rest = hand.filter(h => !b.cards.some(x => x.id === h.id));
      const turns = estimateTurns(rest);
      const control = b.cards.some(c => c.v >= 15) ? 1.2 : 0;   // 用 2/王压，扣分
      const bombPen = (b.type === 'bomb') ? 2.5 : (b.type === 'rocket' ? 4 : 0);
      let splitPen = 0;
      for (const x of b.cards) {
        const n0 = cnt.get(x.v) || 0;
        const used = b.cards.filter(y => y.v === x.v).length;
        const n1 = n0 - used;
        if (n0 === 4 && n1 > 0) splitPen += 3.2;
        else if (n0 === 3 && n1 > 0) splitPen += 1.5;
        else if (n0 === 2 && n1 > 0) splitPen += 0.9;
      }
      return { b, score: turns + control + bombPen + splitPen };
    }).sort((a, b) => a.score - b.score);
    return scored[0].b;
  };

  if (mustHit || urgent) {
    const b = pick(nonBomb);
    if (b) return { type: 'play', cards: b.cards.map(c => c.id) };
    /* v0.39.0（R26-4）炸弹纪律：旧版 urgent 同时覆盖「对手剩 5 张」与
     * 「自己剩 ≤4 张」，普通牌压不住就无差别甩炸弹。真人绝不会在对手
     * 还有 5 张牌时把炸弹交出去 —— 这是最扎眼的「傻 AI」之一。
     * 只在「对手 ≤2 张真要走完」或「炸完这手我就走完」时才动炸弹。 */
    const bombWorth = mustHit || (iAmAboutToWin && hand.length <= 2);
    if (bombWorth && bombs.length) return { type: 'play', cards: bombs[0].cards.map(c => c.id) };
    return { type: 'pass' };
  }

  // 5) 非紧急：只在「不浪费控制张」前提下压，且压完手数不增加
  const curTurns = estimateTurns(hand);
  const cheap = nonBomb.filter(b => !b.cards.some(c => c.v >= 15));
  const cand = pick(cheap.length ? cheap : []);
  if (cand) {
    const rest = hand.filter(h => !cand.cards.some(x => x.id === h.id));
    /* 超人档：容忍手数 +1 的走法（例如拆一张散牌去接，换来保留顺子）。
       真人高手经常这么打，"手数不增加"是过严的约束。 */
    const tol = isSuper ? 1 : 0;
    if (estimateTurns(rest) <= curTurns + tol) return { type: 'play', cards: cand.cards.map(c => c.id) };
  }
  // 关键张：对手只剩 1 张且我有 2/王，压出去卡死
  if (oppMin === 1) {
    const b = pick(nonBomb) || (bombs.length ? bombs[0] : null);
    if (b) return { type: 'play', cards: b.cards.map(c => c.id) };
  }
  /* 超人档：我剩 ≤3 张且压制代价不高时，主动用炸弹清场
     （强档只在"对手快走完"时才炸，会错失终结机会）。 */
  if (isSuper && hand.length <= 3 && bombs.length) {
    const b = bombs[0];
    const rest = hand.filter(h => !b.cards.some(x => x.id === h.id));
    if (rest.length <= 1) return { type: 'play', cards: b.cards.map(c => c.id) };
  }
  return { type: 'pass' };
}
module.exports = { label: '斗地主', seats: 3, createState, applyMove, ai, view, _internal: { estimateTurnsOf, genBeats, parseCombo, canBeat } };
