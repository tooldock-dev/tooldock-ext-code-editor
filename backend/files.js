'use strict';
/**
 * 檔案系統：專案資料夾的目錄列表、檔名搜尋、讀寫（保留換行字元與 BOM）、新增與重新命名。
 * 目錄與新增／重新命名都限制在專案根目錄底下（以 realpath 檢查，避免符號連結跳出去）。
 */
const fs = require('fs');
const path = require('path');

const MAX_OPEN = 50 * 1024 * 1024; // 可開啟的檔案大小上限
const MAX_LIST = 30000; // 檔名搜尋最多列出的檔案數

/** 排除清單：逗號分隔的名稱，支援 * 萬用字元（例如 node_modules, *.pyc） */
function excluder(spec) {
  const pats = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    if (!p.includes('*')) return (n) => n === p;
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return (n) => re.test(n);
  });
  return (name) => pats.some((f) => f(name));
}

/** target 是否在 root 底下（含 root 本身） */
function inside(root, target) {
  const r = fs.realpathSync(root);
  let t;
  try { t = fs.realpathSync(target); } catch { t = path.join(fs.realpathSync(path.dirname(target)), path.basename(target)); }
  return t === r || t.startsWith(r + path.sep);
}

function resolveIn(root, rel = '') {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('專案路徑不正確');
  const target = path.resolve(root, String(rel || ''));
  if (!inside(root, target)) throw new Error('路徑不在專案資料夾內');
  return target;
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });

/** 列出 root/rel 底下一層：資料夾在前，依名稱排序 */
function listDir(root, rel, exclude) {
  const dir = resolveIn(root, rel);
  const skip = excluder(exclude);
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(d.name)) continue;
    let isDir = d.isDirectory();
    const link = d.isSymbolicLink();
    if (link) { try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { /* 斷掉的連結當成檔案 */ } }
    out.push({ name: d.name, rel: toRel(rel ? `${rel}/${d.name}` : d.name), dir: isDir, link });
  }
  return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
}

const toRel = (p) => String(p).split(path.sep).join('/');

/** 專案內所有檔案的相對路徑（檔名搜尋用）；不進入符號連結的資料夾 */
function listFiles(root, exclude, limit = MAX_LIST) {
  const skip = excluder(exclude);
  const files = [];
  const queue = [''];
  let truncated = false;
  while (queue.length) {
    const rel = queue.shift();
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => collator.compare(a.name, b.name));
    for (const d of ents) {
      if (skip(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) queue.push(r);
      else if (d.isFile() || d.isSymbolicLink()) {
        if (files.length >= limit) { truncated = true; break; }
        files.push(r);
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}

/** 前 8 KB 有 NUL 字元就當成二進位檔 */
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/**
 * 讀檔：統一成 LF 給畫面，記住換行字元與 BOM。
 * 不是合法 UTF-8 時改用 Big5 解碼並設為唯讀（Node 沒有 Big5 編碼器，存回去會變亂碼）。
 */
function readText(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('檔案路徑不正確');
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('這是資料夾');
  const base = { file, name: path.basename(file), size: st.size, mtime: st.mtimeMs };
  if (st.size > MAX_OPEN) return { ...base, tooLarge: true };
  const buf = fs.readFileSync(file);
  let encoding = 'utf8';
  let bom = false;
  let text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    text = buf.subarray(3).toString('utf8');
  } else if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    encoding = buf[0] === 0xff ? 'utf-16le' : 'utf-16be';
    text = new TextDecoder(encoding).decode(buf.subarray(2));
  } else if (isBinary(buf)) {
    return { ...base, binary: true };
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      encoding = 'big5';
      text = new TextDecoder('big5').decode(buf);
    }
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  return {
    ...base,
    text: text.replace(/\r\n?/g, '\n'),
    eol: crlf > lf ? '\r\n' : '\n',
    bom,
    encoding,
    readOnly: encoding !== 'utf8',
  };
}

function writeText({ file, text, eol = '\n', bom = false }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('存檔路徑不正確');
  const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
  const tmp = `${file}.${process.pid}.tmp`;
  let mode;
  try { mode = fs.statSync(file).mode; } catch { /* 新檔案 */ }
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + body, mode ? { encoding: 'utf8', mode } : 'utf8');
  fs.renameSync(tmp, file);
  return { file, name: path.basename(file), mtime: fs.statSync(file).mtimeMs };
}

const BAD_NAME = /[\\/:*?"<>|\0]/;
function checkName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || BAD_NAME.test(n)) throw new Error('名稱不能是空的，也不能包含 \\ / : * ? " < > |');
  return n;
}

/** 在 root/dirRel 底下新增檔案或資料夾 */
function create(root, dirRel, name, isDir) {
  const dir = resolveIn(root, dirRel);
  const target = path.join(dir, checkName(name));
  if (fs.existsSync(target)) throw new Error('已有同名的檔案或資料夾');
  if (isDir) fs.mkdirSync(target);
  else fs.writeFileSync(target, '', { flag: 'wx' });
  return { file: target, rel: toRel(path.relative(root, target)) };
}

function rename(root, rel, name) {
  const from = resolveIn(root, rel);
  if (from === path.resolve(root)) throw new Error('不能重新命名專案根目錄');
  const to = path.join(path.dirname(from), checkName(name));
  if (to === from) return { file: to, rel: toRel(path.relative(root, to)) };
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error('已有同名的檔案或資料夾');
  fs.renameSync(from, to);
  return { from, file: to, rel: toRel(path.relative(root, to)) };
}

module.exports = { excluder, inside, resolveIn, listDir, listFiles, readText, writeText, create, rename, isBinary, toRel, MAX_OPEN };
