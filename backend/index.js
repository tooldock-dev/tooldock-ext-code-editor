'use strict';
/**
 * 程式碼編輯器後端：專案清單、專案檔案樹、檔案讀寫、跨檔案搜尋與取代、Git 異動清單、比對內容、還原與檔案歷史。
 * 編輯中的內容在畫面上；後端只處理檔案系統與 git。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const files = require('./files');
const git = require('./git');
const search = require('./search');
const symbols = require('./symbols');
const decompiler = require('./decompile');
const edits = require('./edits');
const P = require('./project');

let ctx = null;
let pendingCommand = null; // 畫面還沒開時收到的指令：字串，或從其他工具開啟專案時的物件 { command, ... }

const setting = (k, d) => {
  const v = ctx.settings.get(`codeEditor.${k}`, d);
  return v === undefined ? d : v;
};
const exclude = () => setting('exclude', 'node_modules, .git, .svn, .hg, .DS_Store, Thumbs.db, __pycache__');
const gitPath = () => setting('gitPath', '') || undefined;
const javaPath = () => String(setting('javaPath', '') || '').trim();
const DEFAULT_SEARCH_EXCLUDE = 'Pods, DerivedData, .expo, .next, .nuxt, .gradle, .dart_tool, .venv, venv, bower_components, coverage, *.min.js, *.min.css, *.map';
/** 搜尋與符號索引的範圍；useIgnore 為 false 時只套用檔案樹排除清單 */
const searchScope = (useIgnore = true) => ({
  exclude: exclude(),
  patterns: useIgnore ? String(setting('searchExclude', DEFAULT_SEARCH_EXCLUDE) || '') : '',
  gitignore: useIgnore && setting('searchUseGitignore', true) !== false,
});

/* ───────────── 專案 ───────────── */

const projects = () => ctx.storage.get('projects', []);

function project(id) {
  const p = projects().find((x) => x.id === id);
  if (!p) throw new Error('找不到這個專案');
  return p;
}

function addProject({ root, name }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('資料夾路徑不正確');
  let st;
  try { st = fs.statSync(root); } catch { throw new Error('資料夾不存在'); }
  if (!st.isDirectory()) throw new Error('請選擇資料夾');
  const list = projects();
  const same = list.find((p) => path.resolve(p.root) === path.resolve(root));
  if (same) return { project: same, existed: true, projects: list };
  const p = {
    id: crypto.randomUUID(),
    name: String(name || '').trim().slice(0, 100) || path.basename(root) || root,
    root: path.resolve(root),
    createdAt: Date.now(),
  };
  const next = [...list, p];
  ctx.storage.set('projects', next);
  ctx.log.info(`建立專案「${p.name}」：${p.root}`);
  return { project: p, existed: false, projects: next };
}

function renameProject({ id, name }) {
  const n = String(name || '').trim().slice(0, 100);
  if (!n) throw new Error('專案名稱不能是空的');
  const next = projects().map((p) => (p.id === id ? { ...p, name: n } : p));
  ctx.storage.set('projects', next);
  return next;
}

function removeProject(id) {
  const gone = projects().find((p) => p.id === id);
  const next = projects().filter((p) => p.id !== id);
  if (gone) symbols.forget(gone.root, { purge: !next.some((p) => p.root === gone.root) });
  ctx.storage.set('projects', next);
  ctx.storage.delete(`state:${id}`);
  if (ctx.storage.get('lastProject') === id) ctx.storage.set('lastProject', next[0] ? next[0].id : null);
  return next;
}

/* ───────────── 從其他工具開啟專案（git-tool.project） ───────────── */

