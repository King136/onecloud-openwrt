// 智能出牌辅助（第二波 M2）
// 设计目标：一次请求返回「多组候选，由小到大排序」，前端「提示」按钮连点循环切换。
// 与 AI 的区别：AI 只给一个最优解（会考虑对手手牌数、局势博弈）；
//              提示要给人类玩家「所有可选项」，按牌型分组、按点数升序，让玩家自己决策。
const { parseCombo, canBeat, counts } = require('./cards');

const TYPE_LABEL = {
  single: '单张', pair: '对子', trio: '三张', trio_single: '三带一', trio_pair: '三带二',
  straight: '顺子', straight_pair: '连对', plane: '飞机', plane_single: '飞机带单',
  plane_pair: '飞机带对', bomb: '炸弹', rocket: '王炸',
};

// ───────────────────────── 基础工具 ─────────────────────────
function groupByValue(hand) {
  const m = new Map();
  for (const c of hand) {
    if (!m.has(c.v)) m.set(c.v, []);
    m.get(c.v).push(c);
  }
  return m;
}

// 牌型的中文描述（用于播报/提示文案），例：Q Q Q 5 5 -> "三个Q带一对5"
const RANK_MID = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
function cnRank(v) { return RANK_MID[v] || String(v); }

function describe(cards) {
  const combo = parseCombo(cards);
  if (!combo) return `${cards.length} 张`;
  const m = counts(cards);
  const vals = Object.keys(m).map(Number).sort((a, b) => a - b);
  switch (combo.type) {
    case 'single': return cnRank(combo.rank);
    case 'pair': return `对${cnRank(combo.rank)}`;
    case 'trio': return `三个${cnRank(combo.rank)}`;
    case 'trio_single': { const k = vals.find(v => m[v] === 1); return `三个${cnRank(combo.rank)}带${cnRank(k)}`; }
    case 'trio_pair': { const k = vals.find(v => m[v] === 2); return `三个${cnRank(combo.rank)}带一对${cnRank(k)}`; }
    case 'straight': return `顺子 ${cnRank(vals[0])}~${cnRank(vals[vals.length - 1])}`;
    case 'straight_pair': return `连对 ${cnRank(vals[0])}~${cnRank(vals[vals.length - 1])}`;
    case 'plane': return `飞机 ${combo.len}组`;
    case 'plane_single': return `飞机带单 ${combo.len}组`;
    case 'plane_pair': return `飞机带对 ${combo.len}组`;
    case 'bomb': return cards.length === 4 ? `炸弹${cnRank(combo.rank)}` : `${cards.length}张炸弹${cnRank(combo.rank)}`;
    case 'rocket': return '王炸';
    default: return TYPE_LABEL[combo.type] || `${cards.length} 张`;
  }
}

// 从手牌里挑 n 张「最小代价」的垫牌：优先拆孤张，避开炸弹、2、王
function pickKickers(hand, excludeVals, count, needPair) {
  const grp = groupByValue(hand);
  const out = [];
  const cand = [...grp.keys()]
    .filter(v => !excludeVals.includes(v))
    .filter(v => v < 15)                             // 不用 2/王 垫牌
    .filter(v => grp.get(v).length < 4)              // 不拆炸弹
    .filter(v => (needPair ? grp.get(v).length >= 2 : true))
    .sort((a, b) => {
      // 优先用「孤张」：张数少的先出；其次点数小的先出
      const ca = grp.get(a).length, cb = grp.get(b).length;
      return ca - cb || a - b;
    });
  for (const v of cand) {
    const take = needPair ? Math.min(2, grp.get(v).length) : 1;
    out.push(...grp.get(v).slice(0, take));
    if (out.length >= count) return out.slice(0, count);
  }
  return null;
}

// ───────────────────────── 候选生成 ─────────────────────────

