// Stockfish UCI 桥接（超人级象棋 AI）+ 无二进制时的内置 minimax 降级
// 满足"机器人智力超越人类大部分职业玩家"：Stockfish 满血 ≈ 3500+ Elo（人类顶尖 ~2830）
const { spawn } = require('child_process');
const { Chess } = require('chess.js');

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evaluateFen(fen) {
  const [bp] = fen.split(' ');
  let s = 0;
  for (const ch of bp) {
    if ('pnbrqkPNBRQK'.includes(ch)) {
      const t = ch.toLowerCase();
      s += (ch === ch.toUpperCase() ? 1 : -1) * VAL[t];
    }
  }
  return s; // 白方视角
}
function negamax(c, depth, alpha, beta) {
  if (c.isGameOver() || depth === 0) {
    const s = evaluateFen(c.fen());
    return c.turn() === 'w' ? s : -s;
  }
  let best = -1e9;
  for (const m of c.moves()) {
    c.move(m);
    const v = -negamax(c, depth - 1, -beta, -alpha);
    c.undo();
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}
// 降级 AI（仅当 Stockfish 二进制不可用时；非超人，保证游戏可运行）
function fallbackBest(fen) {
  const c = new Chess(fen);
  let best = null, bestV = -1e9;
  const depth = 3;
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    const v = -negamax(c, depth - 1, -1e9, 1e9);
    c.undo();
    if (v > bestV) { bestV = v; best = m; }
  }
  return best ? { from: best.from, to: best.to, promotion: best.promotion } : null;
}

class StockfishEngine {
  constructor(bin) {
    this.bin = bin || process.env.STOCKFISH_BIN || 'stockfish';
    this.ready = false;
    this.pending = [];
    this.active = null;
    this.broken = false;
    try {
      this.proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.broken = true; return; }
    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.on('error', () => { this.broken = true; this._fail(); });
    this.proc.on('close', () => { this.broken = true; this._fail(); });
    this._send('uci');
  }
  _send(cmd) { try { this.proc.stdin.write(cmd + '\n'); } catch (e) { this.broken = true; } }
  _fail() { const j = this.active; if (j) { this.active = null; j.resolve(null); } while (this.pending.length) this.pending.shift().resolve(null); }
  _onData(text) {
    for (const line of text.split('\n')) {
      if (line.startsWith('uciok')) { this.ready = true; this._pump(); }
      else if (line.startsWith('bestmove')) {
        const mv = line.split(' ')[1];
        const j = this.active;
        if (j) { this.active = null; j.resolve(mv && mv !== '(none)' ? mv : null); this._pump(); }
      }
    }
  }
  _pump() {
    if (this.active || !this.ready || this.broken) return;
    const job = this.pending.shift();
    if (!job) return;
    this.active = job;
    this._send('setoption name Skill Level value ' + (job.skill ?? 20));
    this._send('position fen ' + job.fen);
    this._send('go movetime ' + (job.movetime ?? 800));
  }
  bestMove(fen, opts = {}) {
    return new Promise((resolve) => {
      if (this.broken) return resolve(null);
      this.pending.push({ fen, skill: opts.skill ?? 20, movetime: opts.movetime ?? 800, resolve });
      this._pump();
    });
  }
  quit() { try { this._send('quit'); } catch (e) {} }
}

let engine = null, tried = false;
function getEngine() {
  if (tried) return engine;
  tried = true;
  try { engine = new StockfishEngine(); } catch (e) { engine = null; }
  return engine;
}

module.exports = { getEngine, fallbackBest };