/** 接收 git-tool.project：建立或切換到同一個專案，有指定檔案時一併開啟 */
function importProject(pkg, info = {}) {
  let p;
  try {
    p = P.parsePayload(pkg && pkg.payload, { origin: info.origin });
  } catch (err) {
    // 平台不會顯示接收端的拒絕原因，自己告訴使用者（例如從交換檔選了程式碼編輯器）
    ctx.window.toast(err.message, 'warn').catch(() => {});
    return { status: 'rejected', message: err.message };
  }
  let proj = P.pickProject(projects(), p);
  let added = false;
  if (!proj) {
    const res = addProject({ root: p.root, name: p.name });
    proj = res.project;
    added = !res.existed;
  }
  ctx.storage.set('lastProject', proj.id);
  pendingCommand = { command: 'openProject', id: proj.id, file: p.file, line: p.line };
  ctx.ui.emit('command', { command: pendingCommand });
  const from = info.producer ? `（來自 ${info.producer.name}）` : '';
  ctx.log.info(`開啟專案「${proj.name}」${from}：${proj.root}${p.file ? `，檔案 ${p.file}` : ''}`);
  return {
    status: 'imported',
    message: `已在程式碼編輯器開啟「${proj.name}」${p.file ? `的 ${path.basename(p.file)}` : ''}`,
    data: { projectId: proj.id, root: proj.root, added },
  };
}

/* ───────────── 啟用 ───────────── */

