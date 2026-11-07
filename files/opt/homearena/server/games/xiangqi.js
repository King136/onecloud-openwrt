// 中国象棋：9x10 走法生成 + 合法性(将军/飞将)过滤 + 启发式 AI（ElephantEye UCCI 桥在 ai/ucci.js，超人级需提供二进制）
const { getEngine } = require('../ai/ucci');

const START = [
  'rheakaehr'.split(''),
  '.........'.split(''),
  '..c...c..'.split(''),
  'p.p.p.p.p'.split(''),
  '.........'.split(''),
  '.........'.split(''),
  'P.P.P.P.P'.split(''),
  '..C...C..'.split(''),
  '.........'.split(''),
  'RHEAKAEHR'.split(''),
];
function clone(b) { return b.map(r => r.slice()); }
function color(p) { return p === '.' ? null : (p === p.toUpperCase() ? 'red' : 'black'); }
function inBoard(x, y) { return x >= 0 && x <= 8 && y >= 0 && y <= 9; }
function inPalace(side, x, y) { return x >= 3 && x <= 5 && (side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2); }

function posKey(board, side) { return board.map(r => r.join('')).join('') + side; }
function createState() { const st = { board: clone(START), current: 0, side: 'red', winner: null, draw: false, moves: [], seen: {}, halfmoves: 0, lastPlay: null }; st.seen[posKey(st.board, 'red')] = 1; return st; }
function findGeneral(board, side) { const k = side === 'red' ? 'K' : 'k'; for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) if (board[y][x] === k) return [x, y]; return null; }

// 某子 p 在 (x,y) 是否攻击 (tx,ty)（忽略目标占位，由调用方判敌我）
function attacks(board, x, y, p, tx, ty) {
  const side = color(p); const T = p.toUpperCase();
  if (T === 'K') {
    if (tx === x) { let between = false; for (let yy = Math.min(y, ty) + 1; yy < Math.max(y, ty); yy++) if (board[yy][x] !== '.') between = true; if (!between) return true; }
    if (Math.abs(tx - x) + Math.abs(ty - y) === 1 && inPalace(side, tx, ty)) return true; return false;
  }
  if (T === 'A') { if (Math.abs(tx - x) === 1 && Math.abs(ty - y) === 1 && inPalace(side, tx, ty)) return true; return false; }
  if (T === 'E') {
    if (Math.abs(tx - x) === 2 && Math.abs(ty - y) === 2) {
      if (board[(y + ty) / 2][(x + tx) / 2] !== '.') return false;
      if (side === 'red' && ty < 5) return false; if (side === 'black' && ty > 4) return false; return true;
    } return false;
  }
  if (T === 'H') {
    const dx = tx - x, dy = ty - y; const leg = Math.abs(dx) === 1 ? [x, y + dy / 2] : [x + dx / 2, y];
    if (Math.abs(dx) === 1 && Math.abs(dy) === 2 || Math.abs(dx) === 2 && Math.abs(dy) === 1) { if (board[leg[1]][leg[0]] !== '.') return false; return true; }
    return false;
  }
  if (T === 'R' || T === 'C') {
    if (tx !== x && ty !== y) return false; const sx = Math.sign(tx - x), sy = Math.sign(ty - y); let cx = x + sx, cy = y + sy, screens = 0;
    while (cx !== tx || cy !== ty) { if (board[cy][cx] !== '.') screens++; cx += sx; cy += sy; }
    if (T === 'R') return screens === 0;
    return screens === 1; // 炮：翻山吃子需恰好一子做炮架
  }
  if (T === 'P') {
    const fwd = side === 'red' ? -1 : 1; const crossed = side === 'red' ? y <= 4 : y >= 5;
    if (tx === x && ty === y + fwd) return true;
    if (crossed && ty === y && Math.abs(tx - x) === 1) return true; return false;
  }
  return false;
}
function attackedBy(board, tx, ty, bySide) {
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) { const p = board[y][x]; if (p === '.' || color(p) !== bySide) continue; if (attacks(board, x, y, p, tx, ty)) return true; }
  return false;
}
function inCheck(board, side) { const g = findGeneral(board, side); if (!g) return true; return attackedBy(board, g[0], g[1], side === 'red' ? 'black' : 'red'); }

