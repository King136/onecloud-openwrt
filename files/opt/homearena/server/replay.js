// 牌谱（v0.12.0 / R2-1）
// ══════════════════════════════════════════════════════════════════════════
// 用户要求补齐 R2-1「牌谱复盘与导出」。
//
// 现状问题（读代码）：
//   老的 room:replay 只回 `moves` 原样数组 + winner，前端那条 renderReplay 是
//   一排 JSON 文字 + 「上一手/下一手」。能看，但等于没做 ——
//      · 看不出「谁出了什么牌」，只有 seat 号和 type 字符串；
//      · 不能导出，想发给朋友复盘只能截图；
//      · 退出房间就没了（只存在于 r.state.moves）。
//
// 这里补三件事：
//   ① 结构化：把各游戏的 move 翻译成「人能读的一句话」（含牌名/坐标/动作）；
//   ② 可导出：JSON（完整机器可读）与 TXT（可读棋谱）两种；
//   ③ 可留存：对局结束时把牌谱存进 store（每 pid 保留最近 N 局），
//      在大厅「复盘」入口能翻历史，不只是当前房间。
//
// 为什么不做「逐步重放动画」：
//   各游戏 state 的演进依赖内部随机（洗牌）与 AI 决策，单纯重放 moves
//   无法复原中间手牌状态，做出来是假的。老老实实给「可读棋谱 + 手数索引」
//   比一个跑不起来的动画更专业。这一点写在导出文件头，避免误读。
// ══════════════════════════════════════════════════════════════════════════

const RL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣', '': '' };

function cardName(c) {
  if (!c) return '?';
  if (typeof c === 'string') {
    // 形如 S14 / H13 / JOKER
    if (c === 'JR' || c === 'joker_r') return '大王';
    if (c === 'JB' || c === 'joker_b') return '小王';
    const suit = SUIT[c[0]] || '';
    const v = Number(c.slice(1));
    const rank = RL[v] || (Number.isFinite(v) ? String(v) : c.slice(1));
    return suit + rank;
  }
  if (c.v === 17) return '大王';
  if (c.v === 16) return '小王';
  const s = SUIT[c.suit] || c.suit || '';
  const rank = RL[c.v] || c.v;
  return s + rank;
}

/** 一手牌 → 「♠A ♥2 …」，最多 8 张，多的用 +N 收口 */
function cardsLine(list) {
  const arr = (list || []).map(cardName);
  if (arr.length <= 8) return arr.join(' ');
  return arr.slice(0, 8).join(' ') + ` +${arr.length - 8}`;
}

const COMBO = {
  single: '单张', pair: '对子', trio: '三张', bomb: '炸弹', rocket: '王炸',
  straight: '顺子', straight_pair: '连对', trio_single: '三带一', trio_pair: '三带二',
  plane: '飞机', plane_single: '飞机带单', plane_pair: '飞机带对', four_two: '四带二',
};

/**
 * 把某游戏的 move 翻译成可读文本。
 * @param {string} game 游戏 id
 * @param {object} m    move 原对象
 * @param {object} ctx  { seatName(i) }
 */
function describeMove(game, m, ctx) {
  if (!m || typeof m !== 'object') return String(m);
  const who = m.seat != null && ctx && ctx.seatName ? ctx.seatName(m.seat) : (m.seat != null ? '座位' + (m.seat + 1) : '—');
  switch (game) {
    case 'doudizhu':
    case 'guandan':
      if (m.type === 'bid') return `${who} 叫 ${m.score || 0} 分`;
      if (m.type === 'pass') return `${who} 不出`;
      if (m.type === 'play') {
        const cb = m.combo && COMBO[m.combo.type] ? COMBO[m.combo.type] : (m.comboType ? (COMBO[m.comboType] || m.comboType) : '出牌');
        return `${who} 出${cb}：${cardsLine(m.cards)}`;
      }
      if (m.type === 'declare') return `${who} 亮主 ${m.suit || ''}`;
      return `${who} ${m.type || '动作'}`;
    case 'shengji':
      if (m.type === 'declare') return `${who} 亮主 ${m.suit === 'N' ? '无主' : (SUIT[m.suit] || m.suit || '')}`;
      if (m.type === 'bury') return `${who} 扣底 ${cardsLine(m.cards)}`;
      if (m.type === 'play') return `${who} 出 ${cardsLine(m.cards)}`;
      if (m.type === 'pass') return `${who} 不出`;
      return `${who} ${m.type || '动作'}`;
    case 'mahjong':
      if (m.type === 'discard' || m.tile) return `${who} 打 ${m.tile || m.t || '?'}`;
      if (m.type === 'peng') return `${who} 碰`;
      if (m.type === 'gang') return `${who} 杠`;
      if (m.type === 'hu') return `${who} 胡`;
      if (m.type === 'pass') return `${who} 过`;
      return `${who} ${m.type || '动作'}`;
    case 'texas':
      if (m.type === 'fold') return `${who} 弃牌`;
      if (m.type === 'call') return `${who} 跟注 ${m.amount || ''}`;
      if (m.type === 'raise') return `${who} 加注到 ${m.amount || ''}`;
      if (m.type === 'check') return `${who} 看牌`;
      if (m.type === 'allin') return `${who} 全下`;
      return `${who} ${m.type || '动作'}`;
    case 'chess':
      return `${who} ${m.san || ((m.from || '') + '→' + (m.to || ''))}`;
    case 'xiangqi':
      return `${who} ${(m.from && m.from.join ? m.from.join(',') : m.from || '')}→${(m.to && m.to.join ? m.to.join(',') : m.to || '')}`;
    case 'gomoku':
    case 'go':
      if (m.pass) return `${who} 虚手`;
      return `${who} 落 ${m.x != null ? (m.x + 1) : '?'},${m.y != null ? (m.y + 1) : '?'}`;
    case 'reversi':
      return `${who} 落 ${m.x != null ? m.x + 1 : '?'},${m.y != null ? m.y + 1 : '?'}`;
    case 'connect4':
      return `${who} 第 ${(m.col != null ? m.col + 1 : '?')} 列`;
    default:
      return `${who} ${m.type || JSON.stringify(m).slice(0, 60)}`;
  }
}

