'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 * v0.21.0（R9-1）服务端 zip 解压器 —— 大包直传的落地面
 * ----------------------------------------------------------------------------
 * 背景：安卓 WebView 的 JS 堆有限，JSZip 解压大包（>96MB）有 OOM 闪退风险，
 * v0.10.16 因此给手机端设了解压闸门 —— 结果 138MB 级的游戏包（战机代号666）
 * 被整条路拦死，「之前能导、现在不能」。
 *
 * 本模块让「解压」彻底离开手机：手机端只把原始 zip 按 4MB 分片搬运上来
 * （内存峰值 ≈ 单个分片），服务端用 Node 内置 zlib 解压 —— 零新依赖。
 *
 * 实现说明（zip 格式最小子集）：
 *   · 从文件尾扫 EOCD（0x06054b50）拿 central directory 位置与条目数；
 *   · 遍历 central directory（0x02014b50）取名字/方法/尺寸/本地头偏移；
 *   · 逐条目按本地头（0x04034b50）的数据起点读压缩字节：
 *       method 0 = store 原样落盘；method 8 = deflateRaw 解压；其余报错。
 *   · 文件名解码与前端 ext-import.js 同口径：bit11 置位 → UTF-8；
 *     否则含高位字节优先 GBK（Windows 中文压缩包主流），解出 U+FFFD 回退 UTF-8。
 *   · 防护：ZIP64 不支持（显式报错）、多卷报错、路径穿越拦截、
 *     __MACOSX 跳过、文件数/总大小上限、条目长度校验。
 * 内存策略：central directory 一次性读入（几万条目也在几 MB 级）；
 *   条目数据逐条读取释放，峰值 ≈ 最大单文件解压后体积。
 * ═══════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const U8 = new TextDecoder('utf-8');
let GBK = null;
try { GBK = new TextDecoder('gbk'); } catch (e) { /* 无 full-icu 时降级 UTF-8 */ }

function decodeName(buf, flags) {
  if (flags & 0x800) return U8.decode(buf);
  let high = false;
  for (let i = 0; i < buf.length; i++) { if (buf[i] >= 0x80) { high = true; break; } }
  if (!high) return U8.decode(buf);
  if (GBK) {
    try { const s = GBK.decode(buf); if (s.indexOf('\uFFFD') < 0) return s; } catch (e) { }
  }
  return U8.decode(buf);
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }

/** 从文件尾找 EOCD（注释区最长 65535 字节，窗口取 66KB） */
function findEocd(fd, size) {
  const len = Math.min(66000, size);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  for (let i = len - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return { base: size - len + i, buf, at: i };
    }
  }
  return null;
}

/**
 * 解压 zipPath 到 destDir。
 * @returns {{ files:number, bytes:number, names:string[] }}
 * @throws Error（带用户可读中文消息）
 */
