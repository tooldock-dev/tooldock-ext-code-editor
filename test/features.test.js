'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const search = require('../backend/search');
const edits = require('../backend/edits');
const git = require('../backend/git');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-feat-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); edits._reset(); }
}
const write = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('跨檔案搜尋：排除清單、包含／排除樣式、略過二進位、Big5 唯讀、CRLF 的位置', () => withTmp(async (dir) => {
  write(dir, 'a.js', 'foo();\r\nbar(foo);\r\n');
  write(dir, 'src/b.ts', 'const foo = 1;\n');
  write(dir, 'node_modules/x/c.js', 'foo\n');
  write(dir, 'bin.dat', Buffer.from([0x66, 0x6f, 0x6f, 0, 1]));
  write(dir, 'big5.txt', Buffer.concat([Buffer.from('foo '), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])]));
  const r = await search.search(dir, { query: 'foo' }, 'node_modules');
  assert.deepEqual(r.files.map((f) => f.rel).sort(), ['a.js', 'big5.txt', 'src/b.ts']);
  assert.equal(r.skipped.binary, 1);
  const a = r.files.find((f) => f.rel === 'a.js');
  assert.deepEqual(a.matches.map((m) => [m.line, m.col, m.start]), [[1, 1, 0], [2, 5, 11]], '位置以 LF 計算，和編輯器一致');
  assert.equal(r.files.find((f) => f.rel === 'big5.txt').readOnly, 'big5');
  assert.equal(r.total, 4);
  assert.deepEqual((await search.search(dir, { query: 'foo', include: 'src/' }, 'node_modules')).files.map((f) => f.rel), ['src/b.ts']);
  assert.deepEqual((await search.search(dir, { query: 'foo', exclude: '*.txt, src' }, 'node_modules')).files.map((f) => f.rel), ['a.js']);
  assert.deepEqual((await search.search(dir, { query: 'foo', skip: ['a.js', 'big5.txt'] }, 'node_modules')).files.map((f) => f.rel), ['src/b.ts']);
  assert.deepEqual((await search.search(dir, { query: 'foo', only: ['a.js'] }, 'node_modules')).files.map((f) => f.rel), ['a.js']);
  const g = await search.search(dir, { query: 'bar\\((\\w+)\\)', regex: true }, '');
  assert.deepEqual(g.files[0].matches[0].g, ['foo']);
  await assert.rejects(search.search(dir, { query: '(', regex: true }, ''), /規則運算式有誤/);
  assert.deepEqual((await search.search(dir, { query: '' }, '')).files, []);
}));

test('跨檔案搜尋：新的搜尋開始時，舊的搜尋停止', () => withTmp(async (dir) => {
  for (let i = 0; i < 200; i++) write(dir, `f${i}.txt`, 'hit\n');
  const first = search.search(dir, { query: 'hit' }, '');
  const second = search.search(dir, { query: 'hit' }, '');
  assert.deepEqual(await first, { canceled: true });
  assert.equal((await second).files.length, 200);
}));

test('取代：保留 CRLF 與 BOM、檔案改過就不取代、可以復原；復原時跳過之後又改過的檔案', () => withTmp(async (dir) => {
  write(dir, 'a.cs', '﻿int foo;\r\nfoo = 2;\r\n');
  write(dir, 'b.cs', 'foo\n');
  write(dir, 'c.cs', 'foo\n');
  const r = await search.search(dir, { query: 'foo' }, '');
  const items = r.files.map((f) => ({ file: f.file, reps: f.matches.map((m) => ({ start: m.start, end: m.end, text: m.text, replacement: 'bar' })) }));
  write(dir, 'c.cs', 'xfoo\n'); // 搜尋之後被改過
  items.push({ file: path.join(os.tmpdir(), 'outside.txt'), reps: [{ start: 0, end: 1, text: 'x', replacement: '' }] });
  const op = edits.begin('取代');
  const res = search.replaceInFiles(dir, items, op);
  assert.deepEqual(res.map((x) => [path.basename(x.file), x.ok, x.count]), [['a.cs', true, 2], ['b.cs', true, 1], ['c.cs', false, 0], ['outside.txt', false, 0]]);
  assert.match(res[2].reason, /被修改過/);
  assert.match(res[3].reason, /不在專案/);
  assert.equal(read(dir, 'a.cs'), '﻿int bar;\r\nbar = 2;\r\n');
  assert.equal(read(dir, 'c.cs'), 'xfoo\n');
  const id = edits.commit(op);
  assert.ok(id);
  // b.cs 取代之後又被改過：復原時跳過
  fs.writeFileSync(path.join(dir, 'b.cs'), 'changed later\n');
  const u = edits.undo(id);
  assert.deepEqual(u.restored.map((f) => path.basename(f)), ['a.cs']);
  assert.deepEqual(u.skipped.map((f) => [path.basename(f.file), f.reason]), [['b.cs', '之後又被修改過']]);
  assert.equal(read(dir, 'a.cs'), '﻿int foo;\r\nfoo = 2;\r\n');
  assert.equal(read(dir, 'b.cs'), 'changed later\n');
  assert.throws(() => edits.undo(id), /沒有可以復原/);
  assert.equal(edits.commit(edits.begin('空的')), null, '沒有寫入任何檔案就不記錄');
}));