function genMoves(board, side) {
  const out = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    const p = board[y][x]; if (p === '.' || color(p) !== side) continue; const T = p.toUpperCase();
    const attempt = (nx, ny) => {
      if (!inBoard(nx, ny)) return; const t = board[ny][nx]; if (t !== '.' && color(t) === side) return;
      if (attacks(board, x, y, p, nx, ny)) {
        const nb = clone(board); nb[ny][nx] = p; nb[y][x] = '.';
        if (!inCheck(nb, side)) out.push({ from: [x, y], to: [nx, ny] });
      }
    };
    if (T === 'K' || T === 'A') { const d = T === 'K' ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 1], [1, -1], [-1, 1], [-1, -1]]; for (const [dx, dy] of d) attempt(x + dx, y + dy); }
    else if (T === 'E') { for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) attempt(x + dx, y + dy); }
    else if (T === 'H') { for (const [dx, dy] of [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]) attempt(x + dx, y + dy); }
    else if (T === 'R' || T === 'C') { for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { let nx = x + dx, ny = y + dy; while (inBoard(nx, ny)) { attempt(nx, ny); if (board[ny][nx] !== '.') break; nx += dx; ny += dy; } } }
    else if (T === 'P') { const fwd = side === 'red' ? -1 : 1; attempt(x, y + fwd); if ((side === 'red' ? y <= 4 : y >= 5)) { attempt(x + 1, y); attempt(x - 1, y); } }
  }
  return out;
}

const VAL = { K: 100000, R: 600, H: 270, C: 285, E: 120, A: 120, P: 30 };
function evaluate(board) {
  let s = 0;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) { const p = board[y][x]; if (p === '.') continue; const v = VAL[p.toUpperCase()] || 0; s += (color(p) === 'red' ? 1 : -1) * v; }
  return s;
}
function negamax(board, side, depth, alpha, beta) {
  if (depth === 0) return side === 'red' ? evaluate(board) : -evaluate(board);
  const moves = genMoves(board, side);
  if (moves.length === 0) return side === 'red' ? -1e8 : 1e8; // 被将死/困毙
  let best = -1e9; const ns = side === 'red' ? 'black' : 'red';
  for (const m of moves) { const nb = clone(board); nb[m.to[1]][m.to[0]] = board[m.from[1]][m.from[0]]; nb[m.from[1]][m.from[0]] = '.'; const v = -negamax(nb, ns, depth - 1, -beta, -alpha); if (v > best) best = v; if (best > alpha) alpha = best; if (alpha >= beta) break; }
  return best;
}
function heuristicBest(board, side, depth) {
  let best = null, bestV = -1e9; const ns = side === 'red' ? 'black' : 'red';
  for (const m of genMoves(board, side)) { const nb = clone(board); nb[m.to[1]][m.to[0]] = board[m.from[1]][m.from[0]]; nb[m.from[1]][m.from[0]] = '.'; const v = -negamax(nb, ns, depth - 1, -1e9, 1e9); if (v > bestV) { bestV = v; best = m; } }
  return best;
}

function applyMove(state, move, player) {
  if (state.winner != null || state.draw) return { ok: false, reason: 'ended' };
  if (state.current !== player - 1) return { ok: false, reason: 'noturn' };
  const side = state.side; const [fx, fy] = move.from, [tx, ty] = move.to;
  const p = state.board[fy][fx];
  if (p === '.' || color(p) !== side) return { ok: false, reason: 'illegal' };
  if (!attacks(state.board, fx, fy, p, tx, ty)) return { ok: false, reason: 'illegal' };
  const captured = state.board[ty][tx] !== '.';
  const nb = clone(state.board); nb[ty][tx] = p; nb[fy][fx] = '.';
  if (inCheck(nb, side)) return { ok: false, reason: 'selfcheck' };
  state.board = nb; state.moves.push({ from: move.from, to: move.to, p });
  // v0.10.12：与前端一致，from/to 都是 [x,y] 数组（不是代数坐标）。
  state.lastPlay = { from: move.from, to: move.to, p };
  if (!findGeneral(state.board, side === 'red' ? 'black' : 'red')) { state.winner = player; state.phase = 'ended'; return { ok: true }; }
  const ns = side === 'red' ? 'black' : 'red';
  if (genMoves(state.board, ns).length === 0) { state.draw = inCheck(state.board, ns); state.phase = 'ended'; return { ok: true }; }
  // 和棋：三次重复 或 120 半回合无吃子
  if (captured) state.halfmoves = 0; else { state.halfmoves = (state.halfmoves || 0) + 1; if (state.halfmoves >= 120) { state.draw = true; state.phase = 'ended'; return { ok: true, next: state.current }; } }
  const k = posKey(state.board, ns); state.seen[k] = (state.seen[k] || 0) + 1; if (state.seen[k] >= 3) { state.draw = true; state.phase = 'ended'; return { ok: true, next: state.current }; }
  state.current = 1 - state.current; state.side = ns; return { ok: true, next: state.current };
}

function fallbackBest(board, side, depth) { return heuristicBest(board, side, depth); }
async function ai(state, player, aiLevel) {
  const side = state.side; const eng = getEngine();
  if (eng) { try { const mv = await eng.bestMove(state.board, side, { depth: aiLevel === 'super' ? 6 : 3 }); if (mv) return mv; } catch (e) {} }
  return fallbackBest(state.board, side, aiLevel === 'super' ? 3 : 2);
}
module.exports = { label: '中国象棋', seats: 2, createState, applyMove, ai, VAL, genMoves };
