'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ig = require('../backend/ignore');
const files = require('../backend/files');
const search = require('../backend/search');
const symbols = require('../backend/symbols');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ign-')));
  try { return await fn(dir); } finally {
    symbols.forget();
    symbols.configure({ dataDir: null, watch: false });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const write = (dir, rel, data = '') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('gitignore 樣式：名稱、路徑、**、資料夾限定、否定、跳脫', () => {
  const m = (pat, rel, isDir = false) => {
    const r = ig.compileRule(pat);
    if (!r || (r.dirOnly && !isDir)) return false;
    return r.re.test(r.anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1));
  };
  assert.equal(m('*.log', 'a/b/x.log'), true);
  assert.equal(m('*.log', 'a/b/x.logs'), false);
  assert.equal(m('build/', 'src/build', true), true);
  assert.equal(m('build/', 'src/build', false), false);
  assert.equal(m('/build', 'build', true), true);
  assert.equal(m('/build', 'src/build', true), false);
  assert.equal(m('docs/gen', 'docs/gen', true), true);
  assert.equal(m('docs/gen', 'x/docs/gen', true), false);
  assert.equal(m('**/gen', 'x/y/gen', true), true);
  assert.equal(m('**/gen', 'gen', true), true);
  assert.equal(m('a/**/b', 'a/b'), true);
  assert.equal(m('a/**/b', 'a/x/y/b'), true);
  assert.equal(m('out/**', 'out/a/b.js'), true);
  assert.equal(m('out/**', 'out', true), false);
  assert.equal(m('src/*.js', 'src/a/b.js'), false);
  assert.equal(m('file?.txt', 'file1.txt'), true);
  assert.equal(m('[ab].txt', 'b.txt'), true);
  assert.equal(m('[!ab].txt', 'b.txt'), false);
  assert.equal(m('\\#x', '#x'), true);
  assert.equal(ig.compileRule('# 註解'), null);
  assert.equal(ig.compileRule('   '), null);
  assert.equal(ig.compileRule('!keep.log').neg, true);
  assert.equal(ig.compilePatterns('Pods, *.min.js,\n docs/build').length, 3);
});

test('Ignorer：巢狀 .gitignore、否定、info/exclude、上層 repo、不是 git 專案的資料夾不套用', () => withTmp(async (dir) => {
  // dir/repo 是 git 專案；dir/plain 不是
  write(dir, 'repo/.git/info/exclude', 'secret.txt\n');
  write(dir, 'repo/.gitignore', '*.log\n!keep.log\nbuild/\n/top-only\n');
  write(dir, 'repo/src/.gitignore', 'gen/\n!important.log\n');
  write(dir, 'plain/.gitignore', '*.js\n');
  const a = new ig.Ignorer(path.join(dir, 'repo'), { gitignore: true });
  assert.equal(a.pathIgnored('x.log', false), true);
  assert.equal(a.pathIgnored('keep.log', false), false);
  assert.equal(a.pathIgnored('src/important.log', false), false);
  assert.equal(a.pathIgnored('src/other.log', false), true);
  assert.equal(a.pathIgnored('src/build/a.js', false), true);
  assert.equal(a.pathIgnored('src/gen/a.js', false), true);
  assert.equal(a.pathIgnored('gen/a.js', false), false);
  assert.equal(a.pathIgnored('top-only', true), true);
  assert.equal(a.pathIgnored('src/top-only', true), false);
  assert.equal(a.pathIgnored('secret.txt', false), true);
  assert.equal(a.pathIgnored('src/a.js', false), false);
  // 關掉 .gitignore 時只看搜尋排除
  const off = new ig.Ignorer(path.join(dir, 'repo'), { gitignore: false, patterns: 'src' });
  assert.equal(off.pathIgnored('x.log', false), false);
  assert.equal(off.pathIgnored('src/a.js', false), true);
  // 不是 git 專案：.gitignore 不算數
  const p = new ig.Ignorer(path.join(dir, 'plain'), { gitignore: true });
  assert.equal(p.pathIgnored('a.js', false), false);
  // 專案資料夾是 repo 的子資料夾：上層的規則也套用（路徑從上層算起）
  const sub = new ig.Ignorer(path.join(dir, 'repo', 'src'), { gitignore: true });
  assert.equal(sub.pathIgnored('x.log', false), true);
  assert.equal(sub.pathIgnored('build', true), true);
  assert.equal(sub.pathIgnored('gen/a.js', false), true);
  assert.equal(sub.pathIgnored('secret.txt', false), true); // info/exclude 的名稱規則對整個 repo 有效
  // 搜尋排除比 .gitignore 的否定規則優先
  const both = new ig.Ignorer(path.join(dir, 'repo'), { gitignore: true, patterns: 'keep.log' });
  assert.equal(both.pathIgnored('keep.log', false), true);
}));

test('listFiles 套用忽略規則：被忽略的資料夾不進去、計算略過的數量；從子資料夾開始列', () => withTmp(async (dir) => {
  write(dir, '.git/HEAD', 'ref');
  write(dir, '.gitignore', 'dist/\n');
  write(dir, 'src/a.js');
  write(dir, 'dist/a.js');
  write(dir, 'ios/Pods/x/y.m');
  write(dir, 'ios/App.swift');
  const ignore = new ig.Ignorer(dir, { gitignore: true, patterns: 'Pods' });
  const r = files.listFiles(dir, '.git', 1000, { ignore });
  assert.deepEqual(r.files.sort(), ['.gitignore', 'ios/App.swift', 'src/a.js']);
  assert.equal(r.ignored, 2);
  assert.deepEqual(files.listFiles(dir, '.git', 1000, { ignore, start: 'ios' }).files, ['ios/App.swift']);
  assert.equal(files.listFiles(dir, '.git').files.length, 5);
}));