test('取代：Big5 等唯讀編碼不取代；保留檔案權限', { skip: process.platform === 'win32' && 'Windows 沒有執行權限位元' }, () => withTmp(async (dir) => {
  write(dir, 'big5.txt', Buffer.concat([Buffer.from('foo '), Buffer.from([0xa4, 0xa4])]));
  write(dir, 'run.sh', 'echo foo\n');
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  const op = edits.begin('取代');
  const res = search.replaceInFiles(dir, [
    { file: path.join(dir, 'big5.txt'), reps: [{ start: 0, end: 3, text: 'foo', replacement: 'x' }] },
    { file: path.join(dir, 'run.sh'), reps: [{ start: 5, end: 8, text: 'foo', replacement: 'bar' }] },
  ], op);
  assert.match(res[0].reason, /BIG5/);
  assert.equal(res[1].ok, true);
  assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o777, 0o755);
  // 復原後權限也還在
  edits.undo(edits.commit(op));
  assert.equal(read(dir, 'run.sh'), 'echo foo\n');
  assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o777, 0o755);
}));

let hasGit = true;
try { execFileSync('git', ['--version']); } catch { hasGit = false; }

function repo(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', a, { cwd: dir, env }).toString('utf8');
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  return g;
}

test('Git 還原：改回暫存區的版本、重新建立被刪除的檔案、刪除未追蹤的檔案，都可以復原', { skip: !hasGit && '沒有安裝 git' }, () => withTmp(async (dir) => {
  const g = repo(dir);
  write(dir, 'a.txt', 'one\n');
  write(dir, 'gone.txt', 'keep me\n');
  write(dir, 'run.sh', 'echo 1\n');
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  write(dir, 'a.txt', 'two\n');
  g('add', 'a.txt'); // 暫存區是 two
  write(dir, 'a.txt', 'three\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.rmSync(path.join(dir, 'run.sh'));
  write(dir, 'new.txt', 'temp\n');
  const st = await git.status(dir);
  const items = [...st.unstaged, ...st.untracked].map((e) => ({ area: e.area, path: e.path }));
  const op = edits.begin('還原');
  const res = await git.restore(dir, dir, [...items, { area: 'staged', path: 'a.txt' }, { area: 'unstaged', path: '../x' }], op);
  assert.deepEqual(res.map((r) => r.ok), [true, true, true, true, false, false]);
  assert.match(res[4].reason, /Git 工具/);
  assert.equal(read(dir, 'a.txt'), 'two\n', '改回暫存區，不是 HEAD');
  assert.equal(read(dir, 'gone.txt'), 'keep me\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111, 0o111, '可執行權限');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  const after = await git.status(dir);
  assert.deepEqual([after.unstaged.length, after.untracked.length, after.staged.length], [0, 0, 1], '已暫存的變更不受影響');
  const u = edits.undo(edits.commit(op));
  assert.equal(u.skipped.length, 0);
  assert.equal(read(dir, 'a.txt'), 'three\n');
  assert.equal(read(dir, 'new.txt'), 'temp\n');
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false, '復原也會把重新建立的檔案刪掉');
}));

test('Git 逐段還原：只改回指定的那一段，保留 CRLF；差異變了就拒絕', { skip: !hasGit && '沒有安裝 git' }, () => withTmp(async (dir) => {
  const g = repo(dir);
  write(dir, 'w.txt', 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  write(dir, 'w.txt', 'a\r\nB\r\nc\r\nd\r\ne\r\nf\r\ng\r\nH\r\nextra\r\n');
  const C = require('../ui/code-core');
  const d = await git.diffSides(dir, { area: 'unstaged', path: 'w.txt' });
  const hs = C.hunks(C.diffLines(C.toLines(d.left.text), C.toLines(d.right.text)));
  assert.equal(hs.length, 2);
  const op = edits.begin('逐段');
  await git.revertHunk(dir, dir, 'w.txt', hs[1], op);
  assert.equal(read(dir, 'w.txt'), 'a\r\nB\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\n');
  await assert.rejects(git.revertHunk(dir, dir, 'w.txt', hs[1], edits.begin('x')), /差異已經變更/);
  await git.revertHunk(dir, dir, 'w.txt', { aStart: 1, aLen: 1, bStart: 1, bLen: 1 }, op);
  assert.equal(read(dir, 'w.txt'), 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\n');
  assert.equal((await git.status(dir)).unstaged.length, 0);
  edits.undo(edits.commit(op));
  assert.equal(read(dir, 'w.txt'), 'a\r\nB\r\nc\r\nd\r\ne\r\nf\r\ng\r\nH\r\nextra\r\n');
  // 在檔案最後：結尾換行跟暫存區一樣
  write(dir, 'n.txt', 'x\ny');
  g('add', 'n.txt');
  write(dir, 'n.txt', 'x\ny\nz\n');
  const d2 = await git.diffSides(dir, { area: 'unstaged', path: 'n.txt' });
  const h2 = C.hunks(C.diffLines(C.toLines(d2.left.text), C.toLines(d2.right.text)));
  await git.revertHunk(dir, dir, 'n.txt', h2[h2.length - 1], edits.begin('x'));
  assert.equal(read(dir, 'n.txt'), 'x\ny');
}));

test('檔案歷史：跟著重新命名、兩種比對、還原成歷史版本', { skip: !hasGit && '沒有安裝 git' }, () => withTmp(async (dir) => {
  const g = repo(dir);
  write(dir, 'old.txt', 'v1\n');
  g('add', '.');
  g('commit', '-q', '-m', '第一版');
  write(dir, 'old.txt', 'v2\n');
  g('commit', '-q', '-am', '第二版');
  g('mv', 'old.txt', '新.txt');
  g('commit', '-q', '-m', '改名');
  write(dir, '新.txt', 'v3\n');
  g('commit', '-q', '-am', '第三版');
  write(dir, '新.txt', 'working\n');
  const log = await git.fileLog(dir, dir, '新.txt');
  assert.deepEqual(log.commits.map((c) => [c.subject, c.status, c.path, c.orig]), [
    ['第三版', 'M', '新.txt', ''],
    ['改名', 'R', '新.txt', 'old.txt'],
    ['第二版', 'M', 'old.txt', ''],
    ['第一版', 'A', 'old.txt', ''],
  ]);
  assert.equal(log.limited, false);
  const [c3, cr, c2, c1] = log.commits;
  const s2 = await git.versionSides(dir, dir, { rev: c2.hash, path: c2.path, status: c2.status, mode: 'commit' });
  assert.deepEqual([s2.left.text, s2.right.text], ['v1\n', 'v2\n']);
  const sr = await git.versionSides(dir, dir, { rev: cr.hash, path: cr.path, orig: cr.orig, status: cr.status, mode: 'commit' });
  assert.deepEqual([sr.left.text, sr.right.text, sr.left.label], ['v2\n', 'v2\n', '上一版：old.txt']);
  const s1 = await git.versionSides(dir, dir, { rev: c1.hash, path: c1.path, status: c1.status, mode: 'commit' });
  assert.equal(s1.left.exists, false, '第一個提交沒有上一版');
  const sw = await git.versionSides(dir, dir, { rev: c3.hash, path: c3.path, status: c3.status, mode: 'working', target: '新.txt' });
  assert.deepEqual([sw.left.text, sw.right.text], ['v3\n', 'working\n']);
  await assert.rejects(git.versionSides(dir, dir, { rev: 'HEAD;rm', path: 'x', mode: 'commit' }), /提交編號/);
  const op = edits.begin('還原版本');
  await git.restoreVersion(dir, dir, { rev: c1.hash, path: c1.path, target: '新.txt' }, op);
  assert.equal(read(dir, '新.txt'), 'v1\n', '用當時的路徑取出內容，寫到目前的檔案');
  edits.undo(edits.commit(op));
  assert.equal(read(dir, '新.txt'), 'working\n');
  await assert.rejects(git.restoreVersion(dir, dir, { rev: c1.hash, path: 'nope.txt', target: '新.txt' }, edits.begin('x')), /沒有這個檔案/);
  fs.mkdirSync(path.join(dir, 'sub'));
  await assert.rejects(git.fileLog(dir, path.join(dir, 'sub'), '新.txt'), /不在專案/);
  assert.equal(git.parseLog(Buffer.from('')).length, 0);
}));