/* 各游戏的 move 里「谁动的手」字段并不统一：
 *   · 牌类（斗地主/掼蛋/双升/麻将/德州）用 seat，且是 **0 基**
 *   · 棋类（五子棋/象棋/国际象棋/围棋/黑白棋/四子棋）用 player，且是 **1 基**
 * 不归一化的话，牌谱里会出现「— 落 1,1」这种没有主语的手，
 * 或者 1 基当 0 基用导致「第 2 座的人下了第 1 座的手」。
 * 这里统一折算成 0 基 seat，并保留原始 player 便于 JSON 消费方自行判断。 */
function seatOf(m, gameId) {
  if (!m || typeof m !== 'object') return null;
  if (m.seat != null && Number.isFinite(+m.seat)) return +m.seat;
  if (m.player != null && Number.isFinite(+m.player)) return +m.player - 1;
  return null;
}

/* 各游戏 winner 的基准（与 index.js 的 TEAM_GAMES / winnerBase 语义保持一致）。
 * buildReplay 直接读 r.state，拿不到 serializeRoom 挂上的 winnerSeats，
 * 所以这里自己折算一次 —— 两边口径必须一致，否则牌谱里的「胜者」会和战绩页打架。 */
function winnersOf(game, st) {
  if (!st || st.winner == null || st.draw) return [];
  const w = st.winner;
  switch (game) {
    case 'gomoku': case 'chess': case 'xiangqi': case 'reversi': case 'go':
      return [Number(w) - 1];
    case 'guandan': case 'shengji':
      return [Number(w), Number(w) + 2];
    case 'doudizhu': {
      // R29-6：与 index.js 的 normalizeWinners 保持同一口径
      const lord = st.landlord;
      if (lord == null) return [Number(w)];
      return Number(w) === Number(lord) ? [Number(lord)]
        : [0, 1, 2].filter(i => i !== Number(lord));
    }
    default:
      return [Number(w)];
  }
}

/** 生成完整牌谱对象（JSON 导出用） */
function buildReplay(r, gameLabel) {
  const st = r.state || {};
  const moves = st.moves || [];
  const names = r.seats.map((s, i) => s && (s.name || (s.type === 'ai' ? 'AI' : '玩家')) || ('座位' + (i + 1)));
  const ctx = { seatName: (i) => names[i] || ('座位' + (i + 1)) };
  return {
    fmt: 'homearena.replay/1',
    code: r.code,
    game: r.game,
    gameLabel: gameLabel || r.game,
    at: r.startedAt || r.createdAt || Date.now(),
    round: r.round || 1,
    seats: r.seats.map((s, i) => ({
      i, name: names[i], type: s.type, aiLevel: s.aiLevel || null,
    })),
    result: st.draw ? 'draw' : (st.winner != null ? 'win' : 'unfinished'),
    /* winner 的基准各游戏不同（棋类 1 基 / 牌类 0 基 / 队伍制是队号），
     * serializeRoom 已经把正确结果算进 winnerSeats，优先用它；
     * 拿不到时才退回 winner，并明确标注可能不准（winnerRaw）。 */
    winners: Array.isArray(st.winnerSeats) && st.winnerSeats.length ? st.winnerSeats : winnersOf(r.game, st),
    winnerRaw: st.winner != null ? st.winner : null,
    totalMoves: moves.length,
    moves: moves.map((m, i) => {
      const seat = seatOf(m, r.game);
      // 把归一化后的 seat 回填给 describeMove，保证文本里的主语与 seat 字段一致
      const view = seat != null ? { ...m, seat } : m;
      return {
        n: i + 1,
        seat,
        who: seat != null ? (names[seat] || null) : null,
        raw: m,
        text: describeMove(r.game, view, ctx),
      };
    }),
    note: '各游戏洗牌与 AI 决策不可复现，本谱记录「发生了什么」，不含可重演的中间状态。',
  };
}

/** 生成纯文本棋谱（TXT 导出用） */
function toText(rp) {
  const L = [];
  const d = new Date(rp.at);
  const p2 = n => String(n).padStart(2, '0');
  L.push(`HomeArena 牌谱 · ${rp.gameLabel}`);
  L.push(`房号 ${rp.code} · 第 ${rp.round} 局 · ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`);
  L.push('座位：' + rp.seats.map(s => `${s.i + 1}.${s.name}${s.type === 'ai' ? '(AI-' + (s.aiLevel || 'fun') + ')' : ''}`).join('  '));
  const res = rp.result === 'draw' ? '和局' : rp.result === 'win' ? ('胜者：' + rp.winners.map(i => rp.seats[i] ? rp.seats[i].name : '座位' + (i + 1)).join('、')) : '未结束';
  L.push(`结果：${res} · 共 ${rp.totalMoves} 手`);
  L.push('─'.repeat(34));
  for (const m of rp.moves) L.push(`${String(m.n).padStart(3, ' ')}. ${m.text}`);
  L.push('─'.repeat(34));
  L.push('说明：' + rp.note);
  L.push('导出时间：' + new Date().toLocaleString('zh-CN'));
  return L.join('\n');
}

module.exports = { buildReplay, toText, describeMove, cardName, cardsLine };
