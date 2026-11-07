/* HomeArena 外部游戏注册表 —— v0.10.7
 * ----------------------------------------------------------------------------
 * 让「H5 / Cocos 游戏包」能自助导入本平台，并写入标准注册表，无需改代码。
 *
 * 存储：app/server/data/ext-registry.json
 *   { "games": [ { id, label, seats, engine, entry, dir, version, author,
 *                  desc, size, installedAt, hash, enabled } ] }
 *
 * 约束（家庭局域网场景，但仍需防呆）：
 *   · id 只允许 [a-z0-9_-]，3~24 位，不得与内置游戏冲突；
 *   · entry 必须是包内相对路径且以 .html 结尾，禁止 ../ 越界；
 *   · 单包解压后总大小 ≤ 60MB、文件数 ≤ 3000（NAS 内存与磁盘友好）；
 *   · 目录必须含 index.html（Cocos 导出一般自带）；
 *   · 同名安装 = 覆盖升级，保留 createdAt，更新 installedAt / version。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* v0.10.9：外部游戏必须落在「可写且不被升级覆盖」的目录。
 * 原来 DATA_DIR / EXT_ROOT 都挂在 __dirname 下的安装目录里，
 * 而 fpk 安装后 app/ 归 root 且位于系统包路径，普通用户导入必然 EACCES；
 * 即便侥幸写入，重装/升级也会被整体覆盖导致游戏消失。
 * 优先 HOMEARENA_DATA_DIR，其次 fnOS 的 /vol1/@appdata/homearena，最后回退安装目录（开发态）。 */
function pickDataDir() {
  const cands = [];
  if (process.env.HOMEARENA_DATA_DIR) cands.push(process.env.HOMEARENA_DATA_DIR);
  cands.push('/vol1/@appdata/homearena');
  // fnOS 多卷：/vol1 /vol2 …
  for (let i = 1; i <= 4; i++) cands.push('/vol' + i + '/@appdata/homearena');
  cands.push(path.join(require('os').homedir(), '.homearena'));
  cands.push(path.join(__dirname, 'data'));
  for (const c of cands) {
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (e) { /* 试下一个 */ }
  }
  return path.join(__dirname, 'data');
}

const BASE_DIR = pickDataDir();
const DATA_DIR = path.join(BASE_DIR, 'data');
const REG_FILE = path.join(DATA_DIR, 'ext-registry.json');
const EXT_ROOT = path.join(BASE_DIR, 'ext');

/* v0.10.12：单包上限从 60MB / 3000 文件提到 512MB / 20000 文件。
 * 分片上传解决的是「单请求 body 上限」，这里解决的是「整包总量上限」。
 * 512MB 对 NAS 家庭场景足够（主流 Cocos H5 包 30~150MB）。 */
const LIMITS = { maxBytes: 512 * 1024 * 1024, maxFiles: 20000 };
const RESERVED = ['gomoku', 'chess', 'xiangqi', 'doudizhu', 'guandan', 'mahjong',
  'reversi', 'connect4', 'go', 'texas', 'shengji'];

function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  try { fs.mkdirSync(EXT_ROOT, { recursive: true }); } catch (e) { }
}

function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(REG_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.games) ? j : { games: [] };
  } catch (e) {
    return { games: [] };
  }
}
function save(reg) {
  ensureDirs();
  const tmp = REG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, REG_FILE);          // 原子替换，避免断电写坏
}

