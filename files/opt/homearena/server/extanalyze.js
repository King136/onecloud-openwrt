/* 外部游戏导入审核解析 + 联机桥注入（v0.20.0 R8-5）
 * ──────────────────────────────────────────────────────────────────────────
 * 用户要求：「对于 H5 和 cocos 导入的游戏，能否通过导入时的审核解析或替换
 * 写入平台真实联机数据，使之能够在平台内真实联机」。
 *
 * 平台的联机能力 = iframe postMessage 桥（web/ext/README.md 协议）+ 房间系统
 * 组播。缺的最后一环是「游戏页里得有人把协议接起来」。本模块在导入完成时：
 *
 *   ① 审核解析 —— 识别引擎（cocos/egret/laya/unity/h5）、扫描包内是否已经
 *      自带桥接入代码（'ha-game' / 'HomeArenaLink' 字样）；
 *   ② 替换写入 —— 对未接桥的包，把 <script src="/ha-link.js"> 自动注入入口
 *      HTML（幂等，已注入/已自带则跳过），游戏侧即可用 window.HomeArenaLink
 *      极简 API 拿到平台真实房间数据（座位/名单/组播/结算回传）。
 *
 * 边界（诚实声明）：注入桥 ≠ 任意单机包自动变联机。游戏逻辑必须调用
 * HomeArenaLink 的 API（哪怕只是把本地状态 send 给对端），玩法同步才成立。
 * 桥的价值：把「接平台联机」的成本降到几行代码，并且导入即就绪、无需改包
 * 源码以外的任何东西。已按协议自研的包（如内置 snake）识别为 native，不注入。
 * ══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const SCAN_FILE_LIMIT = 24;                 // 最多扫描的 html/js 数（导入耗时保护）
const SCAN_BYTES_PER_FILE = 2 * 1024 * 1024; // 单文件扫描上限（大 bundle 只看头 2MB）

/** v0.22.0（R10）：主逻辑混淆/压缩检测 —— 三个实测包三种形态：
 *  ① 斗地主2.0：_0x 十六进制变量名（javascript-obfuscator 标准型）；
 *  ② 洞洞大作战：字符串数组混淆（var X=['base64串',...]）；
 *  ③ 战机代号666：超长单行压缩 bundle（3.3MB 单行）。
 *  三者主逻辑均不可读、无法可靠 hook，「⇄ 联机」徽标必须如实降级为「同屏」。 */
function detectObfuscation(dir, files) {
  let big = 0, hits = 0;
  for (const rel of files) {
    if (big >= 8) break;
    if (!/\.js$/i.test(rel)) continue;
    let st;
    try { st = fs.statSync(path.join(dir, rel)); } catch (e) { continue; }
    if (st.size < 40 * 1024) continue;              // 只看主逻辑（>40KB）
    big++;
    try {
      const txt = fs.readFileSync(path.join(dir, rel), { encoding: 'utf8', flag: 'r' }).slice(0, SCAN_BYTES_PER_FILE);
      const hx = txt.match(/_0x[0-9a-f]{4,6}\b/g);  // ① _0x 名密度
      if (hx && hx.length >= 40) { hits++; continue; }
      const arr = txt.match(/\['(?:[A-Za-z0-9+/=]{8,})'(?:,'(?:[A-Za-z0-9+/=]{8,})'){29,}\]/);  // ② 字符串数组 ≥30 项
      if (arr) { hits++; continue; }
      const lines = txt.split('\n').length;         // ③ 超长单行 bundle
      if (st.size > 200 * 1024 && lines <= Math.max(3, Math.floor(st.size / 5000))) { hits++; continue; }
    } catch (e) { /* 读不了跳过 */ }
  }
  return big > 0 && hits / big >= 0.5;              // 过半主逻辑命中即判混淆/压缩包
}

/** 引擎识别：按包内特征文件名，不依赖包作者自报 */
function detectEngine(files) {
  const names = files.map(f => String(f).toLowerCase());
  const has = re => names.some(n => re.test(n));
  if (has(/(^|\/)cocos-js(\/|$)/) || has(/jsb-adapter/) || has(/(^|\/)src\/settings\.js$/) || has(/(^|\/)application\.[0-9a-f]+\.js$/)) return 'cocos';
  if (has(/libs\/modules\/egret/) || has(/(^|\/)egret(\.min)?\.js$/)) return 'egret';
  if (has(/libs\/laya/) || has(/(^|\/)laya\.(max\.)?(min\.)?js$/)) return 'laya';
  if (has(/\.wasm$/) && has(/\.data$/)) return 'unity';
  return 'h5';
}

/** 扫描包内文本文件，判断是否已自带平台桥接入 */
function scanForBridgeRefs(dir, files) {
  let scanned = 0;
  for (const rel of files) {
    if (scanned >= SCAN_FILE_LIMIT) break;
    if (!/\.(html|js)$/i.test(rel)) continue;
    try {
      const full = path.join(dir, rel);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > SCAN_BYTES_PER_FILE) continue;
      const txt = fs.readFileSync(full, 'utf8');
      if (txt.indexOf('ha-game') >= 0 || txt.indexOf('HomeArenaLink') >= 0 || txt.indexOf('ha-link.js') >= 0) return true;
      scanned++;
    } catch (e) { /* 读不了就跳过 */ }
  }
  return false;
}

/** 把桥客户端注入入口 HTML（幂等） */
function injectBridge(dir, entry) {
  const full = path.join(dir, entry);
  let html;
  try { html = fs.readFileSync(full, 'utf8'); } catch (e) { return { injected: false, reason: '入口不可读' }; }
  if (html.indexOf('ha-link.js') >= 0 || html.indexOf('data-ha-link') >= 0) return { injected: false, already: true };
  const tag = '<script src="/ha-link.js" data-ha-link="1"></script>';
  let out;
  if (/<\/head>/i.test(html)) out = html.replace(/<\/head>/i, tag + '</head>');
  else if (/<body[^>]*>/i.test(html)) out = html.replace(/<body[^>]*>/i, m => m + tag);
  else out = tag + '\n' + html;
  try { fs.writeFileSync(full, out); return { injected: true }; } catch (e) { return { injected: false, reason: '写入失败' }; }
}

/** 导入完成时调用：解析 + 注入。返回分析报告（随 finish 响应给前端展示）。 */
function analyzeAndInject(dir, entry) {
  const files = [];
  (function walk(p) {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  })(dir);
  const engine = detectEngine(files);
  const native = scanForBridgeRefs(dir, files);
  let inj = { injected: false };
  if (!native) inj = injectBridge(dir, entry);
  const mp = native ? 'native' : ((inj.injected || inj.already) ? 'bridge' : 'unknown');
  const obfuscated = detectObfuscation(dir, files);
  return {
    engine,
    mp,                                  // native=自带接入 | bridge=已注入桥 | unknown=注入失败
    obfuscated,                          // true=主逻辑混淆包（真实联机化受限，仅同屏共玩）
    linkInjected: !!inj.injected,
    bridgeAlready: !!inj.already,
    reason: inj.reason || '',
    files: files.length,
  };
}

module.exports = { analyzeAndInject };