test('搜尋：套用搜尋排除與 .gitignore、可關閉、已開啟分頁落在範圍外會列在 hidden', () => withTmp(async (dir) => {
  write(dir, '.git/HEAD', 'ref');
  write(dir, '.gitignore', 'build/\n');
  write(dir, 'src/a.js', 'needle\n');
  write(dir, 'build/a.js', 'needle\n');
  write(dir, 'ios/Pods/p.m', 'needle\n');
  write(dir, 'node_modules/m.js', 'needle\n');
  const scope = { exclude: 'node_modules, .git', patterns: 'Pods', gitignore: true };
  const r = await search.search(dir, { query: 'needle', skip: ['build/a.js', 'src/b.js', 'node_modules/m.js'] }, scope);
  assert.deepEqual(r.files.map((f) => f.rel), ['src/a.js']);
  assert.equal(r.ignored, 2);
  assert.deepEqual(r.hidden.sort(), ['build/a.js', 'node_modules/m.js']);
  const all = await search.search(dir, { query: 'needle' }, { exclude: 'node_modules, .git', patterns: '', gitignore: false });
  assert.deepEqual(all.files.map((f) => f.rel).sort(), ['build/a.js', 'ios/Pods/p.m', 'src/a.js']);
  // 舊的呼叫方式（只有排除清單字串）照舊
  assert.equal((await search.search(dir, { query: 'needle' }, 'node_modules, .git')).files.length, 3);
}));

test('符號索引：套用範圍、存到磁碟後重新載入不必重新解析、範圍改變全面檢查、移除專案刪除存檔', () => withTmp(async (dir) => {
  const proj = path.join(dir, 'p');
  const data = path.join(dir, 'data');
  write(proj, '.git/HEAD', 'ref');
  write(proj, '.gitignore', 'build/\n');
  write(proj, 'src/a.js', 'function run() {}\n');
  write(proj, 'build/a.js', 'function run() {}\n');
  write(proj, 'ios/Pods/x.js', 'function run() {}\n');
  symbols.configure({ dataDir: data, watch: false });
  const scope = { exclude: '.git', patterns: 'Pods', gitignore: true };
  let r = await symbols.definitions(proj, scope, { name: 'run' });
  assert.deepEqual(r.items.map((x) => x.rel), ['src/a.js']);
  const first = r.stats.parsed;
  assert.ok(!symbols._indexes.get(proj).files.has('build/a.js') && !symbols._indexes.get(proj).files.has('ios/Pods/x.js'));
  // 存檔（停止擴充時會立即寫入）
  symbols.close();
  const cache = symbols._cacheFile(proj);
  assert.ok(fs.existsSync(cache));
  // 重新載入：檔案沒變，不用重新解析
  r = await symbols.definitions(proj, scope, { name: 'run' });
  assert.equal(r.stats.parsed, 0);
  assert.equal(r.stats.mode, 'full');
  assert.equal(r.items.length, 1);
  // 範圍改變：不套用 .gitignore 後 build 也列入
  r = await symbols.definitions(proj, { ...scope, gitignore: false }, { name: 'run' });
  assert.deepEqual(r.items.map((x) => x.rel).sort(), ['build/a.js', 'src/a.js']);
  assert.equal(r.stats.parsed, 1);
  // 版本不同的存檔不沿用
  symbols.close();
  const j = JSON.parse(fs.readFileSync(cache, 'utf8'));
  fs.writeFileSync(cache, JSON.stringify({ ...j, v: 'old' }));
  r = await symbols.definitions(proj, scope, { name: 'run' });
  assert.equal(r.stats.parsed, first);
  // 移除專案：連存檔一起刪除
  symbols.forget(proj, { purge: true });
  assert.equal(fs.existsSync(cache), false);
}));

test('符號索引：檔案監看只處理變動的路徑；擴充自己寫入的檔案立即生效', { skip: !['darwin', 'win32'].includes(process.platform) && '只在 macOS 與 Windows 監看' }, () => withTmp(async (dir) => {
  write(dir, 'src/a.js', 'function run() {}\n');
  write(dir, 'src/b.js', 'function other() {}\n');
  symbols.configure({ watch: true });
  const scope = { exclude: '.git', patterns: 'Pods', gitignore: true };
  const q = (name) => symbols.definitions(dir, scope, { name });
  let r = await q('run');
  assert.equal(r.stats.mode, 'full');
  assert.equal(r.items.length, 1);
  r = await q('run');
  assert.equal(r.stats.mode, 'none');
  // 擴充自己存檔：不必等監看事件
  files.writeText({ file: path.join(dir, 'src', 'b.js'), text: 'function run() {}\n' });
  r = await q('run');
  assert.equal(r.stats.mode, 'dirty');
  assert.equal(r.items.length, 2);
  // 外部修改：等監看事件
  const until = async (cond) => { for (let i = 0; i < 40; i++) { await wait(100); const x = await cond(); if (x) return x; } return null; };
  write(dir, 'lib/c.js', 'function run() {}\n');
  r = await until(async () => { const x = await q('run'); return x.items.length === 3 ? x : null; });
  assert.ok(r, '新增的資料夾沒有被加入索引');
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  r = await until(async () => { const x = await q('run'); return x.items.length === 2 ? x : null; });
  assert.ok(r, '刪除的資料夾沒有移出索引');
  // 搜尋排除裡的資料夾有變動也不理會
  write(dir, 'ios/Pods/p.js', 'function run() {}\n');
  await wait(500);
  r = await q('run');
  assert.equal(r.items.length, 2);
}));