exports.activate = (context) => {
  ctx = context;
  const h = (name, fn) => ctx.ui.handle(name, fn);
  symbols.configure({ dataDir: ctx.paths && ctx.paths.data, watch: true });

  h('info', () => {
    const last = ctx.storage.get('lastProject', null);
    return {
      settings: ctx.settings.all(),
      projects: projects(),
      lastProject: last,
      state: last ? ctx.storage.get(`state:${last}`, null) : null,
      recent: ctx.storage.get('recent', []),
      keybindings: ctx.storage.get('keybindings', {}),
      platform: ctx.platform.version,
      sep: path.sep,
    };
  });

  // 專案
  h('addProject', (opts) => addProject(opts));
  h('projects', () => projects());
  h('renameProject', (opts) => renameProject(opts));
  h('removeProject', (id) => removeProject(id));
  h('selectProject', (id) => {
    ctx.storage.set('lastProject', id);
    return id ? ctx.storage.get(`state:${id}`, null) : null;
  });
  h('saveState', ({ id, state }) => {
    if (id) ctx.storage.set(`state:${id}`, state);
    return true;
  });

  // 檔案樹
  h('listDir', ({ id, rel }) => files.listDir(project(id).root, rel || '', exclude()));
  h('listFiles', (id) => files.listFiles(project(id).root, exclude()));
  h('create', ({ id, dir, name, isDir }) => files.create(project(id).root, dir || '', name, isDir));
  h('rename', ({ id, rel, name }) => files.rename(project(id).root, rel, name));

  // 檔案
  h('read', (file) => {
    const doc = files.readText(file);
    return doc;
  });
  h('write', (doc) => files.writeText(doc));
  h('stat', (file) => {
    try { return { mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
  });
  h('rememberRecent', (file) => {
    const recent = [file, ...ctx.storage.get('recent', []).filter((f) => f !== file)].slice(0, 15);
    ctx.storage.set('recent', recent);
    return recent;
  });
  h('reveal', (file) => ctx.shell.showItemInFolder(file));

  // 自訂快捷鍵：{ 功能 id: [組合鍵…] }，只存和預設不同的
  h('setKeybindings', (map) => {
    const clean = {};
    if (map && typeof map === 'object') {
      for (const [id, list] of Object.entries(map)) {
        if (/^[\w.-]{1,64}$/.test(id) && Array.isArray(list)) clean[id] = list.filter((k) => typeof k === 'string' && k.length <= 64).slice(0, 8);
      }
    }
    ctx.storage.set('keybindings', clean);
    return clean;
  });

  // Git
  h('gitStatus', (id) => git.status(project(id).root, gitPath()));
  h('gitDiff', async ({ id, top, area, path: rel, orig }) => {
    const p = project(id);
    // top 必須是這個專案所在的儲存庫
    const real = await git.topLevel(p.root, gitPath());
    if (!real || path.resolve(top) !== real) throw new Error('儲存庫已變更，請重新整理');
    return git.diffSides(real, { area, path: rel, orig }, gitPath());
  });

  /** 專案所在的儲存庫；畫面傳來的 top 必須相同（避免切換專案後誤用舊的路徑） */
  const repoOf = async (id, top) => {
    const p = project(id);
    const real = await git.topLevel(p.root, gitPath());
    if (!real || path.resolve(String(top || '')) !== real) throw new Error('儲存庫已變更，請重新整理');
    return { p, top: real };
  };
  const done = (op, extra) => ({ ...extra, undoId: edits.commit(op) });

  // 跨檔案搜尋與取代
  h('search', ({ id, useIgnore, ...opts }) => search.search(project(id).root, opts, searchScope(useIgnore !== false)));
  h('cancelSearch', () => { search.cancel(); return true; });
  h('replaceInFiles', ({ id, label, items }) => {
    const op = edits.begin(label || '取代');
    const results = search.replaceInFiles(project(id).root, Array.isArray(items) ? items : [], op);
    const n = results.reduce((s, r) => s + r.count, 0);
    if (n) ctx.log.info(`跨檔案取代：${results.filter((r) => r.ok).length} 個檔案、${n} 處`);
    return done(op, { results });
  });
  h('undo', (undoId) => edits.undo(undoId));

  // 跳到定義（符號索引）
  h('definitions', ({ id, ...o }) => symbols.definitions(project(id).root, searchScope(true), o));

  // .class 反編譯：回傳和 read 相同形狀的文件（唯讀）
  h('decompile', async (file) => {
    const st = fs.statSync(file);
    const r = await decompiler.decompile(file, { javaPath: javaPath() });
    return {
      file, name: path.basename(file), size: st.size, mtime: st.mtimeMs,
      text: r.text, eol: '\n', bom: false, encoding: 'utf8', readOnly: true, decompiled: r.engine, note: r.note,
    };
  });

  // Git 還原與檔案歷史
  h('gitRestore', async ({ id, top, items }) => {
    const r = await repoOf(id, top);
    const op = edits.begin('還原 Git 變更');
    const results = await git.restore(r.top, r.p.root, Array.isArray(items) ? items : [], op, gitPath());
    return done(op, { results });
  });
  h('gitRevertHunk', async ({ id, top, path: rel, hunk }) => {
    const r = await repoOf(id, top);
    const op = edits.begin('還原一段變更');
    const res = await git.revertHunk(r.top, r.p.root, rel, hunk, op, gitPath());
    return done(op, res);
  });
  h('gitLog', async ({ id, top, path: rel }) => {
    const r = await repoOf(id, top);
    return git.fileLog(r.top, r.p.root, rel, gitPath());
  });
  h('gitVersion', async ({ id, top, ...o }) => {
    const r = await repoOf(id, top);
    return git.versionSides(r.top, r.p.root, o, gitPath());
  });
  h('gitRestoreVersion', async ({ id, top, ...o }) => {
    const r = await repoOf(id, top);
    const op = edits.begin('還原成歷史版本');
    const res = await git.restoreVersion(r.top, r.p.root, o, op, gitPath());
    return done(op, res);
  });

  h('takePending', () => {
    const c = pendingCommand;
    pendingCommand = null;
    return c;
  });

  const toView = async (command) => {
    pendingCommand = command;
    await ctx.window.openView('codeEditor.main');
    ctx.ui.emit('command', { command });
  };
  ctx.subscriptions.push(
    ctx.commands.register('codeEditor.open', () => ctx.window.openView('codeEditor.main')),
    ctx.commands.register('codeEditor.addProject', () => toView('addProject')),
    ctx.commands.register('codeEditor.openFile', () => toView('openFile')),
    ctx.commands.register('codeEditor.showChanges', () => toView('showChanges')),
    ctx.commands.register('codeEditor.search', () => toView('search')),
    ctx.commands.register('codeEditor.keybindings', () => toView('keybindings')),
    ctx.settings.onDidChange((key) => ctx.ui.emit('settingsChanged', { key, settings: ctx.settings.all() })),
  );
};

/** contributes.exchange.imports 的 handler：接收 git-tool.project */
exports.importProject = (context, pkg, info) => {
  if (!ctx) ctx = context;
  return importProject(pkg, info);
};

exports.deactivate = () => {
  pendingCommand = null;
  search.cancel();
  symbols.close();
};

// 測試用
exports._internal = { addProject, renameProject, removeProject, importProject, takePending: () => { const c = pendingCommand; pendingCommand = null; return c; }, setContext: (c) => { ctx = c; } };