// 自由出牌（自己首家）时，给出「推荐主动出的牌型」组合
function candidatesWhenLeading(hand) {
  const grp = groupByValue(hand);
  const vals = [...grp.keys()].sort((a, b) => a - b);
  const res = [];
  const push = (cards) => {
    const combo = parseCombo(cards);
    if (combo) res.push({ ...combo, cards });
  };

  // ① 最长顺子（≥5），由小到大
  for (let s = 3; s <= 10; s++) {
    let run = [];
    for (let v = s; v <= 14; v++) {
      if (grp.has(v) && grp.get(v).length >= 1) run.push(grp.get(v)[0]);
      else break;
    }
    if (run.length >= 5) push(run.slice());         // 取这一段的全部长度
  }

  // ② 连对（≥3 对）
  for (let s = 3; s <= 12; s++) {
    let run = [];
    for (let v = s; v <= 14; v++) {
      if (grp.has(v) && grp.get(v).length >= 2) run.push(...grp.get(v).slice(0, 2));
      else break;
    }
    if (run.length >= 6) push(run.slice());
  }

  // ③ 飞机（连续三张 ≥2 组），带牌补全
  const trios = vals.filter(v => grp.get(v).length >= 3 && v <= 14);
  for (let i = 0; i < trios.length; i++) {
    const seq = [trios[i]];
    for (let j = i + 1; j < trios.length; j++) {
      if (trios[j] === trios[j - 1] + 1) seq.push(trios[j]); else break;
    }
    if (seq.length >= 2) {
      const body = seq.flatMap(v => grp.get(v).slice(0, 3));
      push(body.slice());                                        // 纯飞机
      const ks = pickKickers(hand, seq, seq.length, false);
      if (ks) push([...body, ...ks]);                             // 飞机带单
      const kp = pickKickers(hand, seq, seq.length * 2, true);
      if (kp) push([...body, ...kp]);                             // 飞机带对
    }
  }

  // ④ 三带一 / 三带二
  for (const v of trios) {
    const t = grp.get(v).slice(0, 3);
    const k1 = pickKickers(hand, [v], 1, false);
    if (k1) push([...t, ...k1]);
    const k2 = pickKickers(hand, [v], 2, true);
    if (k2) push([...t, ...k2]);
  }

  // ⑤ 对子 / 单张（小牌优先）
  for (const v of vals) {
    if (grp.get(v).length >= 2 && grp.get(v).length < 4) push(grp.get(v).slice(0, 2));
  }
  for (const v of vals) {
    if (grp.get(v).length === 1) push(grp.get(v).slice(0, 1));
  }

  // ⑥ 炸弹 / 王炸（放最后，作为兜底）
  for (const v of vals) if (grp.get(v).length >= 4) push(grp.get(v).slice(0, 4));
  if (grp.has(16) && grp.has(17)) push([grp.get(16)[0], grp.get(17)[0]]);

  return res;
}

// 跟牌：给出所有能压过 prev 的组合，按「牌型同类优先、点数升序」排序
function candidatesWhenFollowing(hand, prev) {
  if (!prev) return [];
  const grp = groupByValue(hand);
  const vals = [...grp.keys()].sort((a, b) => a - b);
  const out = [];
  const add = (cards) => {
    const combo = parseCombo(cards);
    if (combo && canBeat(prev, combo)) out.push({ ...combo, cards });
  };
  const has = (v, n) => grp.has(v) && grp.get(v).length >= n;

  switch (prev.type) {
    case 'single':
      for (const v of vals) if (v > prev.rank && has(v, 1)) add([grp.get(v)[0]]);
      break;
    case 'pair':
      for (const v of vals) if (v > prev.rank && has(v, 2) && grp.get(v).length < 4) add(grp.get(v).slice(0, 2));
      break;
    case 'trio':
      for (const v of vals) if (v > prev.rank && has(v, 3)) add(grp.get(v).slice(0, 3));
      break;
    case 'trio_single':
      for (const v of vals) if (v > prev.rank && has(v, 3)) {
        const k = pickKickers(hand, [v], 1, false);
        if (k) add([...grp.get(v).slice(0, 3), ...k]);
      }
      break;
    case 'trio_pair':
      for (const v of vals) if (v > prev.rank && has(v, 3)) {
        const k = pickKickers(hand, [v], 2, true);
        if (k) add([...grp.get(v).slice(0, 3), ...k]);
      }
      break;
    case 'straight':
      for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
        const cs = [];
        let ok = true;
        for (let v = s; v < s + prev.len; v++) { if (!has(v, 1)) { ok = false; break; } cs.push(grp.get(v)[0]); }
        if (ok) add(cs);
      }
      break;
    case 'straight_pair':
      for (let s = prev.rank + 1; s + prev.len - 1 <= 14; s++) {
        const cs = [];
        let ok = true;
        for (let v = s; v < s + prev.len; v++) { if (!has(v, 2)) { ok = false; break; } cs.push(...grp.get(v).slice(0, 2)); }
        if (ok) add(cs);
      }
      break;
    case 'plane':
    case 'plane_single':
    case 'plane_pair': {
      const k = prev.len;
      const trios = vals.filter(v => grp.get(v).length >= 3 && v <= 14);
      for (let i = 0; i < trios.length; i++) {
        const seq = [trios[i]];
        for (let j = i + 1; j < trios.length; j++) {
          if (trios[j] === trios[j - 1] + 1) seq.push(trios[j]); else break;
        }
        for (let a = 0; a + k <= seq.length; a++) {
          const run = seq.slice(a, a + k);
          if (run[0] <= prev.rank) continue;
          const body = run.flatMap(v => grp.get(v).slice(0, 3));
          if (prev.type === 'plane') add(body);
          else if (prev.type === 'plane_single') {
            const ks = pickKickers(hand, run, k, false);
            if (ks) add([...body, ...ks]);
          } else {
            const kp = pickKickers(hand, run, k * 2, true);
            if (kp) add([...body, ...kp]);
          }
        }
      }
      break;
    }
    default: break;
  }

  // 炸弹 / 王炸永远可作为选项（除非本身就在比炸弹）
  if (prev.type !== 'rocket') {
    for (const v of vals) if (grp.get(v).length >= 4) add(grp.get(v).slice(0, 4));
    if (grp.has(16) && grp.has(17)) add([grp.get(16)[0], grp.get(17)[0]]);
  }

  // 排序：同牌型优先（跟得上就用同类牌，留住炸弹），其次点数升序
  out.sort((a, b) => {
    const sa = a.type === prev.type ? 0 : (a.type === 'rocket' ? 2 : 1);
    const sb = b.type === prev.type ? 0 : (b.type === 'rocket' ? 2 : 1);
    return sa - sb || a.rank - b.rank || a.cards.length - b.cards.length;
  });
  return out;
}

