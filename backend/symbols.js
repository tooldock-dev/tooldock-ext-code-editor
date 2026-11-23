'use strict';
/**
 * 符號索引（跳到定義）：記住專案中每個檔案定義了哪些名稱。
 * 第一次查詢時建立；之後每次查詢只重新解析修改時間或大小改變的檔案，刪除的檔案移出索引。
 * 解析規則在 ui/code-core.js 的 symbolsIn（畫面也用同一份規則解析尚未儲存的分頁）。
 */
const fs = require('fs');
const path = require('path');
const C = require('../ui/code-core');
const files = require('./files');

const MAX_FILE = 2 * 1024 * 1024; // 超過就不解析
const MAX_FILES = 100000;
const MAX_RESULTS = 200;

/** root → { files: Map<rel, { mtime, size, family, syms }>, busy: Promise|null } */
const indexes = new Map();

const tick = () => new Promise((r) => setImmediate(r));

function parseFile(abs, rel, st) {
  const lang = C.langFor(rel);
  const family = C.symbolFamily(lang);
  const entry = { mtime: st.mtimeMs, size: st.size, family, syms: [] };
  if (!family || st.size > MAX_FILE) return entry;
  let doc;
  try { doc = files.decodeText(fs.readFileSync(abs)); } catch { return entry; }
  if (doc.binary) return entry;
  entry.syms = C.symbolsIn(doc.text, lang).map((s) => [s.name, s.kind, s.line, s.col, s.text]);
  return entry;
}

/** 建立或更新索引；回傳 { files, parsed, ms } */
async function refresh(root, exclude) {
  let idx = indexes.get(root);
  if (!idx) { idx = { files: new Map(), busy: null }; indexes.set(root, idx); }
  if (idx.busy) return idx.busy;
  idx.busy = (async () => {
    const t0 = Date.now();
    const { files: list } = files.listFiles(root, exclude, MAX_FILES);
    const alive = new Set();
    let parsed = 0;
    for (let i = 0; i < list.length; i++) {
      if (i % 200 === 199) await tick();
      const rel = list[i];
      if (!C.symbolFamily(C.langFor(rel))) continue;
      alive.add(rel);
      const abs = path.join(root, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const old = idx.files.get(rel);
      if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
      idx.files.set(rel, parseFile(abs, rel, st));
      parsed++;
    }
    for (const rel of idx.files.keys()) if (!alive.has(rel)) idx.files.delete(rel);
    return { files: idx.files.size, parsed, ms: Date.now() - t0 };
  })();
  try { return await idx.busy; } finally { idx.busy = null; }
}

/**
 * 找名稱的定義：opts = { name, ci（不分大小寫）, skip（不查的相對路徑，例如尚未儲存的分頁，由畫面自己解析） }
 * 回傳 { items: [{ rel, file, name, kind, line, col, text, family }], stats }
 */
async function definitions(root, exclude, { name, ci = false, skip = [] }) {
  if (typeof name !== 'string' || !name || name.length > 200) return { items: [], stats: null };
  const stats = await refresh(root, exclude);
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

function forget(root) { if (root) indexes.delete(root); else indexes.clear(); }

module.exports = { refresh, definitions, forget, MAX_FILE };