/** id 合法性校验，返回 { ok, msg } */
function validateId(id) {
  /* v0.10.17：允许中文 id。
   *
   * 旧规则只有 [a-z0-9_-]，而中文用户导入的包名几乎都是中文
   * （「斗地主2.0测试」）。前端被这条规则逼着把中文全删掉，
   * 结果 id 只剩 "2-0" 这种无意义的值 —— 大厅目录、注册表、URL 全是它。
   *
   * 现在放开到「汉字 + 小写字母 + 数字 + _ -」，同时仍然拦掉一切
   * 路径分隔符、点号、引号等危险字符（它们是不变的红线：
   * id 会拼进文件系统路径，绝不能让 ../ 或 / 混进来）。
   * 长度按字符数算（中文一字一字符），上限 24。 */
  if (typeof id !== 'string' || !/^[\u4e00-\u9fa5a-z0-9_-]{2,24}$/.test(id)) {
    return { ok: false, msg: 'ID 可用中文/小写字母/数字/下划线/短横线，2~24 位' };
  }
  if (RESERVED.indexOf(id) >= 0) {
    return { ok: false, msg: 'ID「' + id + '」与内置游戏冲突，请换一个' };
  }
  return { ok: true };
}

/** entry 相对路径安全校验（防目录穿越） */
function safeEntry(entry) {
  const e = String(entry || 'index.html').replace(/^\/+/, '');
  if (e.indexOf('..') >= 0 || e.indexOf('\\') >= 0) return null;
  if (!/\.html?$/i.test(e)) return null;
  return e;
}

/** 列出（供 /api/ext/list 与启动时注册） */
function list() {
  return load().games.map(g => ({
    id: g.id, label: g.label, seats: g.seats, engine: g.engine,
    entry: g.entry, version: g.version || '', author: g.author || '',
    desc: g.desc || '', size: g.size || 0, installedAt: g.installedAt,
    enabled: g.enabled !== false,
    mp: g.mp || '',   // v0.20.0（R8-5）联机接入状态：native 自带 / bridge 已注入桥
    obf: !!g.obf,     // v0.22.0（R10）混淆包标记
  }));
}

/** 取单条完整记录 */
function get(id) {
  return load().games.find(g => g.id === id) || null;
}

/**
 * 安装/升级一个游戏目录（files 已在磁盘上就位）
 * meta: { id, label, seats, engine, entry, version, author, desc, hash, size }
 */
function encodePathSegments(p) {
  return String(p || '').split('/').map(seg => encodeURIComponent(seg)).join('/');
}
function upsert(meta, dirRel) {
  const reg = load();
  const i = reg.games.findIndex(g => g.id === meta.id);
  const now = Date.now();
  const rec = {
    id: meta.id,
    label: String(meta.label || meta.id).slice(0, 24),
    seats: Math.max(1, Math.min(8, Number(meta.seats) || 2)),
    engine: ['cocos', 'egret', 'laya', 'unity'].indexOf(meta.engine) >= 0 ? meta.engine : 'h5',
    /* v0.10.17：id 现在可以是中文，而 entry 要拼进 iframe 的 src。
     * 直接塞中文会让部分 WebView / 反向代理把 URL 弄坏（未编码的多字节字符），
     * 所以这里对 id 与 entry 各自 encodeURIComponent —— 以 / 分隔的路径结构保留，
     * 只有每一段做编码。文件名里本来就有中文的（如「首页.html」）也一并覆盖到。 */
    entry: '/ext/' + encodePathSegments(meta.id) + '/' + encodePathSegments(meta.entry || 'index.html'),
    dir: dirRel,
    version: String(meta.version || '1.0.0').slice(0, 20),
    author: String(meta.author || '').slice(0, 32),
    desc: String(meta.desc || '').slice(0, 60),
    size: Number(meta.size) || 0,
    hash: meta.hash || '',
    /* v0.20.0（R8-5）联机接入状态（导入审核解析产出）：
     *   native —— 包内已自带平台桥协议，真联机；
     *   bridge —— 已自动注入 /ha-link.js，游戏调 HomeArenaLink API 即联机；
     *   ''     —— 注入未成功（入口异常），共享房模式。 */
    mp: meta.mp === 'native' || meta.mp === 'bridge' ? meta.mp : '',
    obf: !!meta.obf,   // v0.22.0（R10）主逻辑混淆包：联机徽标如实降级为「同屏」
    installedAt: now,
    enabled: true,
  };
  if (i >= 0) { rec.createdAt = reg.games[i].createdAt || now; reg.games[i] = rec; }
  else { rec.createdAt = now; reg.games.push(rec); }
  save(reg);
  return rec;
}

