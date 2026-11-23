'use strict';
/**
 * 搜尋與符號索引的範圍：除了檔案樹的排除清單，再略過
 *   1. 「搜尋排除」設定（逗號分隔，語法同 .gitignore：Pods、*.min.js、docs/build）
 *   2. git 專案裡被 .gitignore（含 .git/info/exclude）忽略的檔案
 * 遇到被略過的資料夾就整個不進去，所以 Pods、build 這類大資料夾不會拖慢走訪。
 */
const fs = require('fs');
const path = require('path');

const escRe = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** gitignore 樣式 → 正規表示式（* 不跨資料夾，** 可跨多層） */
function globToRe(p) {
  let s = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') { s += '(?:.*/)?'; i += 2; continue; }
        if (atStart && i + 2 === p.length) { s += '.*'; i += 1; continue; }
        s += '[^/]*';
        i += 1;
        continue;
      }
      s += '[^/]*';
    } else if (c === '?') {
      s += '[^/]';
    } else if (c === '[') {
      const j = p.indexOf(']', i + 2);
      if (j < 0) { s += '\\['; continue; }
      let cls = p.slice(i + 1, j);
      if (cls[0] === '!') cls = `^${cls.slice(1)}`;
      s += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = j;
    } else if (c === '\\' && i + 1 < p.length) {
      s += escRe(p[++i]);
    } else {
      s += escRe(c);
    }
  }
  return new RegExp(`^${s}$`);
}

/** 一行 gitignore 規則；空行或註解回傳 null */
function compileRule(line) {
  let s = String(line).replace(/\r$/, '');
  if (!s || s[0] === '#') return null;
  s = s.replace(/(?<!\\)\s+$/, '');
  if (!s) return null;
  let neg = false;
  if (s[0] === '!') { neg = true; s = s.slice(1); } else if (s.startsWith('\\!') || s.startsWith('\\#')) s = s.slice(1);
  let dirOnly = false;
  if (s.endsWith('/')) { dirOnly = true; s = s.replace(/\/+$/, ''); }
  if (!s) return null;
  // 開頭或中間有 / 的規則只比對相對於 .gitignore 所在資料夾的路徑，否則比對任何一層的名稱
  const anchored = s.includes('/');
  if (s[0] === '/') s = s.slice(1);
  try { return { re: globToRe(s), neg, dirOnly, anchored }; } catch { return null; }
}

const compileGitignore = (text) => String(text || '').split('\n').map(compileRule).filter(Boolean);

/** 「搜尋排除」設定：逗號或換行分隔 */
const compilePatterns = (spec) => String(spec || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map(compileRule).filter(Boolean);

/** rules 依序比對，最後一條符合的決定結果；回傳 true（忽略）、false（重新包含）或 null（沒有規則符合） */
function testRules(rules, sub, name, isDir, prev = null) {
  let res = prev;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(r.anchored ? sub : name)) res = !r.neg;
  }
  return res;
}

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

/** 往上找 git 工作目錄的根（有 .git 的資料夾）；找不到回傳 null */
function findRepoTop(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const relPosix = (from, to) => path.relative(from, to).split(path.sep).join('/');

/**
 * 專案的忽略規則。scope = { patterns（搜尋排除）, gitignore（是否套用 .gitignore） }
 * 每個資料夾的 .gitignore 只讀一次（快取在 frames）；規則改了就建立新的 Ignorer。
 */
class Ignorer {
  constructor(root, { patterns = '', gitignore = true } = {}) {
    this.root = root;
    this.patterns = compilePatterns(patterns);
    this.gitignore = !!gitignore;
    this.frames = new Map();
    // 專案資料夾在 git 工作目錄裡面時，上層的 .gitignore 也要套用
    const sets = [];
    let inRepo = false;
    if (this.gitignore) {
      const top = findRepoTop(path.dirname(root));
      const self = fs.existsSync(path.join(root, '.git'));
      if (top && !self) {
        inRepo = true;
        const chain = [];
        for (let d = path.dirname(root); ; d = path.dirname(d)) { chain.unshift(d); if (d === top || path.dirname(d) === d) break; }
        for (const d of chain) {
          const pre = `${relPosix(d, root)}/`;
          const rules = [...(d === top ? compileGitignore(readText(path.join(d, '.git', 'info', 'exclude'))) : []), ...compileGitignore(readText(path.join(d, '.gitignore')))];
          if (rules.length) sets.push({ base: '', pre, rules });
        }
      }
    }
    this.outer = { chain: sets, inRepo };
  }

  /** 資料夾 dirRel（'' 為專案根目錄）的規則鏈；names 是已知的目錄內容（省去 exists 檢查） */
  frame(dirRel, names) {
    const hit = this.frames.get(dirRel);
    if (hit) return hit;
    const parent = dirRel ? this.frame(dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : '') : this.outer;
    let f = parent;
    if (this.gitignore) {
      const abs = path.join(this.root, dirRel);
      const has = (n) => (names ? names.has(n) : fs.existsSync(path.join(abs, n)));
      const repoRoot = has('.git');
      const inRepo = parent.inRepo || repoRoot;
      const rules = [];
      if (inRepo) {
        if (repoRoot) rules.push(...compileGitignore(readText(path.join(abs, '.git', 'info', 'exclude'))));
        if (has('.gitignore')) rules.push(...compileGitignore(readText(path.join(abs, '.gitignore'))));
      }
      if (rules.length) f = { chain: [...parent.chain, { base: dirRel, pre: '', rules }], inRepo };
      else if (inRepo !== parent.inRepo) f = { chain: parent.chain, inRepo };
    }
    this.frames.set(dirRel, f);
    return f;
  }

  /** rel 這個項目本身是否被忽略（不檢查上層資料夾）；frame 是所在資料夾的規則鏈 */
  ignored(rel, isDir, frame) {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (testRules(this.patterns, rel, name, isDir) === true) return true;
    if (!this.gitignore) return false;
    const f = frame || this.frame(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    let res = null;
    for (const set of f.chain) {
      const sub = set.pre + (set.base ? rel.slice(set.base.length + 1) : rel);
      res = testRules(set.rules, sub, name, isDir, res);
    }
    return res === true;
  }

  /** rel 本身或任何一層上層資料夾被忽略 */
  pathIgnored(rel, isDir) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (this.ignored(parts.slice(0, i).join('/'), i < parts.length || isDir)) return true;
    }
    return false;
  }
}

/** 設定 → 範圍；字串視為只有檔案樹排除清單（相容舊的呼叫方式） */
function scopeOf(arg) {
  if (typeof arg === 'string' || arg == null) return { exclude: arg || '', patterns: '', gitignore: false };
  return { exclude: arg.exclude || '', patterns: arg.patterns || '', gitignore: !!arg.gitignore };
}

const scopeKey = (s) => JSON.stringify([s.exclude, s.patterns, s.gitignore]);

module.exports = { Ignorer, compileRule, compileGitignore, compilePatterns, globToRe, scopeOf, scopeKey, findRepoTop };
