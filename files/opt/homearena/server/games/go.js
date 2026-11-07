// 围棋（Go）· 19 路标准盘（可配 9/13 路）· 中国数子规则
// 约定：board[y][x]，0=空 1=黑 2=白；seat 1=黑先手，seat 2=白。move = {x,y} 或 {pass:true}
// 实现：提子、禁着点（自杀手）、打劫（简单劫：禁止立即还原上一手前局面）、虚手、数目终局
// 契约：createState(rules) / applyMove(state, move, seatNo) / ai(state, seatNo, level) / genMoves(state, seatNo)
//
// v0.28.0（R16-1）：路数参数化。旧版把 N 写死 9（v0.27 的「快棋」口径），
// 但用户与国际通行标准都以 19 路为围棋本体 —— 19 路盘只有 5 个星位更是硬伤。
// 现在默认 19 路、中国规则贴 7.5 目；棋盘尺寸与贴目都从 rules 进来，
// 引擎内一律以 board.length 取边长，旧局（state.size=9）照样能续。

const DEFAULT_SIZE = 19;
const DEFAULT_KOMI = 7.5;
const NB = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function createState(rules) {
  const size = rules && [9, 13, 19].indexOf(+rules.boardSize) >= 0 ? +rules.boardSize : DEFAULT_SIZE;
  const komi = rules && [5.5, 6.5, 7.5].indexOf(+rules.komi) >= 0 ? +rules.komi : DEFAULT_KOMI;
  const board = Array.from({ length: size }, () => new Array(size).fill(0));
  const history = [hashBoard(board)];
  return {
    board, current: 0, side: 1, winner: null, draw: false,
    passes: 0, moveCount: 0, moves: [], captures: { 1: 0, 2: 0 }, history,
    score: null, komi, size, lastPlay: null,
  };
}

function inB(b, x, y) { const n = b.length; return x >= 0 && x < n && y >= 0 && y < n; }
function hashBoard(b) { return b.map(r => r.join('')).join('/'); }

/** 返回 (x,y) 所在棋块的全部棋子与气的集合 */
function group(b, x, y) {
  const n = b.length;
  const p = b[y][x];
  if (!p) return { stones: [], libs: new Set() };
  const seen = new Set([y * n + x]);
  const stones = [[x, y]];
  const libs = new Set();
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    for (const [dx, dy] of NB) {
      const nx = cx + dx, ny = cy + dy;
      if (!inB(b, nx, ny)) continue;
      const v = b[ny][nx];
      if (v === 0) libs.add(ny * n + nx);
      else if (v === p && !seen.has(ny * n + nx)) { seen.add(ny * n + nx); stones.push([nx, ny]); stack.push([nx, ny]); }
    }
  }
  return { stones, libs };
}

/** 试算落子；返回 { ok, captured, board } —— 不修改原局面 */
function tryPlace(b, x, y, p) {
  if (!inB(b, x, y) || b[y][x] !== 0) return { ok: false, reason: '该点已有子' };
  const nb = b.map(r => r.slice());
  nb[y][x] = p;
  const opp = p === 1 ? 2 : 1;
  let captured = 0;
  for (const [dx, dy] of NB) {
    const nx = x + dx, ny = y + dy;
    if (!inB(nb, nx, ny) || nb[ny][nx] !== opp) continue;
    const g = group(nb, nx, ny);
    if (g.libs.size === 0) { for (const [sx, sy] of g.stones) { nb[sy][sx] = 0; captured++; } }
  }
  const mine = group(nb, x, y);
  if (mine.libs.size === 0) return { ok: false, reason: '禁着点（自杀）' }; // 自杀手非法
  return { ok: true, captured, board: nb, libs: mine.libs.size };
}

function genMoves(state, seatNo) {
  const me = seatNo === 1 ? 1 : 2;
  const n = state.board.length;
  const res = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (state.board[y][x] !== 0) continue;
    const t = tryPlace(state.board, x, y, me);
    if (!t.ok) continue;
    const nb = t.board;
    // 打劫：禁止立即还原对手上一手之前的局面
    if (state.history.length >= 2 && hashBoard(nb) === state.history[state.history.length - 2]) continue;
    res.push({ x, y, captured: t.captured, libs: t.libs });
  }
  res.push({ pass: true });
  return res;
}

function applyMove(state, move, seatNo) {
  if (state.winner != null) return { ok: false, reason: '已终局' };
  if (state.side !== seatNo) return { ok: false, reason: 'noturn' };

  if (move && move.pass) {
    state.passes++;
    state.moves.push({ seat: seatNo, pass: true });
    state.lastPlay = { pass: true, player: seatNo };
    if (state.passes >= 2) return finish(state);
    state.side = seatNo === 1 ? 2 : 1;
    state.current = state.side - 1;
    return { ok: true, next: state.current };
  }
  if (!move || move.x == null || move.y == null) return { ok: false, reason: 'badmove' };

  const t = tryPlace(state.board, move.x, move.y, seatNo);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (state.history.length >= 2 && hashBoard(t.board) === state.history[state.history.length - 2]) {
    return { ok: false, reason: '打劫禁着' };
  }

  state.board = t.board;
  state.captures[seatNo] += t.captured;
  state.passes = 0;
  state.moveCount++;
  state.moves.push({ seat: seatNo, x: move.x, y: move.y, captured: t.captured });
  state.lastPlay = { x: move.x, y: move.y, player: seatNo, captured: t.captured };
  state.history.push(hashBoard(state.board));
  if (state.history.length > 64) state.history.shift(); // 简单劫只需近几手，限制内存

  state.side = seatNo === 1 ? 2 : 1;
  state.current = state.side - 1;
  return { ok: true, next: state.current };
}

