// 四子棋（Connect Four）
// 棋盘：7 列 × 6 行，重力落子；先连成 4 子（横/竖/双斜）者胜。
// 约定：board[y][x]，y=0 为底行；0=空 1=P1 2=P2。move = { col }
// 契约：createState() / applyMove(state, move, seatNo) / ai(state, seatNo, level)

const W = 7, H = 6;

function createState() {
  const board = Array.from({ length: H }, () => new Array(W).fill(0));
  // v0.10.12：lastPlay 记录权威最后一手（四子棋是「列」落子，实际格子要落完才知道）。
  return { board, current: 0, side: 1, winner: null, draw: false, moves: [], moveCount: 0, heights: new Array(W).fill(0), lastPlay: null };
}

function dropRow(state, col) {
  if (col < 0 || col >= W) return -1;
  const y = state.heights[col];
  return y < H ? y : -1;
}

function winsAt(board, x, y, p) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s;
      while (cx >= 0 && cx < W && cy >= 0 && cy < H && board[cy][cx] === p) { n++; cx += dx * s; cy += dy * s; }
    }
    if (n >= 4) return true;
  }
  return false;
}

function genMoves(state) {
  const res = [];
  for (let c = 0; c < W; c++) if (state.heights[c] < H) res.push({ col: c });
  return res;
}

function applyMove(state, move, seatNo) {
  if (state.winner != null || state.draw) return { ok: false, reason: '已终局' };
  if (state.side !== seatNo) return { ok: false, reason: 'noturn' };
  if (!move || move.col == null) return { ok: false, reason: 'badmove' };
  const col = move.col | 0;
  const y = dropRow(state, col);
  if (y < 0) return { ok: false, reason: '该列已满' };

  state.board[y][col] = seatNo;
  state.heights[col] = y + 1;
  state.moveCount++;
  state.moves.push({ seat: seatNo, col });
  state.lastPlay = { x: col, y, player: seatNo };

  if (winsAt(state.board, col, y, seatNo)) { state.winner = seatNo; return { ok: true, next: null, done: true }; }
  if (state.moveCount >= W * H) { state.draw = true; return { ok: true, next: null, done: true }; }

  state.side = seatNo === 1 ? 2 : 1;
  state.current = state.side - 1;
  return { ok: true, next: state.current };
}

/* ---------------- AI ---------------- */
function cloneBoard(b, h) { return { board: b.map(r => r.slice()), heights: h.slice() }; }

function canWin(b, h, col, p) {
  if (h[col] >= H) return false;
  const y = h[col];
  b[y][col] = p;
  const win = winsAt(b, col, y, p);
  b[y][col] = 0;
  return win;
}

function threatCount(b, h, p) {
  // 统计「再落一子即成四」的即时威胁点数量
  let n = 0;
  for (let c = 0; c < W; c++) if (canWin(b, h, c, p)) n++;
  return n;
}

function evaluate(b, h, me) {
  const opp = me === 1 ? 2 : 1;
  let score = 0;
  // 中心列权重
  for (let c = 0; c < W; c++) for (let y = 0; y < h[c]; y++) {
    if (b[y][c] === me) score += 3 - Math.abs(c - 3) * 0.5;
    else if (b[y][c] === opp) score -= 3 - Math.abs(c - 3) * 0.5;
  }
  score += threatCount(b, h, me) * 18 - threatCount(b, h, opp) * 22;
  return score;
}

function minimax(st, me, turn, depth, alpha, beta) {
  if (depth === 0) return evaluate(st.board, st.heights, me);
  const moves = genMoves(st);
  if (!moves.length) return 0;
  // 先手必胜/必败快速判定
  for (const mv of moves) {
    if (canWin(st.board, st.heights, mv.col, turn)) return turn === me ? 1000 + depth : -1000 - depth;
  }
  let best = turn === me ? -Infinity : Infinity;
  // 中间列优先，提升剪枝效率
  moves.sort((a, b) => Math.abs(a.col - 3) - Math.abs(b.col - 3));
  for (const mv of moves) {
    const y = st.heights[mv.col];
    st.board[y][mv.col] = turn; st.heights[mv.col] = y + 1;
    const v = minimax(st, me, turn === 1 ? 2 : 1, depth - 1, alpha, beta);
    st.board[y][mv.col] = 0; st.heights[mv.col] = y;
    if (turn === me) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (alpha >= beta) break;
  }
  return best;
}

async function ai(state, seatNo, level) {
  const depth = level === 'super' ? 8 : level === 'strong' ? 6 : 3;
  const moves = genMoves(state);
  if (!moves.length) return null;
  const st = cloneBoard(state.board, state.heights);

  // 1) 能赢立刻赢
  for (const mv of moves) if (canWin(st.board, st.heights, mv.col, seatNo)) return { col: mv.col };
  // 2) 对手将赢必须堵
  const opp = seatNo === 1 ? 2 : 1;
  for (const mv of moves) if (canWin(st.board, st.heights, mv.col, opp)) return { col: mv.col };
  // 3) 搜索
  let best = moves[Math.floor(moves.length / 2)], bestV = -Infinity;
  for (const mv of moves) {
    const y = st.heights[mv.col];
    st.board[y][mv.col] = seatNo; st.heights[mv.col] = y + 1;
    const v = minimax(st, seatNo, opp, depth - 1, -Infinity, Infinity);
    st.board[y][mv.col] = 0; st.heights[mv.col] = y;
    const adj = v + (level === 'fun' ? Math.random() * 6 : 0);
    if (adj > bestV) { bestV = adj; best = mv; }
  }
  return { col: best.col };
}

module.exports = { label: '四子棋', seats: 2, createState, applyMove, ai, genMoves, winsAt };
