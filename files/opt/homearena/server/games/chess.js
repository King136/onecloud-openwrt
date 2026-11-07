// 国际象棋游戏服务：chess.js 规则 + Stockfish 超人 AI（含降级）
const { Chess } = require('chess.js');
const { getEngine, fallbackBest } = require('../ai/stockfish');

function createState() {
  const c = new Chess();
  // v0.10.12：lastPlay 用 {from,to}（代数坐标，如 a2→a4），国际象棋是走子类而非落子类。
  return { fen: c.fen(), current: 0, winner: null, draw: false, moves: [], lastPlay: null };
}
function validMoves(state) {
  try {
    return new Chess(state.fen).moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion }));
  } catch (e) { return []; }
}
function applyMove(state, move, player) {
  if (state.winner || state.draw) return { ok: false, reason: 'ended' };
  let c;
  try { c = new Chess(state.fen); } catch (e) { return { ok: false, reason: 'badfen' }; }
  let res;
  try { res = c.move({ from: move.from, to: move.to, promotion: move.promotion }); }
  catch (e) { return { ok: false, reason: 'illegal' }; }
  if (!res) return { ok: false, reason: 'illegal' };
  state.fen = c.fen();
  state.moves.push({ from: move.from, to: move.to, player });
  state.lastPlay = { from: move.from, to: move.to, player, san: res.san || '' };
  if (c.isCheckmate()) state.winner = player;
  else if (c.isDraw() || c.isStalemate() || c.isInsufficientMaterial()) state.draw = true;
  return { ok: true };
}
// 超人级：Stockfish（skill 0–20，超人=20）；无二进制降级 minimax
async function ai(state, player, aiLevel) {
  const superLevel = aiLevel === 'super';
  const eng = getEngine();
  if (eng) {
    try {
      const uci = await eng.bestMove(state.fen, { skill: superLevel ? 20 : 3, movetime: superLevel ? 1000 : 200 });
      if (uci && uci !== '(none)') return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci.slice(4) : undefined };
    } catch (e) { /* 降级 */ }
  }
  return fallbackBest(state.fen);
}
module.exports = { label: '国际象棋', seats: 2, createState, validMoves, applyMove, ai };