/** 中国数子：子空皆地 */
function finish(state) {
  const b = state.board;
  const n = b.length;
  const komi = Number.isFinite(state.komi) ? state.komi : DEFAULT_KOMI;
  const terr = { 0: 0, 1: 0, 2: 0 };
  const seen = new Set();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (b[y][x] !== 0 || seen.has(y * n + x)) continue;
    // 洪泛空点区域，判断只与哪种颜色相邻
    const region = [[x, y]];
    const rs = new Set([y * n + x]);
    const touch = new Set();
    let qi = 0;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [dx, dy] of NB) {
        const nx = cx + dx, ny = cy + dy;
        if (!inB(b, nx, ny)) continue;
        const v = b[ny][nx];
        if (v === 0) { if (!rs.has(ny * n + nx)) { rs.add(ny * n + nx); region.push([nx, ny]); stack.push([nx, ny]); } }
        else touch.add(v);
      }
    }
    qi = region.length;
    for (const [rx, ry] of region) seen.add(ry * n + rx);
    const owner = touch.size === 1 ? [...touch][0] : 0;
    terr[owner] += qi;
  }
  let black = 0, white = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (b[y][x] === 1) black++; else if (b[y][x] === 2) white++;
  }
  black += terr[1];
  white += terr[2] + komi;
  state.score = { black, white, terr };
  state.winner = black > white ? 1 : 2;
  state.draw = Math.abs(black - white) < 0.01;
  return { ok: true, next: null, done: true };
}

/* ---------------- AI ---------------- */
// 距中心的距离（开局偏好靠近中心与星位）
function centrality(x, y, n) {
  const cx = (n - 1) / 2;
  return (n - 1) - (Math.abs(x - cx) + Math.abs(y - cx));
}
// 是否贴边（开局贴边通常不佳）
function atEdge(x, y, n) { return (x === 0 || x === n - 1 || y === 0 || y === n - 1) ? 1 : 0; }

function influence(b) {
  // 统计每方棋子对空点的影响（简单势力）
  const n = b.length;
  const infl = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = b[y][x];
    if (!v) continue;
    const sign = v === 1 ? 1 : -1;
    for (let d = 1; d <= 3; d++) {
      for (const [dx, dy] of NB) {
        const nx = x + dx * d, ny = y + dy * d;
        if (inB(b, nx, ny)) infl[ny][nx] += sign * (4 - d);
      }
    }
  }
  return infl;
}

function heuristic(state, seatNo, mv, infl) {
  const me = seatNo === 1 ? 1 : 2;
  const opp = me === 1 ? 2 : 1;
  if (mv.pass) return -50;
  const t = tryPlace(state.board, mv.x, mv.y, me);
  if (!t.ok) return -Infinity;
  const nb = t.board;

  let v = 0;
  v += t.captured * 60;                     // 提子价值最高
  v += t.libs * 4;                          // 自己的气越多越好
  if (t.libs <= 1) v -= 45;                 // 自己被打吃要逃

  // 对手是否因此被打吃 / 被叫吃
  for (const [dx, dy] of NB) {
    const nx = mv.x + dx, ny = mv.y + dy;
    if (!inB(nb, nx, ny) || nb[ny][nx] !== opp) continue;
    const g = group(nb, nx, ny);
    if (g.libs.size === 1) v += 25 + g.stones.length * 6;   // 叫吃
  }
  v += centrality(mv.x, mv.y, nb.length) * 2.2;
  if (state.moveCount < 20) v -= atEdge(mv.x, mv.y, nb.length) * 12;
  v += (infl[mv.y][mv.x] * (me === 1 ? 1 : -1)) * 0.6;
  return v;
}

async function ai(state, seatNo, level) {
  const moves = genMoves(state, seatNo).filter(m => !m.pass);
  if (!moves.length) return { pass: true };
  const infl = influence(state.board);
  const opp = seatNo === 1 ? 2 : 1;

  const scored = moves.map(m => ({ m, v: heuristic(state, seatNo, m, infl) }))
    .filter(s => s.v > -Infinity)
    .sort((a, b) => b.v - a.v);
  if (!scored.length) return { pass: true };

  if (level === 'fun') {
    const top = scored.slice(0, Math.max(4, Math.floor(scored.length * 0.35)));
    const mv = top[Math.floor(Math.random() * top.length)].m;   // 必须取同一个候选的 x 与 y
    return { x: mv.x, y: mv.y };
  }

  // strong / super：加入一层对手应手（2 层搜索）
  const width = level === 'super' ? 14 : 8;
  let best = scored[0].m, bestV = -Infinity;
  for (const s of scored.slice(0, width)) {
    let v = s.v;
    // 对手最优应手（提回 / 叫吃）
    const t = tryPlace(state.board, s.m.x, s.m.y, seatNo);
    if (t.ok) {
      const tmp = { board: t.board, history: state.history, moveCount: state.moveCount + 1 };
      const replies = genMoves(tmp, opp).filter(r => !r.pass);
      let worst = 0;
      for (const r of replies) {
        const rv = heuristic(tmp, opp, r, infl);
        if (rv > worst) worst = rv;
      }
      v -= worst * 0.55;
    }
    if (v > bestV) { bestV = v; best = s.m; }
  }
  // 局面已无意义时虚手（双方连续虚手即终局）
  if (bestV < -120 && state.moveCount > 10) return { pass: true };
  return { x: best.x, y: best.y };
}

module.exports = { label: '围棋', seats: 2, createState, applyMove, ai, genMoves, group, tryPlace, finish };
