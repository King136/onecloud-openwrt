// 五子棋规则引擎 + 启发式 AI（娱乐级，非超人）
// v0.12.0（R3-4）自定义规则：createState(rules) 支持 boardSize 9/13/15，
// 引擎内一律从 state.size 取边长（兼容无 size 的旧局，回落 15）。
const SIZE = 15;
const sizeOf = (s) => (s && s.size) || SIZE;

function createState(rules) {
  const n = rules && +rules.boardSize >= 5 && +rules.boardSize <= 19 ? Math.floor(+rules.boardSize) : SIZE;
  // v0.10.12：补 lastPlay —— 前端「最后一手标记」的数据源。
  // 之前只能靠 moves 反推（围棋就是这么干的），但一局几百手要每次 reverse 查找，
  // 且 pass 等无坐标着法会打乱反推。直接由引擎给出权威值最省事。
  return { size: n, board: Array.from({ length: n }, () => Array(n).fill(0)), current: 0, winner: null, draw: false, moves: [], lastPlay: null };
}
function inBounds(s, x, y) { const n = sizeOf(s); return x >= 0 && x < n && y >= 0 && y < n; }
function validMoves(s) {
  const n = sizeOf(s);
  const m = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (s.board[y][x] === 0) m.push({ x, y });
  return m;
}
function checkWin(b, x, y, p, size) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const n = size;
  for (const [dx, dy] of dirs) {
    let cnt = 1;
    for (let k = 1; k < 5; k++) { const nx = x + dx * k, ny = y + dy * k; if (nx >= 0 && nx < n && ny >= 0 && ny < n && b[ny][nx] === p) cnt++; else break; }
    for (let k = 1; k < 5; k++) { const nx = x - dx * k, ny = y - dy * k; if (nx >= 0 && nx < n && ny >= 0 && ny < n && b[ny][nx] === p) cnt++; else break; }
    if (cnt >= 5) return true;
  }
  return false;
}
function applyMove(s, move, player) {
  const { x, y } = move;
  if (s.winner || s.draw) return { ok: false, reason: 'ended' };
  if (!inBounds(s, x, y) || s.board[y][x] !== 0) return { ok: false, reason: 'illegal' };
  s.board[y][x] = player;
  s.moves.push({ x, y, player });
  s.lastPlay = { x, y, player };
  if (checkWin(s.board, x, y, player, sizeOf(s))) s.winner = player;
  else if (validMoves(s).length === 0) s.draw = true;
  return { ok: true };
}
function centerBias(s, x, y) { const c = (sizeOf(s) - 1) / 2; return 5 - (Math.abs(x - c) + Math.abs(y - c)) / 3; }
function patternValue(cnt, open) {
  if (cnt >= 5) return 1e6;
  if (cnt === 4 && open === 2) return 1e5;
  if (cnt === 4 && open === 1) return 1e4;
  if (cnt === 3 && open === 2) return 1e3;
  if (cnt === 3 && open === 1) return 500;
  if (cnt === 2 && open === 2) return 100;
  if (cnt === 2 && open === 1) return 50;
  return 10;
}
function scorePoint(b, x, y, p, size) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  let sum = 0;
  const ok = (nx, ny) => nx >= 0 && nx < size && ny >= 0 && ny < size;
  for (const [dx, dy] of dirs) {
    let cnt = 1, open = 0;
    for (let k = 1; k < 5; k++) { const nx = x + dx * k, ny = y + dy * k; if (ok(nx, ny)) { if (b[ny][nx] === p) cnt++; else if (b[ny][nx] === 0) { open++; break; } else break; } else break; }
    for (let k = 1; k < 5; k++) { const nx = x - dx * k, ny = y - dy * k; if (ok(nx, ny)) { if (b[ny][nx] === p) cnt++; else if (b[ny][nx] === 0) { open++; break; } else break; } else break; }
    sum += patternValue(cnt, open);
  }
  return sum;
}
function ai(s, player /*, aiLevel */) {
  const opp = player === 1 ? 2 : 1;
  const n = sizeOf(s);
  for (const m of validMoves(s)) { s.board[m.y][m.x] = player; const w = checkWin(s.board, m.x, m.y, player, n); s.board[m.y][m.x] = 0; if (w) return m; }
  for (const m of validMoves(s)) { s.board[m.y][m.x] = opp; const w = checkWin(s.board, m.x, m.y, opp, n); s.board[m.y][m.x] = 0; if (w) return m; }
  let best = null, bestScore = -1;
  for (const m of validMoves(s)) {
    const off = scorePoint(s.board, m.x, m.y, player, n);
    const def = scorePoint(s.board, m.x, m.y, opp, n);
    const total = off + def * 0.9 + centerBias(s, m.x, m.y);
    if (total > bestScore) { bestScore = total; best = m; }
  }
  return best || validMoves(s)[0];
}
module.exports = { label: '五子棋', seats: 2, createState, validMoves, applyMove, ai };
