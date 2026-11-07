// 黑白棋（Reversi / Othello）
// 约定：board[y][x]，0=空 1=黑 2=白；seat 1=黑先手，seat 2=白。
// 契约：createState() / applyMove(state, move, seatNo) / ai(state, seatNo, level) / genMoves(state, seatNo)

const N = 8;
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// 位置权重：角最高，角旁（X 位/C 位）为负
const WEIGHT = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];

function createState() {
  const board = Array.from({ length: N }, () => new Array(N).fill(0));
  board[3][3] = 2; board[4][4] = 2;
  board[3][4] = 1; board[4][3] = 1;
  return { board, current: 0, side: 1, winner: null, draw: false, passCount: 0, moves: [], moveCount: 0, lastPlay: null };
}

function inB(x, y) { return x >= 0 && x < N && y >= 0 && y < N; }

/** 在 (x,y) 落 me 色子，返回被翻转的格子列表（空数组表示非法） */
function flipsFor(board, x, y, me) {
  if (!inB(x, y) || board[y][x] !== 0) return [];
  const opp = me === 1 ? 2 : 1;
  const out = [];
  for (const [dx, dy] of DIRS) {
    const line = [];
    let cx = x + dx, cy = y + dy;
    while (inB(cx, cy) && board[cy][cx] === opp) { line.push([cx, cy]); cx += dx; cy += dy; }
    if (line.length && inB(cx, cy) && board[cy][cx] === me) out.push(...line);
  }
  return out;
}

function genMoves(state, seatNo) {
  const me = seatNo === 1 ? 1 : 2;
  const res = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = flipsFor(state.board, x, y, me);
    if (f.length) res.push({ x, y, n: f.length });
  }
  return res;
}

function applyMove(state, move, seatNo) {
  const me = seatNo === 1 ? 1 : 2;
  if (state.winner != null || state.draw) return { ok: false, reason: '已终局' };
  if (state.side !== me) return { ok: false, reason: 'noturn' };

  // 过牌：仅当自己无合法着法时允许
  if (move && move.pass) {
    if (genMoves(state, seatNo).length) return { ok: false, reason: '有合法着法，不能过' };
    return doPass(state, me);
  }
  if (!move || move.x == null || move.y == null) return { ok: false, reason: 'badmove' };
  const f = flipsFor(state.board, move.x, move.y, me);
  if (!f.length) return { ok: false, reason: 'illegal' };

  state.board[move.y][move.x] = me;
  for (const [fx, fy] of f) state.board[fy][fx] = me;
  state.side = me === 1 ? 2 : 1;
  state.passCount = 0;
  state.moveCount++;
  state.moves.push({ seat: me, x: move.x, y: move.y });
  state.lastPlay = { x: move.x, y: move.y, player: me };
  return advanceIfNeeded(state);
}

function doPass(state, me) {
  state.side = me === 1 ? 2 : 1;
  state.passCount++;
  state.moves.push({ seat: me, pass: true });
  return advanceIfNeeded(state);
}

/** 若下家无子可下则自动过；双方连续过或棋盘满则终局 */
function advanceIfNeeded(state) {
  if (countAll(state).empty === 0 || state.passCount >= 2) return finish(state);

  let guard = 0;
  while (guard++ < 4) {
    if (genMoves(state, state.side === 1 ? 1 : 2).length) break;
    // 下家无着法：记一次过并换边
    state.moves.push({ seat: state.side, pass: true, auto: true });
    state.side = state.side === 1 ? 2 : 1;
    state.passCount++;
    if (state.passCount >= 2) return finish(state);
  }
  state.current = state.side === 1 ? 0 : 1;
  return { ok: true, next: state.current };
}

function countAll(state) {
  let b = 0, w = 0, e = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = state.board[y][x];
    if (v === 1) b++; else if (v === 2) w++; else e++;
  }
  return { black: b, white: w, empty: e };
}

function finish(state) {
  const c = countAll(state);
  state.black = c.black; state.white = c.white;
  if (c.black === c.white) { state.draw = true; state.winner = null; }
  else state.winner = c.black > c.white ? 1 : 2;   // seat 号（1 基）
  return { ok: true, next: null, done: true };
}

function clone(s) { return { board: s.board.map(r => r.slice()), side: s.side }; }

function evaluate(board, me) {
  let score = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = board[y][x];
    if (!v) continue;
    score += (v === me ? 1 : -1) * WEIGHT[y][x];
  }
  return score;
}

function legalOn(board, me) {
  const res = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const f = flipsFor(board, x, y, me);
    if (f.length) res.push({ x, y, f });
  }
  return res;
}

function playOn(board, mv, me) {
  const b = board.map(r => r.slice());
  b[mv.y][mv.x] = me;
  for (const [fx, fy] of mv.f) b[fy][fx] = me;
  return b;
}

function minimax(board, me, turn, depth, alpha, beta, endGame) {
  const moves = legalOn(board, turn);
  if (depth <= 0) return evaluate(board, me);
  if (!moves.length) {
    const oppMoves = legalOn(board, turn === 1 ? 2 : 1);
    if (!oppMoves.length) { // 终局：子数差放大
      let d = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (board[y][x] === me) d++; else if (board[y][x]) d--;
      }
      return d * 1000;
    }
    return minimax(board, me, turn === 1 ? 2 : 1, depth - 1, alpha, beta, endGame);
  }
  if (turn === me) {
    let best = -Infinity;
    for (const mv of moves) {
      const v = minimax(playOn(board, mv, turn), me, turn === 1 ? 2 : 1, depth - 1, alpha, beta, endGame);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const mv of moves) {
    const v = minimax(playOn(board, mv, turn), me, turn === 1 ? 2 : 1, depth - 1, alpha, beta, endGame);
    if (v < best) best = v;
    if (best < beta) beta = best;
    if (alpha >= beta) break;
  }
  return best;
}

async function ai(state, seatNo, level) {
  const me = seatNo === 1 ? 1 : 2;
  const moves = genMoves(state, seatNo);
  if (!moves.length) return { pass: true };
  const empty = countAll(state).empty;
  let depth;
  if (level === 'super') depth = empty <= 12 ? 10 : 7;
  else if (level === 'strong') depth = empty <= 14 ? 7 : 5;
  else depth = 3;

  let best = null, bestV = -Infinity;
  for (const mv of moves) {
    const f = flipsFor(state.board, mv.x, mv.y, me);
    const nb = playOn(state.board, { x: mv.x, y: mv.y, f }, me);
    // 角优先的浅层加成，配合深层搜索
    let v = minimax(nb, me, me === 1 ? 2 : 1, depth - 1, -Infinity, Infinity, empty <= 12);
    v += WEIGHT[mv.y][mv.x] * 0.5;
    if (level === 'fun') v += Math.random() * 30;
    if (v > bestV) { bestV = v; best = mv; }
  }
  return { x: best.x, y: best.y };
}

module.exports = { label: '黑白棋', seats: 2, createState, applyMove, ai, genMoves, flipsFor, countAll };
