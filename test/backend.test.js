'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const files = require('../backend/files');
const git = require('../backend/git');
const ext = require('../backend/index');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('目錄列表：資料夾在前、數字自然排序、套用排除清單；不能跳出專案', () => withTmp((dir) => {
  for (const f of ['b.js', 'a10.txt', 'a2.txt', 'x.pyc']) fs.writeFileSync(path.join(dir, f), '');
  for (const d of ['src', 'node_modules', '.git']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'src', 'm.js'), '');
  const list = files.listDir(dir, '', 'node_modules, .git, *.pyc');
  assert.deepEqual(list.map((e) => e.name), ['src', 'a2.txt', 'a10.txt', 'b.js']);
  assert.deepEqual(files.listDir(dir, 'src', '').map((e) => e.rel), ['src/m.js']);
  assert.throws(() => files.listDir(dir, '..', ''), /不在專案/);
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'out'));
  assert.throws(() => files.listDir(dir, 'out', ''), /不在專案/, '符號連結指到外面');
  const all = files.listFiles(dir, 'node_modules, .git');
  assert.ok(all.files.includes('src/m.js') && !all.truncated);
  assert.equal(files.listFiles(dir, '', 2).truncated, true);
}));

test('讀寫：保留 CRLF 與 BOM；二進位與 Big5 檔案', () => withTmp((dir) => {
  const f = path.join(dir, 'a.cs');
  fs.writeFileSync(f, '﻿class A {\r\n}\r\n');
  const doc = files.readText(f);
  assert.equal(doc.text, 'class A {\n}\n');
  assert.equal(doc.eol, '\r\n');
  assert.equal(doc.bom, true);
  assert.equal(doc.readOnly, false);
  files.writeText({ file: f, text: doc.text + 'x\n', eol: doc.eol, bom: doc.bom });
  assert.equal(fs.readFileSync(f, 'utf8'), '﻿class A {\r\n}\r\nx\r\n');

  const bin = path.join(dir, 'a.bin');
  fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
  assert.equal(files.readText(bin).binary, true);

  const big5 = path.join(dir, 'b.txt');
  fs.writeFileSync(big5, Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])); // 「中文」
  const b = files.readText(big5);
  assert.equal(b.text, '中文');
  assert.equal(b.encoding, 'big5');
  assert.equal(b.readOnly, true);
}));

test('新增與重新命名：限制在專案內、檢查名稱與重複', () => withTmp((dir) => {
  const r = files.create(dir, '', 'src', true);
  assert.equal(r.rel, 'src');
  const f = files.create(dir, 'src', 'a.js', false);
  assert.equal(f.rel, 'src/a.js');
  assert.throws(() => files.create(dir, 'src', 'a.js', false), /同名/);
  assert.throws(() => files.create(dir, 'src', '../x', false), /名稱/);
  assert.throws(() => files.create(dir, '..', 'x', false), /不在專案/);
  const m = files.rename(dir, 'src', 'lib');
  assert.equal(m.rel, 'lib');
  assert.ok(fs.existsSync(path.join(dir, 'lib', 'a.js')));
  assert.throws(() => files.rename(dir, '', 'x'), /根目錄/);
}));

test('Git 狀態解析：分支、領先落後、重新命名、衝突與未追蹤', () => {
  const raw = Buffer.from('## main...origin/main [ahead 2, behind 1]\0M  a.js\0 M b.js\0MM c.js\0R  new.js\0old.js\0UU d.js\0?? e.js\0');
  const st = git.parseStatus(raw);
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.equal(st.ahead, 2);
  assert.equal(st.behind, 1);
  const g = git.group(st.entries);
  assert.deepEqual(g.staged.map((e) => `${e.status}${e.path}${e.orig ? `<${e.orig}` : ''}`), ['Ma.js', 'Mc.js', 'Rnew.js<old.js']);
  assert.deepEqual(g.unstaged.map((e) => e.path), ['b.js', 'c.js']);
  assert.deepEqual(g.conflict.map((e) => e.path), ['d.js']);
  assert.deepEqual(g.untracked.map((e) => e.path), ['e.js']);
  assert.equal(git.parseStatus(Buffer.from('## No commits yet on dev\0')).noCommits, true);
});

