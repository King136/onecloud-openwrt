// 积分系统（v0.12.0 / R2-2）
// ══════════════════════════════════════════════════════════════════════════
// 用户反馈：「战绩面板和积分面板都是虚假数据，纯是死板展示，没有接入有效的
// 实时数据，需要从专业逻辑方面进行修复。」
//
// 病根诊断（读代码得出的，不是猜的）：
//   老实现的「段位」是 `rankOf(levelOf())`，而 levelOf 只做一件事 ——
//       level = 1 + floor(sqrt(games) * 2)
//   也就是说段位只跟「打了多少局」有关，跟「赢了还是输了」完全无关。
//   一个连输 200 局的人，段位比一个 20 战全胜的人还高。
//   这确实是「死板展示」——数字在动，但语义是错的，越看越假。
//
// 现在的口径（Elo 体系，棋牌类事实标准）：
//   · 每个游戏**独立**一个分（斗地主的分不带进象棋）—— 棋力和牌力是两件事；
//     全局展示时取「主力游戏」的分（局数最多的那个），而不是简单平均。
//   · 初始 1000 分，K 值分段递减（前 15 局 K=40，快速定级；之后 K=24；
//     1800 分以上 K=16），这是 FIDE 与主流对战平台通行的做法。
//   · 期望胜率 E = 1 / (1 + 10^((Ropp - R)/400))
//   · 得分变化 = round(K × (S - E))，S ∈ {1, 0.5, 0}
//   · 对手强度 Ropp：
//       - 真人：各自该游戏当前分
//       - AI：按档位折算固定强度（见 AI_RATING），所以「打赢超人」涨得多、
//         「打赢娱乐」几乎不涨 —— 这正是用户说的「专业逻辑」。
//   · 多人局（斗地主 3 人、麻将 4 人）：对每个真人对手两两结算，
//     再把增量做**零和归一**，保证「我涨的分 = 别人掉的分」，
//     不会出现「一桌人整体通胀」。
//
// 段位映射（按分数分段，不再是按局数）：
//   1030 以下 新手 / 1150 入门 / 1300 棋士 / 1450 高手 / 1600 精英
//   / 1800 大师 / 2000 宗师 / 2200 棋圣
//   另设「定级赛」概念：不足 10 局显示「定级中」，避免打一局就被贴标签。
// ══════════════════════════════════════════════════════════════════════════

/** AI 档位 → 折算实力分。打赢超人 +大分，打赢娱乐 ≈ 0 分。 */
const AI_RATING = {
  super: 1750,   // DouZero / Stockfish 最高档
  strong: 1400,  // 内置启发式强档
  fun: 1050,     // 娱乐档：略高于新手，输了掉分很少
};

const BASE = 1000;
const PLACE_MS = 10;      // 定级局数：不足则显示「定级中」

function kFactor(rating, games) {
  if (games < 15) return 40;      // 前 15 局快速收敛
  if (rating >= 1800) return 16;  // 高分段防通胀
  return 24;
}

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

/** 单个游戏的一条评分记录 */
function blankGame() {
  return { rating: BASE, games: 0, peak: BASE, lastDelta: 0, everRated: false };
}

/**
 * 计算一局中每个真人玩家的分数变化。
 * @param {Array} players [{ pid, rating, games, outcome: 'win'|'loss'|'draw' }]
 * @returns {Map} pid -> { delta, rating, before, exp }
 *
 * 设计要点：增量做零和归一。
 *   原始 Elo 双人局天然零和；但多人局（1 胜 2 负）里，
 *   赢家只按一个对手算增量、输家各按一个赢家算减量，总量并不平衡。
 *   这里先算原始增量，再按「胜方总增 = 负方总减」的比例缩放，
 *   保证每一局都是零和 —— 全平台总分恒定，分数才有可比性。
 */
function computeDeltas(players) {
  const out = new Map();
  if (!players || players.length < 2) {
    for (const p of players || []) out.set(p.pid, { delta: 0, rating: p.rating, before: p.rating, exp: 0.5 });
    return out;
  }
  const raw = new Map();
  for (const p of players) {
    let sumDelta = 0, sumExp = 0, n = 0;
    for (const q of players) {
      if (q === p) continue;
      const e = expected(p.rating, q.rating);
      const s = p.outcome === 'win' ? 1 : p.outcome === 'draw' ? 0.5 : 0;
      sumDelta += kFactor(p.rating, p.games) * (s - e);
      sumExp += e; n++;
    }
    raw.set(p.pid, { delta: sumDelta / Math.max(1, n), exp: n ? sumExp / n : 0.5 });
  }
  // 零和归一：把所有增量按符号分组，缩放使两侧绝对值相等
  let posSum = 0, negSum = 0;
  for (const v of raw.values()) { if (v.delta > 0) posSum += v.delta; else if (v.delta < 0) negSum -= v.delta; }
  const posScale = posSum > 0 ? (negSum > 0 ? negSum / posSum : 1) : 1;
  for (const p of players) {
    const v = raw.get(p.pid);
    const scaled = v.delta > 0 ? v.delta * posScale : v.delta;
    const delta = Math.round(scaled);
    out.set(p.pid, {
      delta, before: Math.round(p.rating), rating: Math.round(p.rating + delta),
      exp: Math.round(v.exp * 100) / 100,
    });
  }
  return out;
}

/* 段位分段 —— 按分数，不看局数 */
const TIERS = [
  [2200, '棋圣', 't-saint'],
  [2000, '宗师', 't-grand'],
  [1800, '大师', 't-master'],
  [1600, '精英', 't-elite'],
  [1450, '高手', 't-skilled'],
  [1300, '棋士', 't-adept'],
  [1150, '入门', 't-novice'],
  [0, '新手', 't-rookie'],
];

function tierOf(rating, games) {
  if (!games || games < PLACE_MS) {
    return { name: '定级中', key: 't-place', rating: Math.round(rating || BASE), place: true, next: 1150 };
  }
  for (const [min, name, key] of TIERS) {
    if (rating >= min) {
      const idx = TIERS.findIndex(t => t[0] === min);
      const next = idx > 0 ? TIERS[idx - 1][0] : null;
      return { name, key, rating: Math.round(rating), next };
    }
  }
  return { name: '新手', key: 't-rookie', rating: Math.round(rating), next: 1150 };
}

module.exports = { AI_RATING, BASE, PLACE_MS, computeDeltas, tierOf, kFactor, expected, blankGame, TIERS };
