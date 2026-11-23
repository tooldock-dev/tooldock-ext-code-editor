'use strict';
/**
 * 符號索引（跳到定義）：記住專案中每個檔案定義了哪些名稱。
 * 解析規則在 ui/code-core.js 的 symbolsIn（畫面也用同一份規則解析尚未儲存的分頁）。
 *
 * 保持索引最新的方式：
 *   - 全面檢查：走過專案、比對每個檔案的修改時間與大小，只重新解析有變的（第一次查詢、範圍設定改變、沒有檔案監看時）。
 *   - 檔案監看（configure({ watch: true })，macOS 與 Windows）：記下有變動的路徑，查詢時只處理這些路徑。
 *   - 這個擴充自己寫入的檔案（存檔、取代、還原…）由 files.onChange 直接通知，不必等監看事件。
 * 索引存到 configure({ dataDir }) 底下，重新啟動後只要全面檢查一次，不用重新解析整個專案。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('../ui/code-core');
const files = require('./files');
const { Ignorer, scopeOf, scopeKey } = require('./ignore');

const MAX_FILE = 2 * 1024 * 1024; // 超過就不解析
const MAX_FILES = 100000;
const MAX_RESULTS = 200;
const MAX_SYMS_PER_FILE = 5000; // 產生出來的檔案（例如 boost 的前置處理標頭）可能有幾萬個，只留前面這些
const MAX_TEXT = 160; // 每個定義記住的那一行文字（顯示用）
const MAX_CACHE = 64 * 1024 * 1024; // 存檔超過這個大小就不存（每次重新啟動後重新建立）
const MAX_DIRTY = 5000; // 監看到的變動超過這麼多就改成全面檢查
const SAVE_DELAY = 3000;
// 擴充版本變了就不沿用存檔（解析規則可能改了）
const CACHE_VERSION = `2:${require('../package.json').version}`;
const WATCH_PLATFORMS = new Set(['darwin', 'win32']);

const config = { dataDir: null, watch: false };

/**
 * root → {
 *   files: Map<rel, { mtime, size, family, syms }>, busy: Promise|null,
 *   key: 範圍設定（scopeKey）, full: 下次查詢要全面檢查, dirty: Set<rel>（監看到的變動）,
 *   watcher, skipName / ignore: 上次檢查時的排除規則（過濾監看事件用）, saveTimer
 * }
 */
const indexes = new Map();

const tick = () => new Promise((r) => setImmediate(r));

function configure({ dataDir, watch } = {}) {
  if (dataDir !== undefined) config.dataDir = dataDir || null;
  if (watch !== undefined) config.watch = !!watch;
}

function parseFile(abs, rel, st) {
  const lang = C.langFor(rel);
  const family = C.symbolFamily(lang);
  const entry = { mtime: st.mtimeMs, size: st.size, family, syms: [] };
  if (!family || st.size > MAX_FILE) return entry;
  let doc;
  try { doc = files.decodeText(fs.readFileSync(abs)); } catch { return entry; }
  if (doc.binary) return entry;
  entry.syms = C.symbolsIn(doc.text, lang).slice(0, MAX_SYMS_PER_FILE)
    .map((s) => [s.name, s.kind, s.line, s.col, s.text.length > MAX_TEXT ? s.text.slice(0, MAX_TEXT) : s.text]);
  return entry;
}

const indexable = (rel) => !!C.symbolFamily(C.langFor(rel));

/* ───────────── 存檔 ───────────── */

function cacheFile(root) {
  if (!config.dataDir) return null;
  const h = crypto.createHash('sha1').update(root).digest('hex').slice(0, 20);
  return path.join(config.dataDir, 'symbols', `${h}.json`);
}

function load(idx, root) {
  const f = cacheFile(root);
  if (!f) return;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.v !== CACHE_VERSION || j.root !== root || !Array.isArray(j.files)) return;
    for (const [rel, mtime, size, family, syms] of j.files) idx.files.set(rel, { mtime, size, family, syms });
    idx.key = j.key;
    idx.saved = true;
  } catch { /* 沒有存檔或格式不對：重新建立 */ }
}

function save(idx, root) {
  clearTimeout(idx.saveTimer);
  idx.saveTimer = null;
  const f = cacheFile(root);
  if (!f || !indexes.has(root)) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const list = [];
    for (const [rel, e] of idx.files) list.push([rel, e.mtime, e.size, e.family, e.syms]);
    const json = JSON.stringify({ v: CACHE_VERSION, root, key: idx.key, savedAt: Date.now(), files: list });
    if (json.length > MAX_CACHE) { fs.rmSync(f, { force: true }); return; }
    files.writeAtomic(f, json);
  } catch { /* 存不了就算了，下次重新建立 */ }
}

