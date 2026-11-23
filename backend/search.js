'use strict';
/**
 * 跨檔案搜尋與取代。
 * 搜尋：走過專案檔案（套用檔案樹的排除清單與包含／排除樣式），跳過二進位與過大的檔案，
 * 以和編輯器相同的方式解碼（換行統一成 LF），所以位置可以直接對應到編輯器的內容。
 * 取代：重新讀檔，確認每一處的原文還和搜尋時一樣才寫入，並保留換行字元與 BOM。
 */
const fs = require('fs');
const path = require('path');
const C = require('../ui/code-core');
const files = require('./files');
const { Ignorer, scopeOf } = require('./ignore');

const MAX_FILE = 10 * 1024 * 1024; // 超過就不搜尋
const MAX_MATCHES = 20000; // 全部檔案合計最多列出的筆數
const MAX_SEARCH_FILES = 100000;

let current = 0;

const tick = () => new Promise((r) => setImmediate(r));

/** 單一檔案：回傳 { matches, truncated, readOnly } 或略過原因 { skip } */
function searchFile(abs, re, opts, limit) {
  let st;
  try { st = fs.statSync(abs); } catch { return { skip: 'missing' }; }
  if (!st.isFile()) return { skip: 'missing' };
  if (st.size > MAX_FILE) return { skip: 'large' };
  const doc = files.decodeText(fs.readFileSync(abs));
  if (doc.binary) return { skip: 'binary' };
  const r = C.findInText(doc.text, re, { limit, groups: !!opts.regex });
  return { ...r, mtime: st.mtimeMs, readOnly: doc.readOnly ? doc.encoding : '' };
}

/**
 * 搜尋專案：opts = { query, regex, caseSens, word, include, exclude, skip（不搜尋的相對路徑，例如已在編輯器開啟的檔案）, only（只搜尋這些相對路徑） }
 * scopeArg：檔案樹排除清單字串，或 { exclude, patterns（搜尋排除）, gitignore }（見 ignore.js）。
 * 回傳的 hidden 是 skip 裡落在排除範圍內的路徑（畫面據此不搜尋這些已開啟的分頁），ignored 是被搜尋排除或 .gitignore 略過的項目數。
 * 新的搜尋開始時，還在跑的舊搜尋會停止並回傳 { canceled: true }。
 */
async function search(root, opts, scopeArg) {
  const scope = scopeOf(scopeArg);
  const excludeSetting = scope.exclude;
  const token = ++current;
  let re;
  try { re = C.searchRegex(opts); } catch (err) { throw new Error(`規則運算式有誤：${err.message}`); }
  if (!re) return { files: [], total: 0, searched: 0, skipped: {}, truncated: false, hidden: [], ignored: 0 };
  const keep = C.pathFilter(opts.include, opts.exclude);
  const skipSet = new Set(opts.skip || []);
  const ignore = scope.patterns || scope.gitignore ? new Ignorer(root, scope) : null;
  const skipName = files.excluder(excludeSetting);
  const hidden = Array.isArray(opts.only) ? [] : [...skipSet].filter((rel) => typeof rel === 'string'
    && (rel.split('/').some(skipName) || (ignore && ignore.pathIgnored(rel, false))));
  let list;
  let tooMany = false;
  let ignored = 0;
  if (Array.isArray(opts.only)) list = opts.only.filter((r) => typeof r === 'string');
  else ({ files: list, truncated: tooMany, ignored } = files.listFiles(root, excludeSetting, MAX_SEARCH_FILES, { ignore }));
  const out = [];
  const skipped = { binary: 0, large: 0 };
  let total = 0;
  let searched = 0;
  let truncated = false;
  for (let i = 0; i < list.length; i++) {
    if (i % 40 === 39) {
      await tick();
      if (token !== current) return { canceled: true };
    }
    const rel = list[i];
    if (skipSet.has(rel) || (!opts.only && !keep(rel))) continue;
    let abs;
    try { abs = files.resolveIn(root, rel); } catch { continue; }
    let r;
    try { r = searchFile(abs, re, opts, MAX_MATCHES - total); } catch { continue; }
    if (r.skip) { if (skipped[r.skip] !== undefined) skipped[r.skip]++; continue; }
    searched++;
    if (r.matches.length) {
      out.push({ rel, file: abs, mtime: r.mtime, readOnly: r.readOnly, matches: r.matches });
      total += r.matches.length;
    }
    if (r.truncated || total >= MAX_MATCHES) { truncated = true; break; }
  }
  return { files: out, total, searched, skipped, truncated, tooMany, hidden, ignored };
}

function cancel() { current++; }

/**
 * 寫入取代：items = [{ file, reps: [{ start, end, text, replacement }] }]，op 為 edits.begin() 的操作。
 * 回傳每個檔案的結果 { file, ok, count, reason }。
 */
function replaceInFiles(root, items, op) {
  const results = [];
  for (const it of items) {
    const res = { file: it.file, ok: false, count: 0 };
    results.push(res);
    try {
      if (typeof it.file !== 'string' || !path.isAbsolute(it.file) || !files.inside(root, it.file)) throw new Error('檔案不在專案資料夾內');
      const reps = Array.isArray(it.reps) ? it.reps.filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && typeof r.text === 'string' && typeof r.replacement === 'string') : [];
      if (!reps.length) throw new Error('沒有要取代的內容');
      const doc = files.readText(it.file);
      if (doc.tooLarge || doc.binary) throw new Error('檔案過大或是二進位檔');
      if (doc.readOnly) throw new Error(`${doc.encoding.toUpperCase()} 編碼的檔案不能取代`);
      const text = C.applyReplacements(doc.text, reps);
      if (text === null) throw new Error('檔案在搜尋之後被修改過，請重新搜尋');
      op.write(it.file, files.encodeText(text, doc.eol, doc.bom));
      res.ok = true;
      res.count = reps.length;
    } catch (err) {
      res.reason = err.message;
    }
  }
  return results;
}

module.exports = { search, cancel, replaceInFiles, searchFile, MAX_FILE, MAX_MATCHES };