let hasGit = true;
try { execFileSync('git', ['--version']); } catch { hasGit = false; }

test('Git：實際儲存庫的異動清單與三種比對', { skip: !hasGit && '沒有安裝 git' }, () => withTmp(async (dir) => {
  const g = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.deepEqual(await git.status(dir), { repo: false, message: '這個專案不是 Git 儲存庫' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'let a = 1;\nlet b = 2;\n');
  fs.writeFileSync(path.join(dir, 'app', '中文.txt'), '一\n');
  fs.writeFileSync(path.join(dir, 'root.md'), '# x\n');
  g('add', '.');
  g('commit', '-q', '-m', '第一版');
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'let a = 1;\nlet b = 3;\n');
  g('add', 'app/a.js');
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'let a = 1;\nlet b = 3;\nlet c = 4;\n');
  fs.writeFileSync(path.join(dir, 'app', 'new.js'), 'x\n');
  fs.rmSync(path.join(dir, 'app', '中文.txt'));
  fs.writeFileSync(path.join(dir, 'root.md'), '# y\n');

  // 專案是儲存庫的子資料夾：只列出子資料夾內的異動，rel 相對於專案
  const sub = path.join(dir, 'app');
  const st = await git.status(sub);
  assert.equal(st.repo, true);
  assert.equal(st.top, dir);
  assert.equal(st.branch, 'main');
  assert.match(st.head, /第一版/);
  assert.deepEqual(st.staged.map((e) => e.rel), ['a.js']);
  assert.deepEqual(st.unstaged.map((e) => `${e.status} ${e.rel}`).sort(), ['D 中文.txt', 'M a.js']);
  assert.deepEqual(st.untracked.map((e) => e.rel), ['new.js']);
  assert.ok(!JSON.stringify(st).includes('root.md'), '子資料夾外的異動不列出');

  const staged = await git.diffSides(dir, { area: 'staged', path: 'app/a.js' });
  assert.equal(staged.left.text, 'let a = 1;\nlet b = 2;\n');
  assert.equal(staged.right.text, 'let a = 1;\nlet b = 3;\n');
  const unstaged = await git.diffSides(dir, { area: 'unstaged', path: 'app/a.js' });
  assert.equal(unstaged.left.text, 'let a = 1;\nlet b = 3;\n');
  assert.equal(unstaged.right.text, 'let a = 1;\nlet b = 3;\nlet c = 4;\n');
  const del = await git.diffSides(dir, { area: 'unstaged', path: 'app/中文.txt' });
  assert.equal(del.left.text, '一\n');
  assert.equal(del.right.exists, false);
  const untracked = await git.diffSides(dir, { area: 'untracked', path: 'app/new.js' });
  assert.equal(untracked.left.exists, false);
  assert.equal(untracked.right.text, 'x\n');
  await assert.rejects(git.diffSides(dir, { area: 'unstaged', path: '../x' }), /不在儲存庫/);
}));

test('專案清單：建立、同一資料夾不重複、重新命名、移除', () => withTmp((dir) => {
  const data = {};
  const logs = [];
  ext._internal.setContext({
    storage: { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; } },
    log: { info: (m) => logs.push(m) },
  });
  const { addProject, renameProject, removeProject } = ext._internal;
  const a = addProject({ root: dir, name: ' ' });
  assert.equal(a.project.name, path.basename(dir));
  assert.equal(a.existed, false);
  assert.equal(addProject({ root: dir + path.sep, name: 'x' }).existed, true);
  assert.throws(() => addProject({ root: path.join(dir, 'nope') }), /不存在/);
  assert.throws(() => addProject({ root: 'relative' }), /路徑不正確/);
  assert.equal(renameProject({ id: a.project.id, name: '我的專案' })[0].name, '我的專案');
  data[`state:${a.project.id}`] = { tabs: [] };
  data.lastProject = a.project.id;
  assert.deepEqual(removeProject(a.project.id), []);
  assert.ok(!(`state:${a.project.id}` in data));
  assert.equal(data.lastProject, null);
}));