function saveSoon(idx, root) {
  if (!config.dataDir || idx.saveTimer) return;
  idx.saveTimer = setTimeout(() => save(idx, root), SAVE_DELAY);
  if (idx.saveTimer.unref) idx.saveTimer.unref();
}

/* ───────────── 檔案監看 ───────────── */

function markDirty(idx, rel) {
  if (idx.full) return;
  if (idx.dirty.size >= MAX_DIRTY) { idx.full = true; idx.dirty.clear(); return; }
  idx.dirty.add(rel);
}

function onWatch(idx, name) {
  if (name == null) { idx.full = true; return; }
  const rel = String(name).split(path.sep).join('/').replace(/\/+$/, '');
  if (!rel) { idx.full = true; return; }
  const parts = rel.split('/');
  if (idx.skipName && parts.some(idx.skipName)) return;
  if (parts[parts.length - 1] === '.gitignore') { idx.full = true; return; }
  // 被忽略的資料夾裡的變動（例如 build 輸出）不用理會
  const parent = parts.slice(0, -1).join('/');
  if (parent && idx.ignore && idx.ignore.pathIgnored(parent, true)) return;
  markDirty(idx, rel);
}

function startWatch(idx, root) {
  if (!config.watch || !WATCH_PLATFORMS.has(process.platform)) return;
  try {
    const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => onWatch(idx, name));
    w.on('error', () => {
      try { w.close(); } catch { /* 忽略 */ }
      if (idx.watcher === w) idx.watcher = null;
      idx.full = true;
    });
    idx.watcher = w;
  } catch {
    idx.watcher = null;
  }
}

// 這個擴充自己改了檔案：直接記下來
files.onChange((abs) => {
  for (const [root, idx] of indexes) {
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    markDirty(idx, rel.split(path.sep).join('/'));
  }
});

function getIndex(root) {
  let idx = indexes.get(root);
  if (!idx) {
    idx = { files: new Map(), busy: null, key: null, full: true, dirty: new Set(), watcher: null, skipName: null, ignore: null, saveTimer: null };
    indexes.set(root, idx);
    load(idx, root);
    startWatch(idx, root);
  }
  return idx;
}

/* ───────────── 更新索引 ───────────── */

/** 檢查一個檔案：回傳 1 表示重新解析了 */
function updateFile(idx, root, rel) {
  let st;
  try { st = fs.statSync(path.join(root, rel)); } catch { st = null; }
  if (!st || !st.isFile()) { idx.files.delete(rel); return 0; }
  const old = idx.files.get(rel);
  if (old && old.mtime === st.mtimeMs && old.size === st.size) return 0;
  idx.files.set(rel, parseFile(path.join(root, rel), rel, st));
  return 1;
}

/** 移除 prefix 本身與底下所有項目；回傳移除的數量 */
function removeUnder(idx, prefix, keep) {
  let n = 0;
  for (const rel of [...idx.files.keys()]) {
    if ((!prefix || rel === prefix || rel.startsWith(`${prefix}/`)) && !(keep && keep.has(rel))) { idx.files.delete(rel); n++; }
  }
  return n;
}

/** 走過 start 資料夾（'' 為整個專案）底下，更新改過的檔案、移除不存在或不在範圍內的 */
async function scanDir(idx, root, scope, ignore, start) {
  const { files: list } = files.listFiles(root, scope.exclude, MAX_FILES, { ignore, start });
  const alive = new Set();
  let parsed = 0;
  for (let i = 0; i < list.length; i++) {
    if (i % 200 === 199) await tick();
    const rel = list[i];
    if (!indexable(rel)) continue;
    alive.add(rel);
    parsed += updateFile(idx, root, rel);
  }
  const removed = removeUnder(idx, start, alive);
  return { parsed, removed };
}

