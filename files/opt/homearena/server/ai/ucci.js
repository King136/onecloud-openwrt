// ElephantEye UCCI 桥（中国象棋超人级）：复用 Stockfish 适配器模式。
// 协议差异：UCCI 握手 'ucci'->'ucciok'，走子坐标 h2e2（file a-i, rank 0-9 自黑方顶行起）。
// 无二进制（ELEPHANT_BIN 未提供）时 getEngine() 返回 null，调用方走内置启发式降级。
const { spawn } = require('child_process');

function fenFromBoard(board, side) {
  const ranks = [];
  for (let y = 9; y >= 0; y--) ranks.push(board[y].join(''));
  return ranks.join('/') + ' ' + (side === 'red' ? 'w' : 'b') + ' - - - 0 1';
}
function coordToXY(coord) { const x = coord.charCodeAt(0) - 97; const y = parseInt(coord[1], 10); return [x, y]; }

class UcciEngine {
  constructor(bin) {
    this.bin = bin || process.env.ELEPHANT_BIN || 'elephanteye';
    this.ready = false; this.pending = []; this.active = null; this.broken = false;
    try { this.proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { this.broken = true; return; }
    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.on('error', () => { this.broken = true; this._fail(); });
    this.proc.on('close', () => { this.broken = true; this._fail(); });
    this._send('ucci');
  }
  _send(cmd) { try { this.proc.stdin.write(cmd + '\n'); } catch (e) { this.broken = true; } }
  _fail() { const j = this.active; if (j) { this.active = null; j.resolve(null); } while (this.pending.length) this.pending.shift().resolve(null); }
  _onData(text) {
    for (const line of text.split('\n')) {
      if (line.startsWith('ucciok')) { this.ready = true; this._pump(); }
      else if (line.startsWith('bestmove')) {
        const mv = line.split(' ')[1]; const j = this.active;
        if (j) { this.active = null; j.resolve(mv && mv !== 'none' && mv.length >= 4 ? mv : null); this._pump(); }
      }
    }
  }
  _pump() { if (this.active || !this.ready || this.broken) return; const job = this.pending.shift(); if (!job) return; this.active = job; this._send('position fen ' + fenFromBoard(job.board, job.side)); this._send('go depth ' + (job.depth ?? 4)); }
  bestMove(board, side, opts = {}) {
    return new Promise((resolve) => {
      if (this.broken) return resolve(null);
      this.pending.push({ board, side, depth: opts.depth ?? 4, resolve });
      this._pump();
    }).then((mv) => { if (!mv) return null; const [fx, fy] = coordToXY(mv.slice(0, 2)); const [tx, ty] = coordToXY(mv.slice(2, 4)); return { from: [fx, fy], to: [tx, ty] }; });
  }
  quit() { try { this._send('quit'); } catch (e) {} }
}

let engine = null, tried = false;
function getEngine() { if (tried) return engine; tried = true; try { engine = new UcciEngine(); } catch (e) { engine = null; } return engine; }
module.exports = { getEngine, fenFromBoard };