// 去重：同一组牌可能由多条路径生成
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const key = it.cards.map(c => c.v).sort((a, b) => a - b).join(',') + '|' + it.type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 生成提示候选
 * @param {Array} hand  自己手牌
 * @param {Object|null} prev  当前桌上待压的牌型（parseCombo 结果）；null 表示自己首家
 * @param {Object} opts  { limit: 最多返回几组, needBeatAll: 是否只保留能一手走完的 }
 * @returns {Array<{cards, type, rank, len, label, text}>}
 */
function suggestPlays(hand, prev, opts = {}) {
  const limit = opts.limit || 6;
  const raw = prev ? candidatesWhenFollowing(hand, prev) : candidatesWhenLeading(hand);
  const uniq = dedupe(raw);

  const items = uniq.map(c => ({
    cards: c.cards,
    type: c.type,
    rank: c.rank,
    len: c.len,
    label: TYPE_LABEL[c.type] || c.type,
    text: describe(c.cards),
    // 是否一手走完（牌数等于手牌数）
    wholeHand: c.cards.length === hand.length,
  }));

  // 能一手走完的永远排最前（玩家最需要看到「怎么一把出完」）
  // 首家出牌时（prev 为 null）按「出牌效率」排：一次出更多张优先，避免把顺子拆成单张打；
  // 跟牌时必须按同类牌型 + 点数升序，否则会出现「用炸弹顶单张」的荒谬建议。
  const TYPE_ORDER = {
    straight: 0, straight_pair: 1, plane: 2, plane_single: 2, plane_pair: 2,
    trio_single: 3, trio_pair: 3, trio: 4, pair: 5, single: 6, bomb: 8, rocket: 9,
  };
  items.sort((a, b) => {
    if (a.wholeHand !== b.wholeHand) return a.wholeHand ? -1 : 1;
    if (!prev) {
      // 首家：牌型价值优先（长牌型先打），同牌型内点数小者先
      const ta = TYPE_ORDER[a.type] ?? 7, tb = TYPE_ORDER[b.type] ?? 7;
      return ta - tb || a.rank - b.rank || b.cards.length - a.cards.length;
    }
    const sa = a.type === 'bomb' || a.type === 'rocket' ? 1 : 0;
    const sb = b.type === 'bomb' || b.type === 'rocket' ? 1 : 0;
    return sa - sb || a.rank - b.rank || a.cards.length - b.cards.length;
  });

  // 按「牌型 + 点数」去重后再截断，保证候选多样性
  const picked = [];
  const typeCount = {};
  for (const it of items) {
    const tc = typeCount[it.type] || 0;
    // 每种牌型最多留 3 个候选，避免全是「单张 3/4/5」占满
    if (tc >= 3 && !it.wholeHand) continue;
    typeCount[it.type] = tc + 1;
    picked.push(it);
    if (picked.length >= limit) break;
  }
  // 若截断后空空如也（全部被类型限制挡住），兜底返回前 limit 条
  if (!picked.length) return items.slice(0, limit);
  return picked;
}

/**
 * 牌型统计面板数据（算牌器 / 快捷选 共用）
 * 返回手牌按牌型可组成的组数，用于 UI 显示 chips
 */
function handSummary(hand) {
  const grp = groupByValue(hand);
  const vals = [...grp.keys()].sort((a, b) => a - b);
  let straight = 0, straightPair = 0, trio = 0, bomb = 0, pair = 0, single = 0;
  for (const v of vals) {
    const n = grp.get(v).length;
    if (n >= 4) bomb++;
    else if (n === 3) trio++;
    else if (n === 2) pair++;
    else single++;
  }
  for (let s = 3; s <= 10; s++) {
    let len = 0;
    for (let v = s; v <= 14; v++) { if (grp.has(v)) len++; else break; }
    if (len >= 5) { straight = Math.max(straight, len); }
  }
  for (let s = 3; s <= 12; s++) {
    let len = 0;
    for (let v = s; v <= 14; v++) { if (grp.has(v) && grp.get(v).length >= 2) len++; else break; }
    if (len >= 3) { straightPair = Math.max(straightPair, len); }
  }
  return { total: hand.length, single, pair, trio, bomb, straight, straightPair,
           hasRocket: grp.has(16) && grp.has(17) };
}

module.exports = { suggestPlays, describe, handSummary, TYPE_LABEL, cnRank };
