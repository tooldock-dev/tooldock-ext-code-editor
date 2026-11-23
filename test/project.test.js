'use strict';
/* 從其他工具開啟專案：接收 git-tool.project（用假的 ctx） */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../backend/project');
const ext = require('../backend/index');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-proj-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function fakeCtx() {
  const data = new Map();
  const events = [];
  const ctx = {
    events,
    storage: {
      get: (k, d) => (data.has(k) ? data.get(k) : d),
      set: (k, v) => data.set(k, v),
      delete: (k) => data.delete(k),
      keys: () => [...data.keys()],
    },
    settings: { get: (k, d) => d, all: () => ({}) },
    ui: { emit: (event, payload) => events.push({ event, payload }) },
    log: { info() {}, warn() {}, error() {} },
    toasts: [],
    window: { toast: async (m) => { ctx.toasts.push(m); return true; } },
  };
  return ctx;
}

test('解析：需要存在的絕對路徑；檔案不能跳出專案；從交換檔匯入時拒絕', () => withTmp((dir) => {
  fs.mkdirSync(path.join(dir, 'src'));
  const p = P.parsePayload({ name: 'App', path: dir, file: 'src/a.js', line: 7 });
  assert.deepEqual(p, { name: 'App', root: dir, file: path.join(dir, 'src', 'a.js'), line: 7 });
  assert.equal(P.parsePayload({ path: dir, file: '../x' }).file, null);
  assert.equal(P.parsePayload({ path: dir, file: path.join(os.tmpdir(), 'x') }).file, null);
  assert.equal(P.parsePayload({ path: dir, line: 3 }).line, null);
  assert.equal(P.parsePayload({ path: dir }).name, path.basename(dir));
  assert.throws(() => P.parsePayload({ path: 'rel/x' }), /絕對路徑/);
  assert.throws(() => P.parsePayload({ path: path.join(dir, 'none') }), /不存在/);
  assert.throws(() => P.parsePayload({ remotes: [{ name: 'origin', url: 'https://github.com/a/b.git' }] }), /沒有專案路徑/);
  assert.throws(() => P.parsePayload({ path: dir }, { origin: 'file' }), /Git 工具複製/);
  assert.throws(() => P.parsePayload([]), /不正確/);
}));

test('選擇專案：資料夾相同；指定檔案時可以用包含它的子資料夾專案', () => {
  const r = path.resolve('/w/repo');
  const projects = [
    { id: 'a', root: path.resolve('/w/repo/app') },
    { id: 'b', root: path.resolve('/w/repo/app/web') },
    { id: 'c', root: path.resolve('/w/other') },
  ];
  assert.equal(P.pickProject(projects, { root: path.resolve('/w/other'), file: null }).id, 'c');
  assert.equal(P.pickProject(projects, { root: r, file: null }), null);
  assert.equal(P.pickProject(projects, { root: r, file: path.resolve('/w/repo/app/web/x.js') }).id, 'b');
  assert.equal(P.pickProject(projects, { root: r, file: path.resolve('/w/repo/app/y.js') }).id, 'a');
  assert.equal(P.pickProject(projects, { root: r, file: path.resolve('/w/repo/z.js') }), null);
});

test('匯入：建立或切換專案，交給畫面開啟檔案', () => withTmp((dir) => {
  const ctx = fakeCtx();
  ext._internal.setContext(ctx);
  fs.mkdirSync(path.join(dir, 'repo', 'app'), { recursive: true });
  const repo = path.join(dir, 'repo');

  const r1 = ext._internal.importProject({ payload: { name: 'repo', path: repo } }, { origin: 'share', producer: { extId: 'git-tool', name: 'Git 工具' } });
  assert.equal(r1.status, 'imported');
  assert.equal(r1.data.added, true);
  const [proj] = ctx.storage.get('projects');
  assert.equal(proj.root, repo);
  assert.equal(ctx.storage.get('lastProject'), proj.id);
  assert.deepEqual(ext._internal.takePending(), { command: 'openProject', id: proj.id, file: null, line: null });
  assert.equal(ctx.events.at(-1).event, 'command');

  // 再送一次：不重複建立
  const r2 = ext._internal.importProject({ payload: { path: repo, file: 'app/a.js', line: 2 } }, { origin: 'share' });
  assert.equal(r2.data.added, false);
  assert.equal(ctx.storage.get('projects').length, 1);
  assert.deepEqual(ext._internal.takePending(), { command: 'openProject', id: proj.id, file: path.join(repo, 'app', 'a.js'), line: 2 });

  // 已有子資料夾專案、送來的是儲存庫根目錄加上其中的檔案：用子資料夾專案
  const sub = ext._internal.addProject({ root: path.join(repo, 'app'), name: 'app' }).project;
  ext._internal.removeProject(proj.id);
  const r3 = ext._internal.importProject({ payload: { path: repo, file: 'app/a.js' } }, { origin: 'share' });
  assert.equal(r3.data.projectId, sub.id);

  const r4 = ext._internal.importProject({ payload: { path: repo } }, { origin: 'file' });
  assert.equal(r4.status, 'rejected');
  assert.match(r4.message, /Git 工具/);
  assert.equal(ctx.toasts.at(-1), r4.message, '拒絕時要用 toast 告訴使用者');
}));