/**
 * v0.10.13：启用 / 停用（不删文件）
 *
 * 为什么需要它：用户反馈「导入游戏缺乏管理办法，无法删除和还原或其它操作」。
 * 「删除」是销毁性的，而很多场景只是想暂时从大厅隐藏 ——
 * 比如导入坏了要排查、家长不想让孩子看到某款、或者一局游戏卡住了想先关掉。
 * 停用只翻 enabled 标记，**文件原样保留**，随时可一键恢复，
 * 这比「删了再重新导入一次」安全得多。
 */
function setEnabled(id, on) {
  const reg = load();
  const g = reg.games.find(x => x.id === id);
  if (!g) return { ok: false, msg: '未安装该游戏' };
  g.enabled = !!on;
  save(reg);
  return { ok: true, id, enabled: g.enabled };
}

/** 卸载：删注册项 + 删目录（仅限 ext 根目录下的子目录） */
function remove(id) {
  const reg = load();
  const g = reg.games.find(x => x.id === id);
  if (!g) return { ok: false, msg: '未安装该游戏' };
  reg.games = reg.games.filter(x => x.id !== id);
  save(reg);
  try {
    const target = path.join(EXT_ROOT, id);
    const rel = path.relative(EXT_ROOT, target);
    if (rel && rel.indexOf('..') < 0) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (e) { /* 删除失败不影响注册表已移除 */ }
  return { ok: true };
}

/** 统计目录体量（文件数 / 字节数）。
 * v0.10.14：超限不再返回 null（原来 finish 拿到 null 只能报
 * 「包体过大或文件数超限」这种二选一的模糊话），改带 over 字段说明哪个维度超了。 */
function measure(dir) {
  let files = 0, bytes = 0, over = '';
  const walk = (d) => {
    const ents = fs.readdirSync(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(p).size; } catch (err) { }
        if (files > LIMITS.maxFiles) over = 'files';
        if (bytes > LIMITS.maxBytes) over = over || 'bytes';
      }
    }
  };
  try { walk(dir); } catch (e) { return null; }
  return { files, bytes, over };
}

/* v0.10.14：改为流式异步哈希。
 * 原实现 `h.update(fs.readFileSync(p))` 同步把每个文件整个读进内存 ——
 * 512MB 的包会一次性分配 512MB Buffer 且阻塞事件循环数秒，
 * 期间所有玩家的 socket 消息、API 请求全部停摆（表现为「安装时全服卡死」）。
 * 现在用 createReadStream 分块喂给哈希，内存占用恒为 64KB 量级。 */
function sha1Dir(dir) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    const files = [];
    const collect = (d, pre) => {
      const ents = fs.readdirSync(d, { withFileTypes: true });
      for (const e of ents) {
        const rel = pre ? pre + '/' + e.name : e.name;
        if (e.isDirectory()) collect(path.join(d, e.name), rel);
        else if (e.isFile()) files.push(rel);
      }
    };
    try { collect(dir, ''); } catch (e) { return resolve(''); }
    files.sort();
    const paths = files.map(f => path.join(dir, f));
    let i = 0;
    const next = () => {
      if (i >= paths.length) return resolve(h.digest('hex').slice(0, 12));
      const p = paths[i++];
      h.update(path.relative(dir, p));
      const st = fs.createReadStream(p, { highWaterMark: 256 * 1024 });
      st.on('data', c => h.update(c));
      st.on('end', next);
      st.on('error', () => next());
    };
    next();
  });
}

module.exports = { load, save, list, get, upsert, remove, setEnabled, validateId, safeEntry, measure, sha1Dir, LIMITS, EXT_ROOT, RESERVED };