/** 只處理監看到的變動 */
async function scanDirty(idx, root, scope, ignore, dirty) {
  let parsed = 0;
  let removed = 0;
  const skipName = files.excluder(scope.exclude);
  for (let i = 0; i < dirty.length; i++) {
    if (i % 200 === 199) await tick();
    const rel = dirty[i];
    if (rel.split('/').some(skipName)) continue;
    let st;
    try { st = fs.statSync(path.join(root, rel)); } catch { st = null; }
    if (!st) { removed += removeUnder(idx, rel); continue; }
    if (st.isDirectory()) {
      if (ignore && ignore.pathIgnored(rel, true)) { removed += removeUnder(idx, rel); continue; }
      const r = await scanDir(idx, root, scope, ignore, rel);
      parsed += r.parsed;
      removed += r.removed;
    } else if (!indexable(rel) || (ignore && ignore.pathIgnored(rel, false))) {
      if (idx.files.delete(rel)) removed++;
    } else {
      parsed += updateFile(idx, root, rel);
    }
  }
  return { parsed, removed };
}

/**
 * 建立或更新索引。scopeArg：檔案樹排除清單字串，或 { exclude, patterns, gitignore }（見 ignore.js）。
 * 回傳 { files, parsed, removed, mode（full／dirty／none）, ms }
 */
async function refresh(root, scopeArg) {
  const idx = getIndex(root);
  if (idx.busy) return idx.busy;
  idx.busy = (async () => {
    const t0 = Date.now();
    const scope = scopeOf(scopeArg);
    const key = scopeKey(scope);
    if (idx.key !== key) { idx.key = key; idx.full = true; }
    if (!idx.watcher) idx.full = true;
    const ignore = scope.patterns || scope.gitignore ? new Ignorer(root, scope) : null;
    idx.skipName = files.excluder(scope.exclude);
    idx.ignore = ignore;
    let mode = 'none';
    let r = { parsed: 0, removed: 0 };
    if (idx.full) {
      mode = 'full';
      idx.full = false;
      idx.dirty.clear();
      r = await scanDir(idx, root, scope, ignore, '');
    } else if (idx.dirty.size) {
      mode = 'dirty';
      const dirty = [...idx.dirty];
      idx.dirty.clear();
      r = await scanDirty(idx, root, scope, ignore, dirty);
    }
    if (r.parsed || r.removed || (mode === 'full' && !idx.saved)) { saveSoon(idx, root); idx.saved = true; }
    return { files: idx.files.size, parsed: r.parsed, removed: r.removed, mode, ms: Date.now() - t0 };
  })();
  try { return await idx.busy; } finally { idx.busy = null; }
}

/**
 * 找名稱的定義：opts = { name, ci（不分大小寫）, skip（不查的相對路徑，例如尚未儲存的分頁，由畫面自己解析） }
 * 回傳 { items: [{ rel, file, name, kind, line, col, text, family }], stats }
 */
async function definitions(root, scopeArg, { name, ci = false, skip = [] }) {
  if (typeof name !== 'string' || !name || name.length > 200) return { items: [], stats: null };
  const stats = await refresh(root, scopeArg);
  const idx = indexes.get(root);
  const skipSet = new Set(skip);
  const want = ci ? name.toLowerCase() : name;
  const items = [];
  for (const [rel, f] of idx.files) {
    if (skipSet.has(rel)) continue;
    for (const s of f.syms) {
      if ((ci ? s[0].toLowerCase() : s[0]) !== want) continue;
      items.push({ rel, file: path.join(root, rel), name: s[0], kind: s[1], line: s[2], col: s[3], text: s[4], family: f.family });
      if (items.length >= MAX_RESULTS) return { items, stats, truncated: true };
    }
  }
  return { items, stats };
}

function closeIndex(root, idx, purge) {
  if (idx.watcher) { try { idx.watcher.close(); } catch { /* 忽略 */ } }
  clearTimeout(idx.saveTimer);
  if (purge) { const f = cacheFile(root); if (f) fs.rmSync(f, { force: true }); }
  indexes.delete(root);
}

/** 丟掉索引；purge 時連存檔一起刪除（移除專案時） */
function forget(root, { purge = false } = {}) {
  if (root) { const idx = indexes.get(root); if (idx) closeIndex(root, idx, purge); else if (purge) { const f = cacheFile(root); if (f) fs.rmSync(f, { force: true }); } return; }
  for (const [r, idx] of [...indexes]) closeIndex(r, idx, purge);
}

/** 擴充停止：把還沒存的索引寫進存檔、停止監看 */
function close() {
  for (const [root, idx] of [...indexes]) {
    if (idx.saveTimer) save(idx, root);
    closeIndex(root, idx, false);
  }
}

module.exports = { configure, refresh, definitions, forget, close, MAX_FILE, _indexes: indexes, _cacheFile: cacheFile };