function extract(zipPath, destDir, opts) {
  const o = opts || {};
  const maxFiles = o.maxFiles || 20000;
  const maxBytes = o.maxBytes || 512 * 1024 * 1024;
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, size);
    if (!eocd) throw new Error('不是有效的 zip 压缩包（找不到目录结尾标记）');
    const eb = eocd.buf, e = eocd.at;
    const diskNo = u16(eb, e + 4);
    if (diskNo !== 0) throw new Error('不支持分卷压缩包，请打成单个 zip 后重试');
    let count = u16(eb, e + 10);
    let cdSize = u32(eb, e + 12);
    let cdOff = u32(eb, e + 16);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      throw new Error('暂不支持 ZIP64 格式（包体超大时请用标准 zip 重新打包）');
    }
    if (cdOff + cdSize > size) throw new Error('压缩包目录区损坏，请重新打包');

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0, realCount = 0;
    while (p + 46 <= cd.length && realCount < count) {
      if (!(cd[p] === 0x50 && cd[p + 1] === 0x4b && cd[p + 2] === 0x01 && cd[p + 3] === 0x02)) break;
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      const csize = u32(cd, p + 20);
      const usize = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), elen = u16(cd, p + 30), clen = u16(cd, p + 32);
      const lho = u32(cd, p + 42);
      const name = decodeName(cd.slice(p + 46, p + 46 + nlen), flags);
      entries.push({ name, flags, method, csize, usize, lho });
      p += 46 + nlen + elen + clen;
      realCount++;
    }
    if (!entries.length) throw new Error('压缩包是空的');

    /* 剥统一顶层目录（与前端 openZip 同口径：所有条目都在同一第一级目录下）。
     * 注意：路径穿越条目（../ 开头）不参与顶层统计，否则会让 strip 失效。 */
    const tops = new Set();
    let hasRoot = false;
    for (const it of entries) {
      if (it.name.endsWith('/')) continue;
      if (it.name.indexOf('..') >= 0) continue;
      const s = it.name.split('/')[0];
      if (it.name.indexOf('/') < 0) hasRoot = true; else tops.add(s);
    }
    const strip = (tops.size === 1 && !hasRoot) ? [...tops][0] + '/' : '';

    /* 先过一遍清单校验（数量/上限/路径安全），再动 IO。
     * 安全关键：穿越检查必须同时作用于「原始名」与「剥层后终名」——
     * 否则 ../evil.txt 被剥层切片后可能变成合法的 il.txt 落盘（测试实证）。 */
    const jobs = [];
    let total = 0;
    for (const it of entries) {
      if (it.name.endsWith('/')) continue;
      if (it.name.indexOf('__MACOSX/') === 0) continue;
      const orig = it.name.replace(/\\/g, '/');
      if (orig.indexOf('..') >= 0 || orig.startsWith('/')) continue;
      const rel = (strip ? orig.slice(strip.length) : orig).replace(/^\/+/, '');
      if (!rel || rel.indexOf('..') >= 0) continue;
      total += it.usize;
      jobs.push({ it, rel });
    }
    if (!jobs.length) throw new Error('压缩包里没有可安装的文件');
    if (jobs.length > maxFiles) throw new Error('文件数超过上限（' + maxFiles + '）');
    if (total > maxBytes) throw new Error('解压后总大小超过 ' + Math.round(maxBytes / 1048576) + 'MB 上限');

    fs.mkdirSync(destDir, { recursive: true });
    let bytes = 0;
    const names = [];
    const lh = Buffer.alloc(30);
    for (const job of jobs) {
      const it = job.it;
      if (it.method !== 0 && it.method !== 8) {
        throw new Error('「' + job.rel + '」使用了暂不支持的压缩方式（method=' + it.method + '）');
      }
      if (fs.readSync(fd, lh, 0, 30, it.lho) !== 30 ||
          !(lh[0] === 0x50 && lh[1] === 0x4b && lh[2] === 0x03 && lh[3] === 0x04)) {
        throw new Error('「' + job.rel + '」本地头损坏，压缩包可能不完整');
      }
      const nlen2 = u16(lh, 26), elen2 = u16(lh, 28);
      const dataOff = it.lho + 30 + nlen2 + elen2;
      if (it.csize > maxBytes) throw new Error('「' + job.rel + '」单文件超过包体上限');
      const raw = Buffer.alloc(it.csize);
      if (fs.readSync(fd, raw, 0, it.csize, dataOff) !== it.csize) {
        throw new Error('「' + job.rel + '」数据不完整，压缩包可能没传完或损坏');
      }
      let out;
      if (it.method === 8) {
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }); }
        catch (e) { throw new Error('「' + job.rel + '」解压失败，压缩包可能已损坏'); }
      } else {
        out = raw;
      }
      if (it.usize !== 0xFFFFFFFF && out.length !== it.usize) {
        throw new Error('「' + job.rel + '」解压后长度不符（预期 ' + it.usize + '，实得 ' + out.length + '）');
      }
      const target = path.join(destDir, job.rel);
      if (path.relative(destDir, target).indexOf('..') === 0) continue;   // 双保险
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      bytes += out.length;
      names.push(job.rel);
    }
    return { files: names.length, bytes, names };
  } finally {
    fs.closeSync(fd);
  }
}

/** 与前端 findEntry 同口径的入口探测（服务端直传路径用） */
function findEntry(names) {
  for (const c of ['index.html', 'game.html', 'main.html']) if (names.indexOf(c) >= 0) return c;
  const rootHtml = names.find(n => n.indexOf('/') < 0 && /\.html?$/i.test(n));
  if (rootHtml) return rootHtml;
  return names.find(n => /\.html?$/i.test(n)) || '';
}

module.exports = { extract, findEntry };
