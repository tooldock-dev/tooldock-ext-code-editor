'use strict';
/* 程式碼編輯器畫面：專案、檔案樹、多分頁編輯（高亮）、跳到定義、class 反編譯、跨檔案搜尋與取代、Git 異動清單、差異比對、還原與檔案歷史 */
const td = window.tooldock;
const C = window.CodeCore;
const hljs = window.hljs;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = C.escapeHtml;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const LARGE_CHARS = 1500000; // 超過就不高亮
const LARGE_LINES = 30000;

const st = {
  info: null,
  projects: [],
  pid: null, // 目前專案 id
  tabs: [], // { id, kind, file, name, preview, view, ... }
  active: null,
  seq: 0,
  untitled: 0,
  tree: { kids: new Map(), expanded: new Set(), sel: '' },
  fileList: null, // 檔名搜尋用（專案內所有檔案）
  git: null,
  gitCollapsed: new Set(),
  gitPick: new Set(), // 「變更」清單中選取的項目（area:path），可一次還原
  gitAnchor: null, // ⇧ 點選範圍的起點
  gitMap: new Map(), // 專案相對路徑 → 狀態字母
  gitDirs: new Map(), // 有異動的資料夾 → 狀態字母
  side: 'files',
  diffMode: 'sbs',
  find: { open: false, caseSens: false, regex: false },
  targets: [], // 能接收 git-tool.project 的其他工具（Git 工具等）
};

const project = () => st.projects.find((p) => p.id === st.pid) || null;
const setting = (k, d) => { const v = st.info && st.info.settings[`codeEditor.${k}`]; return v === undefined ? d : v; };
const indentUnit = () => (setting('insertSpaces', true) ? ' '.repeat(Math.max(1, Math.min(8, Number(setting('tabSize', 4)) || 4))) : '\t');
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const dirname = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`ce.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`ce.${k}`, JSON.stringify(v)); } catch { /* 無法保存不影響使用 */ } },
};

/** 專案內的相對路徑（不在專案內時回傳 null） */
function relOf(file) {
  const p = project();
  if (!p || !file) return null;
  const sep = st.info.sep;
  const root = p.root.endsWith(sep) ? p.root : p.root + sep;
  if (!file.startsWith(root)) return null;
  return file.slice(root.length).split(sep).join('/');
}
const absOf = (rel) => { const p = project(); return p.root + st.info.sep + rel.split('/').join(st.info.sep); };

/* ───────────── 提示 ───────────── */

let noticeTimer = null;
function notice(msg, kind = '') {
  const el = $('#stNotice');
  el.textContent = msg;
  el.className = `notice ${kind}`;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}
const fail = (err) => notice(err && err.message ? err.message : String(err), 'err');

function banner(msg, actions = []) {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  $('.msg', b).textContent = msg;
  const acts = $('.acts', b);
  acts.innerHTML = '';
  for (const [label, fn, cls] of actions) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = `sm ${cls || 'secondary'}`;
    btn.onclick = () => { b.hidden = true; fn(); };
    acts.append(btn);
  }
  b.hidden = false;
}

/** 單行輸入對話框（Electron 不支援 window.prompt） */
function ask(title, value = '', { hint = '', select } = {}) {
  return new Promise((resolve) => {
    const m = $('#modal');
    const input = $('#modalInput');
    $('#modalTitle').textContent = title;
    $('#modalHint').textContent = hint;
    input.value = value;
    m.hidden = false;
    input.focus();
    if (select) input.setSelectionRange(select[0], select[1]); else input.select();
    const done = (v) => {
      m.hidden = true;
      $('#modalBox').onsubmit = null;
      $('#modalCancel').onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    $('#modalBox').onsubmit = (e) => { e.preventDefault(); done(input.value); };
    $('#modalCancel').onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  notice('已複製');
}

/* ───────────── 選單 ───────────── */

function closeMenus() { for (const m of $$('.menu')) m.hidden = true; }

/** 右鍵選單：items 為 [label, fn] 或 '-'（分隔線） */
function contextMenu(e, items) {
  e.preventDefault();
  closeMenus();
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
    const b = document.createElement('button');
    b.className = 'item';
    b.textContent = it[0];
    b.onclick = () => { m.hidden = true; Promise.resolve(it[1]()).catch(fail); };
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
}

/* ───────────── 高亮 ───────────── */

const LANG_DEPS = { xml: ['css', 'javascript'], php: ['xml', 'css', 'javascript'], markdown: ['xml'] };
const langLoads = new Map();

/** 依需要載入 highlight.js 的語言模組（ES module，各自獨立） */
function ensureLang(id) {
  if (!id || id === 'plaintext') return Promise.resolve(true);
  if (hljs.getLanguage(id)) return Promise.resolve(true);
  if (!langLoads.has(id)) {
    langLoads.set(id, (async () => {
      try {
        const m = await import(`../node_modules/highlight.js/es/languages/${id}.js`);
        hljs.registerLanguage(id, m.default);
        await Promise.all((LANG_DEPS[id] || []).map(ensureLang));
        return true;
      } catch (err) {
        console.warn('載入語言失敗', id, err);
        return false;
      }
    })());
  }
  return langLoads.get(id);
}

function highlightCode(text, lang) {
  if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
    try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { /* 改用純文字 */ }
  }
  return esc(text);
}

const lineHtml = (l) => (l.replace(/<[^>]*>/g, '') ? l : `${l}<br>`);

/* ───────────── 編輯器 ───────────── */

let measureCtx = null;
function textWidth(s, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

class CodeView {
  constructor(tab) {
    this.tab = tab;
    this.el = document.createElement('div');
    this.el.className = 'view code';
    this.el.innerHTML = '<div class="box"><pre aria-hidden="true"></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>';
    this.pre = $('pre', this.el);
    this.ta = $('textarea', this.el);
    this.curLine = -1;
    this.hitLine = -1;
    this.raf = 0;
    this.lineCount = 0;
    this.ta.addEventListener('input', () => this.onInput());
    this.ta.addEventListener('keydown', (e) => onEditorKey(e, this));
    this.ta.addEventListener('select', () => this.onCaret());
    this.ta.addEventListener('click', () => this.onCaret());
    this.ta.addEventListener('keyup', (e) => { if (!e.metaKey && !e.ctrlKey) this.onCaret(true); });
    this.ta.addEventListener('focus', () => this.onCaret());
    // textarea 與 <pre> 一樣大，由外層捲動；它自己若捲動會和高亮錯位
    this.ta.addEventListener('scroll', () => { if (!this.large && (this.ta.scrollTop || this.ta.scrollLeft)) { this.ta.scrollTop = 0; this.ta.scrollLeft = 0; } });
    $('#stage').append(this.el);
    this.applySettings();
  }

  get text() { return this.ta.value; }

  setText(text) {
    this.ta.value = text;
    this.large = text.length > LARGE_CHARS || (text.match(/\n/g) || []).length > LARGE_LINES;
    this.el.classList.toggle('plain', this.large);
    this.ta.setSelectionRange(0, 0);
    this.el.scrollTop = 0;
    this.el.scrollLeft = 0;
    this.render(true);
  }

  setLang(lang) {
    this.tab.lang = lang;
    ensureLang(lang).then(() => this.render(true));
  }

  setReadOnly(ro) {
    this.ta.readOnly = !!ro;
    this.el.classList.toggle('readonly', !!ro);
  }

  applySettings() {
    const wrap = !!setting('wordWrap', false);
    this.el.classList.toggle('wrap', wrap);
    this.ta.setAttribute('wrap', wrap ? 'soft' : 'off');
    this.render(true);
  }

  onInput() {
    if (this.tab.preview) pinTab(this.tab);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
    updateTab(this.tab);
    scheduleFindCount();
  }

  render(force) {
    if (this.large) { this.pre.innerHTML = ''; this.updateStatus(); return; }
    const text = this.ta.value;
    if (!force && text === this.renderedText) return;
    this.renderedText = text;
    const lines = C.splitHtmlLines(highlightCode(text, this.tab.lang));
    this.lineCount = lines.length;
    this.el.style.setProperty('--gut', `calc(${String(lines.length).length}ch + 30px)`);
    this.pre.innerHTML = lines.map((l) => `<div class="l">${lineHtml(l)}</div>`).join('');
    this.curLine = -1;
    this.hitLine = -1;
    this.onCaret();
  }

  caretLine() {
    const t = this.ta.value;
    const pos = this.ta.selectionEnd;
    let n = 0;
    for (let i = t.indexOf('\n'); i >= 0 && i < pos; i = t.indexOf('\n', i + 1)) n++;
    return n;
  }

  onCaret(reveal) {
    if (this.tab !== activeTab()) return;
    const line = this.caretLine();
    if (!this.large && line !== this.curLine) {
      const rows = this.pre.children;
      if (rows[this.curLine]) rows[this.curLine].classList.remove('cur');
      if (rows[line]) rows[line].classList.add('cur');
      this.curLine = line;
    }
    if (reveal) this.reveal();
    this.updateStatus();
  }

  markHit(line) {
    const rows = this.pre.children;
    if (rows[this.hitLine]) rows[this.hitLine].classList.remove('hit');
    this.hitLine = line;
    if (line >= 0 && rows[line]) rows[line].classList.add('hit');
  }

  /** 讓游標所在位置出現在畫面中（外層容器捲動，textarea 本身不捲動） */
  reveal(center) {
    if (this.large) return;
    const sc = this.el;
    const row = this.pre.children[this.caretLine()];
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const pad = 30;
    if (center) sc.scrollTop = Math.max(0, top - sc.clientHeight / 3);
    else if (top < sc.scrollTop + pad) sc.scrollTop = Math.max(0, top - pad);
    else if (bottom > sc.scrollTop + sc.clientHeight - pad) sc.scrollTop = bottom - sc.clientHeight + pad;
    if (this.el.classList.contains('wrap')) return;
    const t = this.ta.value;
    const pos = this.ta.selectionEnd;
    const ls = t.lastIndexOf('\n', pos - 1) + 1;
    const tab = ' '.repeat(Number(setting('tabSize', 4)) || 4);
    const cs = getComputedStyle(this.ta);
    const gut = parseFloat(cs.paddingLeft);
    const x = gut + textWidth(t.slice(ls, pos).replace(/\t/g, tab), `${cs.fontSize} ${cs.fontFamily}`);
    if (x < sc.scrollLeft + gut + 20) sc.scrollLeft = Math.max(0, x - gut - 60);
    else if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth + 80;
  }

  updateStatus() {
    if (this.tab !== activeTab()) return;
    const { line, col } = C.cursorInfo(this.ta.value, this.ta.selectionStart);
    const sel = Math.abs(this.ta.selectionEnd - this.ta.selectionStart);
    $('#stPos').textContent = `第 ${line} 行，第 ${col} 欄${sel ? `（已選取 ${sel}）` : ''}`;
  }

  focus() { this.ta.focus({ preventScroll: true }); }

  saveViewState() { return { top: this.el.scrollTop, left: this.el.scrollLeft, s: this.ta.selectionStart, e: this.ta.selectionEnd }; }

  restoreViewState(v) {
    if (!v) return;
    this.ta.setSelectionRange(v.s || 0, v.e || 0);
    this.el.scrollTop = v.top || 0;
    this.el.scrollLeft = v.left || 0;
  }

  gotoLine(line, col = 1) {
    const pos = Math.min(this.ta.value.length, C.lineStart(this.ta.value, line) + col - 1);
    this.focus();
    this.ta.setSelectionRange(pos, pos);
    this.onCaret();
    this.reveal(true);
  }

  destroy() { cancelAnimationFrame(this.raf); this.el.remove(); }
}

/** 套用 code-core 的編輯：用 execCommand('insertText') 讓 ⌘Z 可以復原 */
function applyEdit(view, e) {
  if (!e) return false;
  const ta = view.ta;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(e.from, e.to);
  let ok;
  if (e.insert === '') ok = e.from === e.to || document.execCommand('delete');
  else ok = document.execCommand('insertText', false, e.insert);
  if (!ok) {
    ta.setRangeText(e.insert, e.from, e.to, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  ta.setSelectionRange(e.selStart, e.selEnd);
  view.onCaret(true);
  return true;
}

function onEditorKey(e, view) {
  if (e.isComposing || e.keyCode === 229) return;
  const ta = view.ta;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (ta.readOnly && !mod) return;
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    applyEdit(view, C.indent(ta.value, ta.selectionStart, ta.selectionEnd, indentUnit(), e.shiftKey));
  } else if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    applyEdit(view, C.newline(ta.value, ta.selectionStart, ta.selectionEnd, indentUnit()));
  } else if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    requestAnimationFrame(() => view.onCaret(true));
  }
}

/* ───────────── 分頁 ───────────── */

const activeTab = () => st.tabs.find((t) => t.id === st.active) || null;
const isDirty = (t) => t.kind === 'file' && !t.unavailable && t.view.text !== t.savedText;

function tabIcon(t) {
  if (t.kind === 'diff') return '±';
  if (t.kind === 'history') return '🕘';
  return '';
}

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = st.tabs.map((t) => `
    <div class="tab${t.id === st.active ? ' on' : ''}${t.preview ? ' preview' : ''}${isDirty(t) ? ' dirty' : ''}" data-id="${t.id}" title="${esc(t.title || t.name)}">
      ${tabIcon(t) ? `<span class="ti">${tabIcon(t)}</span>` : ''}<span class="tn">${esc(t.name)}</span>
      <button class="x" title="關閉"><span>✕</span></button>
    </div>`).join('');
  const on = $('.tab.on', box);
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#welcome').hidden = st.tabs.length > 0;
}

/** 只更新單一分頁的髒標記，不重繪整列（打字時呼叫） */
function updateTab(t) {
  const el = $(`.tab[data-id="${t.id}"]`);
  if (!el) return;
  el.classList.toggle('dirty', isDirty(t));
  el.classList.toggle('preview', !!t.preview);
}

function pinTab(t) {
  t.preview = false;
  updateTab(t);
  saveStateSoon();
}

function activate(id) {
  st.active = id;
  for (const t of st.tabs) t.view.el.hidden = t.id !== id;
  const t = activeTab();
  renderTabs();
  updateStatusBar();
  if (t) {
    if (t.kind === 'file' && !t.unavailable) {
      t.view.render(true);
      t.view.focus();
      checkExternal(t);
    }
    const rel = t.file ? relOf(t.file) : null;
    if (rel !== null) { st.tree.sel = rel; markTreeSel(); }
  }
  if (st.find.open) refreshFind();
  if (st.side === 'git') renderGit();
  saveStateSoon();
}

function addTab(t) {
  t.id = ++st.seq;
  const cur = st.tabs.findIndex((x) => x.id === st.active);
  st.tabs.splice(cur < 0 ? st.tabs.length : cur + 1, 0, t);
  return t;
}

/** 讀取要放進分頁的內容：.class 反編譯，其他檔案照原樣讀取 */
const readDoc = (file) => td.invoke(/\.class$/i.test(file) ? 'decompile' : 'read', file);

/** 開啟檔案；preview 時取代目前的預覽分頁（沒有修改過的才會被取代） */
async function openFile(file, { preview = false, line, col } = {}) {
  let t = st.tabs.find((x) => x.kind === 'file' && x.file === file);
  if (t) {
    if (!preview && t.preview) pinTab(t);
    activate(t.id);
    if (line) t.view.gotoLine(line, col);
    return t;
  }
  const doc = await readDoc(file);
  t = { kind: 'file', file, name: doc.name, title: file, preview };
  const old = preview ? st.tabs.find((x) => x.preview && !isDirty(x)) : null;
  addTab(t);
  t.view = new CodeView(t);
  t.view.el.hidden = true;
  fillDoc(t, doc);
  if (old) closeTab(old.id, true);
  activate(t.id);
  if (line) t.view.gotoLine(line, col);
  if (relOf(file) === null) td.invoke('rememberRecent', file).then((r) => { st.info.recent = r; renderRecent(); }).catch(() => {});
  return t;
}

function fillDoc(t, doc) {
  t.mtime = doc.mtime;
  t.unavailable = doc.binary ? '二進位檔案' : doc.tooLarge ? '檔案超過 50 MB' : '';
  if (t.unavailable) {
    t.savedText = '';
    t.view.setText('');
    t.view.setReadOnly(true);
    t.view.el.classList.add('msg-view');
    t.view.el.innerHTML = `<div>${esc(t.unavailable)}，無法顯示</div><button class="secondary sm">用預設應用程式開啟</button>`;
    $('button', t.view.el).onclick = () => td.shell.openPath(t.file);
    return;
  }
  t.eol = doc.eol;
  t.bom = doc.bom;
  t.encoding = doc.encoding;
  t.readOnly = doc.readOnly;
  t.savedText = doc.text;
  t.decompiled = doc.decompiled || '';
  if (!t.langManual) t.lang = t.decompiled ? 'java' : C.langFor(t.name);
  t.view.tab.lang = t.lang;
  t.view.setReadOnly(t.readOnly);
  t.view.setText(doc.text);
  if (t.decompiled) notice(`${t.name}：${doc.note}`);
  else if (t.readOnly) notice(`${t.name} 以 ${t.encoding.toUpperCase()} 開啟，為唯讀`);
  ensureLang(t.lang).then(() => t.view.render(true));
}

function newUntitled(text = '', lang = 'plaintext') {
  const t = addTab({ kind: 'file', file: null, name: `未命名-${++st.untitled}`, eol: '\n', bom: false, encoding: 'utf8', savedText: '', lang });
  t.view = new CodeView(t);
  t.view.el.hidden = true;
  t.view.setText(text);
  activate(t.id);
  return t;
}

async function closeTab(id, silent) {
  const t = st.tabs.find((x) => x.id === id);
  if (!t) return false;
  if (!silent && isDirty(t)) {
    activate(id);
    const r = await td.dialog.message({
      type: 'warning', message: `要儲存對「${t.name}」的變更嗎？`, detail: '不儲存的話，變更會遺失。',
      buttons: ['儲存', '不儲存', '取消'], defaultId: 0, cancelId: 2,
    });
    if (r.response === 2) return false;
    if (r.response === 0 && !(await save(t))) return false;
  }
  const i = st.tabs.indexOf(t);
  st.tabs.splice(i, 1);
  t.view.destroy();
  if (st.active === id) {
    const next = st.tabs[i] || st.tabs[i - 1];
    st.active = null;
    if (next) activate(next.id); else { renderTabs(); updateStatusBar(); }
  } else renderTabs();
  saveStateSoon();
  return true;
}

async function closeAll(except) {
  for (const t of [...st.tabs]) if (t.id !== except) if (!(await closeTab(t.id))) return false;
  return true;
}

/* ───────────── 存檔 ───────────── */

async function save(t = activeTab(), as = false) {
  if (!t || t.kind !== 'file' || t.unavailable) return false;
  if (t.decompiled && !as) { notice('反編譯的內容為唯讀，可以「另存新檔」存成 .java'); return false; }
  if (t.readOnly && !t.decompiled) { notice(`${t.encoding.toUpperCase()} 編碼的檔案為唯讀，請另存新檔（會存成 UTF-8）`); if (!as) return false; }
  let file = t.file;
  if (!file || as) {
    const p = project();
    const r = await td.dialog.save({ title: '另存新檔', defaultPath: t.decompiled ? t.file.replace(/\.class$/i, '.java') : t.file || (p ? `${p.root}${st.info.sep}${t.name}` : t.name) });
    if (r.canceled || !r.filePath) return false;
    file = r.filePath;
  }
  const text = t.view.text;
  try {
    const r = await td.invoke('write', { file, text, eol: t.eol, bom: t.bom });
    const renamed = file !== t.file;
    Object.assign(t, { file, name: r.name, title: file, mtime: r.mtime, savedText: text, preview: false, readOnly: false, encoding: 'utf8', decompiled: '' });
    t.view.setReadOnly(false);
    if (renamed) {
      if (!t.langManual) t.view.setLang(C.langFor(r.name));
      const rel = relOf(file);
      if (rel !== null) { st.fileList = null; await refreshDir(dirname(rel)); }
    }
    renderTabs();
    updateStatusBar();
    notice(`已儲存 ${r.name}`);
    refreshGitSoon(300);
    for (const d of st.tabs) if ((d.kind === 'diff' || d.kind === 'history') && d.entry.file === file) d.view.onFileChanged();
    saveStateSoon();
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** 檔案在外部被修改：沒有修改過就直接重新載入，否則詢問 */
async function checkExternal(t) {
  if (!t || t.kind !== 'file' || !t.file || t.checking) return;
  t.checking = true;
  try {
    const s = await td.invoke('stat', t.file);
    if (!s) { if (t.id === st.active) notice(`${t.name} 已不存在（存檔會重新建立）`); return; }
    if (!t.mtime || s.mtime === t.mtime) return;
    if (!isDirty(t)) {
      const vs = t.view.saveViewState();
      fillDoc(t, await readDoc(t.file));
      t.view.restoreViewState(vs);
      notice(`${t.name} 已在外部修改，已重新載入`);
      return;
    }
    if (t.id !== st.active) return;
    banner(`「${t.name}」已在外部修改，但這裡也有尚未儲存的變更。`, [
      ['重新載入（放棄這裡的變更）', async () => { fillDoc(t, await readDoc(t.file)); renderTabs(); }],
      ['保留這裡的版本', () => { t.mtime = s.mtime; }],
    ]);
  } catch { /* 忽略 */ } finally {
    t.checking = false;
  }
}

/* ───────────── 狀態列 ───────────── */

function updateStatusBar() {
  const t = activeTab();
  const isFile = t && t.kind === 'file' && !t.unavailable;
  $('#stPath').textContent = t ? (t.file ? (relOf(t.file) ?? t.file) : t.name) : '';
  $('#stPath').title = t && t.file ? t.file : '';
  for (const id of ['#stWrap', '#stIndent', '#stEol', '#stLang']) $(id).hidden = !isFile;
  $('#stEnc').textContent = !isFile ? '' : t.decompiled ? (t.decompiled === 'cfr' ? '反編譯（唯讀）' : '類別結構（唯讀）')
    : t.encoding === 'utf8' ? (t.bom ? 'UTF-8 BOM' : 'UTF-8') : `${t.encoding.toUpperCase()}（唯讀）`;
  if (!isFile) { $('#stPos').textContent = ''; return; }
  $('#stWrap').classList.toggle('on', !!setting('wordWrap', false));
  $('#stIndent').textContent = setting('insertSpaces', true) ? `空格：${setting('tabSize', 4)}` : `Tab：${setting('tabSize', 4)}`;
  $('#stEol').textContent = t.eol === '\r\n' ? 'CRLF' : 'LF';
  $('#stLang').value = t.lang;
  t.view.updateStatus();
}

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--fs', `${Math.max(9, Math.min(32, Number(setting('fontSize', 13)) || 13))}px`);
  root.setProperty('--tab', String(Math.max(1, Math.min(8, Number(setting('tabSize', 4)) || 4))));
  for (const t of st.tabs) if (t.kind === 'file' && !t.unavailable) t.view.applySettings();
  updateStatusBar();
}

/* ───────────── 專案 ───────────── */

function renderProjects() {
  const sel = $('#projSel');
  sel.innerHTML = st.projects.length
    ? st.projects.map((p) => `<option value="${esc(p.id)}" title="${esc(p.root)}">${esc(p.name)}</option>`).join('')
    : '<option value="">（尚未建立專案）</option>';
  sel.value = st.pid || '';
  sel.title = project() ? project().root : '';
}

async function addProject() {
  const r = await td.dialog.open({ title: '選擇專案資料夾', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return;
  const root = r.filePaths[0];
  const name = await ask('專案名稱', basename(root));
  if (name === null) return;
  const res = await td.invoke('addProject', { root, name });
  st.projects = res.projects;
  if (res.existed) notice(`這個資料夾已經是專案「${res.project.name}」`);
  await switchProject(res.project.id);
}

async function switchProject(id, state) {
  if (id === st.pid && !state) return;
  if (st.tabs.some(isDirty)) {
    const r = await td.dialog.message({
      type: 'warning', message: '切換專案會關閉目前的分頁，要先儲存變更嗎？',
      buttons: ['全部儲存', '不儲存', '取消'], defaultId: 0, cancelId: 2,
    });
    if (r.response === 2) { renderProjects(); return; }
    if (r.response === 0) for (const t of st.tabs.filter(isDirty)) if (!(await save(t))) { renderProjects(); return; }
  }
  await saveState();
  for (const t of [...st.tabs]) await closeTab(t.id, true);
  st.pid = id || null;
  st.tree = { kids: new Map(), expanded: new Set(), sel: '' };
  st.fileList = null;
  st.git = null;
  st.gitMap.clear();
  st.gitDirs.clear();
  $('#filter').value = '';
  srch.query = null;
  srch.result = null;
  srch.undo = null;
  srch.seq++;
  renderSearch();
  renderProjects();
  const s = state !== undefined ? state : await td.invoke('selectProject', st.pid);
  if (!st.pid) { renderTree(); renderGit(); return; }
  if (s && Array.isArray(s.expanded)) for (const r of s.expanded) st.tree.expanded.add(r);
  if (s && s.side) setSide(s.side);
  await loadTree();
  refreshGit();
  // 還原上次開著的檔案
  if (s && Array.isArray(s.tabs)) {
    for (const rel of s.tabs) {
      try { await openFile(absOf(rel)); } catch { /* 檔案已不存在 */ }
    }
    const a = s.active && st.tabs.find((t) => t.file === absOf(s.active));
    if (a) activate(a.id);
  }
}

/* ───────────── 和其他工具共享專案（git-tool.project） ───────────── */

/** 重新查詢能接收專案的工具（Git 工具等），更新選單與 Git 面板的按鈕 */
async function refreshTargets() {
  try {
    st.targets = td.exchange ? await td.exchange.receivers('git-tool.project') : [];
  } catch { st.targets = []; }
  const item = $('#openInItem');
  item.hidden = !st.targets.length || !project();
  item.textContent = targetLabel();
  renderGit();
}
const targetLabel = () => (st.targets.length === 1 ? st.targets[0].title || `在${st.targets[0].name}開啟` : '在其他工具開啟…');
const targetName = () => (st.targets.length === 1 ? st.targets[0].name : '其他工具');

/** 把目前的專案交給 Git 工具；file 為絕對路徑時一併帶上 */
async function openInFlow({ file, line } = {}) {
  const p = project();
  if (!p || !td.exchange) return;
  const payload = { name: p.name, path: p.root };
  const rel = file ? relOf(file) : null;
  if (rel) { payload.file = rel; if (line) payload.line = line; }
  const pkg = await td.exchange.create('git-tool.project', payload, { title: p.name, description: p.root });
  const r = await td.exchange.share(pkg, { fallback: 'none' });
  if (r.status === 'no-receiver') { notice('沒有可以接收專案的工具，可以到擴充商店安裝「Git 工具」', 'err'); refreshTargets(); return; }
  if (r.status === 'error') throw new Error(r.message || '無法交給其他工具');
  if (r.status === 'delivered' && r.result && r.result.status === 'rejected') throw new Error(r.result.message || '對方無法開啟這個專案');
}

/** 其他工具（Git 工具）送來的專案：切換過去，有指定檔案時開啟並跳到該行 */
async function openProjectCommand(c) {
  st.projects = await td.invoke('projects');
  if (st.pid !== c.id) await switchProject(c.id);
  else renderProjects();
  if (st.pid !== c.id) return; // 使用者取消了切換（有未儲存的分頁）
  if (c.file) await openFile(c.file, { line: c.line || undefined });
}

async function renameProject() {
  const p = project();
  if (!p) return;
  const name = await ask('專案名稱', p.name);
  if (name === null) return;
  st.projects = await td.invoke('renameProject', { id: p.id, name });
  renderProjects();
}

async function removeProject() {
  const p = project();
  if (!p) return;
  const r = await td.dialog.message({
    type: 'question', message: `從清單移除專案「${p.name}」？`, detail: `只會從清單移除，不會刪除資料夾：\n${p.root}`,
    buttons: ['移除', '取消'], defaultId: 1, cancelId: 1,
  });
  if (r.response !== 0) return;
  st.projects = await td.invoke('removeProject', p.id);
  await switchProject(st.projects[0] ? st.projects[0].id : null, st.projects[0] ? undefined : null);
}

let stateTimer = null;
function saveStateSoon() { clearTimeout(stateTimer); stateTimer = setTimeout(saveState, 500); }
async function saveState() {
  clearTimeout(stateTimer);
  if (!st.pid) return;
  const a = activeTab();
  const state = {
    expanded: [...st.tree.expanded],
    tabs: st.tabs.filter((t) => t.kind === 'file' && t.file && relOf(t.file) !== null && !t.preview).map((t) => relOf(t.file)),
    active: a && a.file ? relOf(a.file) : null,
    side: st.side,
  };
  try { await td.invoke('saveState', { id: st.pid, state }); } catch { /* 忽略 */ }
}

function renderRecent() {
  const box = $('#recentBox');
  const recent = (st.info && st.info.recent) || [];
  box.innerHTML = recent.length
    ? `<div class="sep"></div><div class="label">最近開啟的檔案（專案外）</div>${recent.slice(0, 8).map((f) => `<button class="item" data-recent="${esc(f)}" title="${esc(f)}">${esc(basename(f))}</button>`).join('')}`
    : '';
}

async function openFileDialog() {
  const p = project();
  const r = await td.dialog.open({ title: '開啟檔案', properties: ['openFile', 'multiSelections'], defaultPath: p ? p.root : undefined });
  if (r.canceled) return;
  for (const f of r.filePaths) await openFile(f);
}

/* ───────────── 檔案樹 ───────────── */

const ICONS = {
  js: '🟨', mjs: '🟨', cjs: '🟨', jsx: '⚛️', ts: '🟦', tsx: '⚛️', json: '🧾', md: '📝', html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', less: '🎨',
  py: '🐍', java: '☕', class: '☕', jar: '☕', cs: '#️⃣', go: '🐹', rs: '🦀', rb: '💎', php: '🐘', sql: '🗃', sh: '🐚', bat: '🐚', ps1: '🐚', xml: '📰', yml: '⚙️', yaml: '⚙️',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼', ico: '🖼', pdf: '📕', zip: '📦', lock: '🔒', txt: '📄', log: '📜', env: '🔑',
};
const iconFor = (name) => ICONS[(name.split('.').pop() || '').toLowerCase()] || '📄';

async function loadDir(rel) {
  const list = await td.invoke('listDir', { id: st.pid, rel });
  st.tree.kids.set(rel, list);
  return list;
}

async function loadTree() {
  const tree = $('#tree');
  if (!st.pid) { renderTree(); return; }
  try {
    await loadDir('');
    // 已展開的資料夾一併載入；不存在的移除
    const dirs = [...st.tree.expanded].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const d of dirs) {
      const parent = st.tree.kids.get(dirname(d));
      if (!parent || !parent.some((e) => e.dir && e.rel === d)) { st.tree.expanded.delete(d); continue; }
      try { await loadDir(d); } catch { st.tree.expanded.delete(d); }
    }
    renderTree();
  } catch (err) {
    tree.innerHTML = `<div class="empty-msg">無法讀取專案資料夾：${esc(err.message)}<br><button class="secondary sm" data-act="removeProject">從清單移除專案</button></div>`;
  }
}

async function refreshDir(rel) {
  if (!st.tree.kids.has(rel) && rel) return;
  try { await loadDir(rel); } catch { /* 忽略 */ }
  renderTree();
}

function renderTree() {
  const tree = $('#tree');
  if ($('#filter').value.trim()) { renderFilter(); return; }
  if (!st.pid) {
    tree.innerHTML = '<div class="empty-msg">還沒有專案。建立專案後，這裡會顯示資料夾內容。<br><button class="sm" data-act="addProject">＋ 建立專案…</button></div>';
    return;
  }
  const rows = [];
  const walk = (rel, depth) => {
    for (const e of st.tree.kids.get(rel) || []) {
      const open = e.dir && st.tree.expanded.has(e.rel);
      const g = e.dir ? st.gitDirs.get(e.rel) : st.gitMap.get(e.rel);
      const deco = !g ? '' : e.dir ? `<span class="dot g-${esc(g)}"></span>` : `<span class="gs g-${esc(g)}">${g === '?' ? 'U' : esc(g)}</span>`;
      rows.push(`<div class="row${e.rel === st.tree.sel ? ' sel' : ''}${e.link ? ' link' : ''}" data-rel="${esc(e.rel)}" data-dir="${e.dir ? 1 : ''}" style="padding-left:${depth * 12 + 6}px">`
        + `<span class="tw">${e.dir ? (open ? '▾' : '▸') : ''}</span><span class="ic">${e.dir ? (open ? '📂' : '📁') : iconFor(e.name)}</span>`
        + `<span class="nm${g && !e.dir ? ` g-${esc(g)}` : ''}">${esc(e.name)}</span>${deco}</div>`);
      if (open) walk(e.rel, depth + 1);
    }
  };
  walk('', 0);
  tree.innerHTML = rows.join('') || '<div class="empty-msg">資料夾是空的</div>';
}

function markTreeSel() {
  for (const r of $$('#tree .row.sel')) r.classList.remove('sel');
  const row = $(`#tree .row[data-rel="${CSS.escape(st.tree.sel)}"]`);
  if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
}

async function toggleDir(rel, open = !st.tree.expanded.has(rel)) {
  if (open) {
    st.tree.expanded.add(rel);
    if (!st.tree.kids.has(rel)) await loadDir(rel);
  } else st.tree.expanded.delete(rel);
  renderTree();
  saveStateSoon();
}

/** 展開到某個檔案並選取 */
async function revealInTree(rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    st.tree.expanded.add(d);
    if (!st.tree.kids.has(d)) { try { await loadDir(d); } catch { break; } }
  }
  st.tree.sel = rel;
  setSide('files');
  $('#filter').value = '';
  renderTree();
  markTreeSel();
}

async function onTreeClick(e, dbl) {
  const row = e.target.closest('.row');
  if (!row) return;
  const rel = row.dataset.rel;
  st.tree.sel = rel;
  if (row.dataset.dir) { if (!dbl) await toggleDir(rel); else markTreeSel(); return; }
  markTreeSel();
  await openFile(absOf(rel), { preview: !dbl });
}

function onTreeContext(e) {
  if (!st.pid) return;
  const row = e.target.closest('.row');
  const rel = row ? row.dataset.rel : '';
  const isDir = row ? !!row.dataset.dir : true;
  const dir = isDir ? rel : dirname(rel);
  if (row) { st.tree.sel = rel; markTreeSel(); }
  const items = [];
  if (row && !isDir) items.push(['開啟', () => openFile(absOf(rel))]);
  if (row && !isDir && st.gitMap.has(rel)) items.push(['查看 Git 差異', () => openDiffForRel(rel)]);
  if (row && !isDir && st.git && st.git.repo && !isUntracked(rel)) items.push(['檔案歷史', () => openHistory(absOf(rel))]);
  const rv = row && !isDir ? restorableEntry(rel) : null;
  if (rv) items.push([rv.area === 'untracked' ? '刪除未追蹤的檔案…' : '還原 Git 變更…', () => restoreEntries([rv])]);
  if (items.length) items.push('-');
  items.push(['新增檔案…', () => createIn(dir, false)], ['新增資料夾…', () => createIn(dir, true)]);
  if (row) items.push(['重新命名…', () => renameEntry(rel)]);
  items.push('-', [isDir && rel ? '在這個資料夾中搜尋…' : '在專案中搜尋…', () => openSearch(false, isDir && rel ? `${rel}/` : undefined)]);
  items.push('-');
  const abs = row ? absOf(rel) : project().root;
  items.push(['複製路徑', () => copyText(abs)]);
  if (row) items.push(['複製相對路徑', () => copyText(rel)]);
  items.push([IS_MAC ? '在 Finder 中顯示' : '在檔案總管中顯示', () => td.invoke('reveal', abs)]);
  items.push('-', ['重新整理', () => refreshAll()]);
  contextMenu(e, items);
}

async function createIn(dir, isDir) {
  const name = await ask(isDir ? `新增資料夾（位於 ${dir || '專案根目錄'}）` : `新增檔案（位於 ${dir || '專案根目錄'}）`, '');
  if (!name) return;
  try {
    const r = await td.invoke('create', { id: st.pid, dir, name, isDir });
    if (dir) st.tree.expanded.add(dir);
    st.fileList = null;
    await refreshDir(dir);
    await revealInTree(r.rel);
    if (!isDir) await openFile(r.file);
    refreshGitSoon(300);
  } catch (err) { fail(err); }
}

async function renameEntry(rel) {
  const old = basename(rel);
  const dot = old.lastIndexOf('.');
  const name = await ask('重新命名', old, { select: [0, dot > 0 ? dot : old.length] });
  if (!name || name === old) return;
  try {
    const r = await td.invoke('rename', { id: st.pid, rel, name });
    // 已開啟的分頁跟著改路徑
    const sep = st.info.sep;
    for (const t of st.tabs) {
      if (t.kind !== 'file' || !t.file) continue;
      if (t.file === r.from || t.file.startsWith(r.from + sep)) {
        t.file = r.file + t.file.slice(r.from.length);
        t.name = basename(t.file);
        t.title = t.file;
        if (!t.langManual) t.view.setLang(C.langFor(t.name));
      }
    }
    const fix = (s) => (s === rel || s.startsWith(`${rel}/`) ? r.rel + s.slice(rel.length) : s);
    st.tree.expanded = new Set([...st.tree.expanded].map(fix));
    st.fileList = null;
    await loadTree();
    await revealInTree(r.rel);
    renderTabs();
    updateStatusBar();
    refreshGitSoon(300);
  } catch (err) { fail(err); }
}

async function refreshAll() {
  st.fileList = null;
  await loadTree();
  await refreshGit();
  for (const t of st.tabs) checkExternal(t);
}

/* ───────────── 檔名搜尋 ───────────── */

let filterSel = 0;
async function renderFilter() {
  const q = $('#filter').value.trim().toLowerCase();
  const tree = $('#tree');
  if (!q) { renderTree(); return; }
  if (!st.pid) return;
  if (!st.fileList) {
    tree.innerHTML = '<div class="empty-msg">讀取檔案清單…</div>';
    try { st.fileList = await td.invoke('listFiles', st.pid); } catch (err) { tree.innerHTML = `<div class="empty-msg">${esc(err.message)}</div>`; return; }
    if ($('#filter').value.trim().toLowerCase() !== q) return;
  }
  const hits = [];
  for (const rel of st.fileList.files) {
    const s = matchScore(rel, q);
    if (s !== null) hits.push({ rel, s });
  }
  hits.sort((a, b) => a.s - b.s || a.rel.length - b.rel.length);
  const shown = hits.slice(0, 300);
  filterSel = Math.min(filterSel, Math.max(0, shown.length - 1));
  tree.innerHTML = shown.map((h, i) => {
    const name = basename(h.rel);
    const g = st.gitMap.get(h.rel);
    return `<div class="row hit-name${i === filterSel ? ' sel' : ''}" data-rel="${esc(h.rel)}" style="padding-left:8px">`
      + `<span class="ic">${iconFor(name)}</span><span class="nm${g ? ` g-${esc(g)}` : ''}">${markMatch(name, q)}</span><span class="dir">${esc(dirname(h.rel))}</span></div>`;
  }).join('') || '<div class="empty-msg">找不到符合的檔案</div>';
  if (hits.length > shown.length || st.fileList.truncated) {
    tree.insertAdjacentHTML('beforeend', `<div class="empty-msg">${st.fileList.truncated ? '專案檔案太多，只搜尋了前 30,000 個。' : ''}共 ${hits.length.toLocaleString()} 筆，只顯示前 300 筆</div>`);
  }
}

/** 分數越小越符合；不符合回傳 null（檔名包含 < 路徑包含 < 依序出現） */
function matchScore(rel, q) {
  const r = rel.toLowerCase();
  const name = r.slice(r.lastIndexOf('/') + 1);
  let i = name.indexOf(q);
  if (i >= 0) return (i === 0 ? 0 : 1) * 1000 + i;
  i = r.indexOf(q);
  if (i >= 0) return 2000 + i;
  let p = 0;
  for (const ch of q) { if (ch === ' ') continue; p = r.indexOf(ch, p); if (p < 0) return null; p++; }
  return 3000 + p;
}

function markMatch(name, q) {
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<b>${esc(name.slice(i, i + q.length))}</b>${esc(name.slice(i + q.length))}`;
}

function onFilterKey(e) {
  const rows = $$('#tree .row');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    filterSel = Math.max(0, Math.min(rows.length - 1, filterSel + (e.key === 'ArrowDown' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('sel', i === filterSel));
    if (rows[filterSel]) rows[filterSel].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const r = rows[filterSel];
    if (r) openFile(absOf(r.dataset.rel)).then(() => { if (!e.shiftKey) { $('#filter').value = ''; revealInTree(r.dataset.rel); } }).catch(fail);
  } else if (e.key === 'Escape') {
    $('#filter').value = '';
    renderTree();
    const t = activeTab();
    if (t && t.kind === 'file') t.view.focus();
  }
}

/* ───────────── Git ───────────── */

const GIT_GROUPS = [['conflict', '合併衝突'], ['staged', '已暫存的變更'], ['unstaged', '變更'], ['untracked', '未追蹤']];

let gitTimer = null;
function refreshGitSoon(ms = 1500) { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, ms); }
let gitBusy = false;
let gitAgain = false;
async function refreshGit() {
  clearTimeout(gitTimer);
  if (!st.pid) return;
  if (gitBusy) { gitAgain = true; return; }
  gitBusy = true;
  gitAgain = false;
  const pid = st.pid;
  try {
    const g = await td.invoke('gitStatus', pid);
    if (pid !== st.pid) return;
    st.git = g;
  } catch (err) {
    st.git = { repo: false, message: err.message };
  } finally {
    gitBusy = false;
    if (gitAgain) setTimeout(refreshGit, 0);
  }
  buildGitMaps();
  renderGit();
  if ($('#filter').value.trim()) renderFilter(); else renderTree();
}

function buildGitMaps() {
  st.gitMap.clear();
  st.gitDirs.clear();
  const g = st.git;
  if (!g || !g.repo) return;
  // 同一個檔案同時在暫存與工作目錄時，以工作目錄的狀態顯示
  for (const area of ['staged', 'unstaged', 'untracked', 'conflict']) {
    for (const e of g[area]) {
      if (e.rel.startsWith('..')) continue;
      st.gitMap.set(e.rel, e.status);
      const parts = e.rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        const cur = st.gitDirs.get(d);
        if (!cur || e.status === 'U' || (cur !== 'U' && e.status === 'M')) st.gitDirs.set(d, e.status);
      }
    }
  }
}

function renderGit() {
  const g = st.git;
  const head = $('#gitHead');
  const box = $('#changes');
  const count = $('#gitCount');
  if (!st.pid) {
    head.innerHTML = '';
    box.innerHTML = '<div class="empty-msg">建立專案後，這裡會列出 Git 異動。</div>';
    count.hidden = true;
    return;
  }
  if (!g) { head.innerHTML = ''; box.innerHTML = '<div class="empty-msg">讀取 Git 狀態…</div>'; return; }
  if (!g.repo) {
    head.innerHTML = '';
    box.innerHTML = `<div class="empty-msg">${esc(g.message || '這個專案不是 Git 儲存庫')}<br><button class="secondary sm" data-act="refreshGit">重新檢查</button>`
      + `${st.targets.length ? ` <button class="secondary sm" data-act="openInGit" title="在 ${esc(targetName())}建立儲存庫（git init）">${esc(targetLabel())}</button>` : ''}</div>`;
    count.hidden = true;
    return;
  }
  const total = GIT_GROUPS.reduce((n, [k]) => n + g[k].length, 0);
  count.hidden = !total;
  count.textContent = total > 999 ? '999+' : String(total);
  const ab = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  head.innerHTML = `<div class="br"><span>⎇</span><span class="name" title="${esc(g.upstream ? `追蹤 ${g.upstream}` : '')}">${esc(g.branch || '（未知分支）')}</span>`
    + `${ab ? `<span class="ab" title="領先 ${g.ahead}、落後 ${g.behind} 個提交">${ab}</span>` : ''}`
    + `${st.targets.length ? `<button class="ib sm" data-act="openInGit" title="${esc(targetLabel())}：提交、推送、拉取、分支線圖">🌿</button>` : ''}<button class="ib sm" data-act="refreshGit" title="重新整理">⟳</button></div>`
    + `<div class="head" title="${esc(g.head)}">${g.noCommits ? '尚未有任何提交' : esc(g.head)}</div>`;
  prunePicks();
  box.classList.toggle('picking', st.gitPick.size > 0);
  if (!total) { box.innerHTML = '<div class="empty-msg">沒有異動，工作目錄是乾淨的 ✓</div>'; return; }
  const rows = [];
  if (st.gitPick.size) {
    rows.push(`<div class="pickbar"><span class="pn">已選取 ${st.gitPick.size} 個檔案</span>`
      + '<button class="sm" data-pact="restore" title="捨棄所選檔案的變更；未追蹤的檔案會被刪除">↶ 還原所選</button>'
      + '<button class="ib sm" data-pact="clear" title="取消選取（Esc）">✕</button></div>');
  }
  for (const [area, title] of GIT_GROUPS) {
    const list = g[area];
    if (!list.length) continue;
    const closed = st.gitCollapsed.has(area);
    const all = area === 'unstaged' ? '<button class="ib xs" data-rvall="1" title="捨棄全部變更">↶</button>' : area === 'untracked' ? '<button class="ib xs" data-rvall="1" title="刪除全部未追蹤的檔案">↶</button>' : '';
    rows.push(`<div class="grp-h" data-grp="${area}"><span class="tw">${closed ? '▸' : '▾'}</span>${title}<span class="n">${list.length}</span><span class="acts">${all}</span></div>`);
    if (closed) continue;
    list.forEach((e, i) => {
      const name = basename(e.rel);
      const dir = dirname(e.rel);
      const sel = activeDiffKey() === `${area}:${e.path}` ? ' sel' : '';
      const pickable = PICK_AREAS.has(area);
      const picked = pickable && st.gitPick.has(pickKey(area, e)) ? ' picked' : '';
      rows.push(`<div class="row${sel}${picked}" data-area="${area}" data-i="${i}" title="${esc(`${e.rel}（${e.label}${e.orig ? `，原為 ${e.orig}` : ''}）`)}" style="padding-left:20px">`
        + (pickable ? `<input type="checkbox" class="pk" tabindex="-1" ${picked ? 'checked' : ''} title="選取（${IS_MAC ? '⌘' : 'Ctrl'} 點選加選、⇧ 點選範圍）">` : '')
        + `<span class="ic">${iconFor(name)}</span><span class="nm g-${esc(e.status)}">${esc(name)}</span><span class="dir">${esc(dir)}</span>`
        + (area === 'unstaged' || area === 'untracked' ? `<span class="acts"><button class="ib xs" data-rv="1" title="${area === 'untracked' ? '刪除未追蹤的檔案' : '捨棄變更（改回暫存區的版本）'}">↶</button></span>` : '')
        + `<span class="gs g-${esc(e.status)}">${e.status === '?' ? 'U' : esc(e.status)}</span></div>`);
    });
  }
  box.innerHTML = rows.join('');
}

const activeDiffKey = () => { const t = activeTab(); return t && t.kind === 'diff' ? `${t.entry.area}:${t.entry.path}` : ''; };

/* 「變更」清單多選：只有工作目錄的變更與未追蹤的檔案可以選（已暫存的不還原） */
const PICK_AREAS = new Set(['unstaged', 'untracked']);
const pickKey = (area, e) => `${area}:${e.path}`;

/** 去掉已經不在清單中的選取（例如還原後、git 狀態改變後） */
function prunePicks() {
  const g = st.git;
  if (!g || !g.repo) { st.gitPick.clear(); return; }
  const alive = new Set();
  for (const area of PICK_AREAS) for (const e of g[area]) alive.add(pickKey(area, e));
  for (const k of [...st.gitPick]) if (!alive.has(k)) st.gitPick.delete(k);
  if (st.gitAnchor && !alive.has(st.gitAnchor)) st.gitAnchor = null;
}

function pickedEntries() {
  const g = st.git;
  if (!g || !g.repo) return [];
  const out = [];
  for (const area of PICK_AREAS) for (const e of g[area]) if (st.gitPick.has(pickKey(area, e))) out.push(e);
  return out;
}

/** 目前畫面上可選的列，依顯示順序 */
const pickRows = () => [...$$('#changes .row[data-area]')].filter((r) => PICK_AREAS.has(r.dataset.area));
const rowKey = (row) => pickKey(row.dataset.area, gitEntry(row));

function togglePick(row) {
  if (!PICK_AREAS.has(row.dataset.area)) { notice('已暫存的變更不能在這裡還原，只能選取「變更」與「未追蹤」中的檔案'); return; }
  const k = rowKey(row);
  if (st.gitPick.has(k)) st.gitPick.delete(k); else st.gitPick.add(k);
  st.gitAnchor = k;
  renderGit();
}

/** ⇧ 點選：從上次點選的列到這一列全部選取 */
function pickRange(row) {
  if (!PICK_AREAS.has(row.dataset.area)) return;
  const rows = pickRows();
  const to = rows.indexOf(row);
  const from = st.gitAnchor ? rows.findIndex((r) => rowKey(r) === st.gitAnchor) : -1;
  if (from < 0) { togglePick(row); return; }
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) st.gitPick.add(rowKey(rows[i]));
  renderGit();
}

function clearPicks() {
  if (!st.gitPick.size) return false;
  st.gitPick.clear();
  st.gitAnchor = null;
  renderGit();
  return true;
}

function pickAll() {
  for (const r of pickRows()) st.gitPick.add(rowKey(r));
  renderGit();
}

async function restorePicked() {
  const list = pickedEntries();
  if (!list.length) return;
  await restoreEntries(list);
}
const gitEntry = (row) => st.git[row.dataset.area][Number(row.dataset.i)];

function setSide(side) {
  st.side = side;
  for (const b of $$('#sideTabs button')) b.classList.toggle('on', b.dataset.side === side);
  $('#filesPane').hidden = side !== 'files';
  $('#gitPane').hidden = side !== 'git';
  $('#searchPane').hidden = side !== 'search';
  if (side === 'git' && !st.git) refreshGit();
  if (side === 'search') renderSearch();
  saveStateSoon();
}

async function openDiffForRel(rel) {
  const g = st.git;
  if (!g || !g.repo) return;
  for (const area of ['conflict', 'unstaged', 'untracked', 'staged']) {
    const e = g[area].find((x) => x.rel === rel);
    if (e) return openDiff(e);
  }
}

/* ───────────── 差異比對 ───────────── */

/**
 * 差異比對的畫面（標頭、左右標籤、內容），Git 異動與檔案歷史共用。
 * opts：head(pane) 回傳標頭 HTML；onAction(act, btn)；onOpenLine(bLine)；
 *       canRevert() 為 true 時每段變更有「還原此段」按鈕，按下時呼叫 onRevert(hunk)；sameText() 內容相同時的說明
 */
class DiffPane {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.expanded = new Set();
    this.data = null;
    el.classList.add('diff');
    el.innerHTML = '<div class="dhead"></div><div class="dlabels"><div></div><div></div></div><div class="dbody"></div>';
    this.head = $('.dhead', el);
    this.body = $('.dbody', el);
    this.body.addEventListener('click', (e) => {
      const rv = e.target.closest('.hrev');
      if (rv) { e.stopPropagation(); Promise.resolve(this.opts.onRevert(this.hunks[Number(rv.dataset.h)])).catch(fail); return; }
      const f = e.target.closest('.fold');
      if (f) { this.expanded.add(Number(f.dataset.start)); this.renderBody(); }
    });
    this.body.addEventListener('dblclick', (e) => {
      if (e.target.closest('.hrev')) return;
      const r = e.target.closest('.dr[data-b]');
      if (r && this.opts.onOpenLine) this.opts.onOpenLine(Number(r.dataset.b) + 1);
    });
    this.head.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) { this.expanded.clear(); st.diffMode = b.dataset.mode; store.set('diffMode', st.diffMode); this.render(); }
      else if (b.dataset.nav) this.nav(Number(b.dataset.nav));
      else if (b.dataset.act && this.opts.onAction) Promise.resolve(this.opts.onAction(b.dataset.act, b)).catch(fail);
    });
  }

  loading() {
    this.body.className = 'dbody';
    this.body.innerHTML = '<div class="dnote">讀取中…</div>';
  }

  error(msg) {
    this.data = null;
    this.head.innerHTML = '';
    $('.dlabels', this.el).hidden = true;
    this.body.className = 'dbody';
    this.body.innerHTML = `<div class="dnote">${esc(msg)}</div>`;
  }

  async setData(d, file) {
    this.lang = C.langFor(file);
    await ensureLang(this.lang);
    this.data = d;
    this.expanded.clear();
    const a = d.left.text.replace(/\r\n?/g, '\n');
    const b = d.right.text.replace(/\r\n?/g, '\n');
    this.a = C.toLines(a);
    this.b = C.toLines(b);
    this.ops = C.diffLines(this.a, this.b);
    this.stats = C.diffStats(this.ops);
    this.hunks = C.hunks(this.ops);
    // 整段高亮後再切行，多行註解與字串才會正確
    this.ha = C.splitHtmlLines(highlightCode(this.a.join('\n'), this.lang));
    this.hb = C.splitHtmlLines(highlightCode(this.b.join('\n'), this.lang));
    this.render();
  }

  /** 標頭共用的部分 */
  statsHtml() {
    const s = this.stats;
    return `<span class="add">+${s.added}</span><span class="del">−${s.removed}</span>`;
  }

  navHtml() {
    return `<div class="seg"><button data-mode="sbs" class="${st.diffMode === 'sbs' ? 'on' : ''}">並排</button><button data-mode="uni" class="${st.diffMode === 'uni' ? 'on' : ''}">行內</button></div>`
      + '<button class="ib sm" data-nav="-1" title="上一個變更">↑</button><button class="ib sm" data-nav="1" title="下一個變更">↓</button>';
  }

  render() {
    const d = this.data;
    if (!d) return;
    this.head.innerHTML = this.opts.head(this);
    const labels = $('.dlabels', this.el);
    labels.hidden = st.diffMode !== 'sbs';
    labels.children[0].textContent = `${d.left.label}${d.left.note ? `（${d.left.note}）` : ''}`;
    labels.children[1].textContent = `${d.right.label}${d.right.note ? `（${d.right.note}）` : ''}`;
    this.renderBody();
  }

  renderBody() {
    const d = this.data;
    if (!d) return;
    this.body.className = 'dbody';
    if (d.left.binary || d.right.binary) { this.body.innerHTML = '<div class="dnote">二進位檔案，無法顯示差異。</div>'; return; }
    if (!this.ops.length) { this.body.innerHTML = '<div class="dnote">檔案是空的。</div>'; return; }
    if (!this.stats.added && !this.stats.removed) {
      this.body.innerHTML = `<div class="dnote">${esc(this.opts.sameText ? this.opts.sameText() : '內容相同（可能只有權限或換行字元不同）。')}</div>`;
      return;
    }
    const sbs = st.diffMode === 'sbs';
    const revert = !!(this.opts.canRevert && this.opts.canRevert());
    this.body.className = `dbody ${sbs ? 'sbs' : 'uni'}`;
    const digits = String(Math.max(this.a.length, this.b.length)).length;
    this.body.style.setProperty('--lnw', `calc(${digits}ch + 16px)`);
    const rows = C.fold(sbs ? C.sideBySide(this.ops) : C.unified(this.ops), 3, this.expanded);
    const A = (i) => lineHtml(this.ha[i] || '');
    const B = (i) => lineHtml(this.hb[i] || '');
    const out = [];
    let prev = 'eq';
    let hunk = -1;
    for (const r of rows) {
      if (r.kind === 'fold') { out.push(`<div class="dr fold" data-start="${r.start}"><span>⋯ 展開 ${r.count} 行未變更的內容</span></div>`); prev = 'eq'; continue; }
      const first = r.kind !== 'eq' && prev === 'eq';
      if (first) hunk++;
      const start = first ? ` data-chg="1" data-h="${hunk}"` : '';
      const bAttr = r.b !== null ? ` data-b="${r.b}"` : '';
      const rv = first && revert ? `<button class="hrev" data-h="${hunk}" title="把這一段改回「${esc(d.left.label)}」的內容">↶ 還原此段</button>` : '';
      prev = r.kind;
      if (sbs) {
        const lk = r.kind === 'eq' ? '' : r.a === null ? 'none' : 'del';
        const rk = r.kind === 'eq' ? '' : r.b === null ? 'none' : 'add';
        out.push(`<div class="dr"${start}${bAttr}><span class="n ${lk}">${r.a !== null ? r.a + 1 : ''}</span><span class="c ${lk}">${r.a !== null ? A(r.a) : ''}</span>`
          + `<span class="n ${rk}">${r.b !== null ? r.b + 1 : ''}</span><span class="c ${rk}">${r.b !== null ? B(r.b) : ''}</span>${rv}</div>`);
      } else {
        const k = r.kind === 'eq' ? '' : r.kind;
        out.push(`<div class="dr"${start}${bAttr}><span class="n ${k}">${r.a !== null ? r.a + 1 : ''}</span><span class="n ${k}">${r.b !== null ? r.b + 1 : ''}</span>`
          + `<span class="s ${k}">${r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}</span><span class="c ${k}">${r.kind === 'del' ? A(r.a) : B(r.b)}</span>${rv}</div>`);
      }
    }
    this.body.innerHTML = out.join('');
  }

  /** 跳到上一個／下一個變更 */
  nav(dir) {
    const chg = $$('.dr[data-chg]', this.body);
    if (!chg.length) return;
    const top = this.body.scrollTop;
    let i;
    if (dir > 0) { i = chg.findIndex((r) => r.offsetTop > top + 40); if (i < 0) i = 0; } else {
      i = -1;
      for (let k = chg.length - 1; k >= 0; k--) if (chg[k].offsetTop < top - 4) { i = k; break; }
      if (i < 0) i = chg.length - 1;
    }
    for (const r of $$('.dr.focus', this.body)) r.classList.remove('focus');
    chg[i].classList.add('focus');
    this.body.scrollTop = Math.max(0, chg[i].offsetTop - 60);
    notice(`第 ${i + 1} / ${chg.length} 處變更`);
  }
}

/** Git 異動的比對分頁 */
class DiffView {
  constructor(tab) {
    this.tab = tab;
    this.el = document.createElement('div');
    this.el.className = 'view';
    $('#stage').append(this.el);
    this.pane = new DiffPane(this.el, {
      head: (p) => this.headHtml(p),
      onAction: (act) => this.action(act),
      onOpenLine: (line) => { if (this.tab.entry.area !== 'staged') openFile(this.tab.entry.file, { line }).catch(fail); },
      canRevert: () => this.tab.entry.area === 'unstaged' && !!this.pane.data && this.pane.data.left.exists && this.pane.data.right.exists,
      onRevert: (h) => revertHunk(this.tab, h),
      sameText: () => (this.tab.entry.status === 'R' ? '內容相同（只有重新命名）。' : '內容相同（可能只有權限或換行字元不同）。'),
    });
  }

  async load() {
    const e = this.tab.entry;
    this.pane.loading();
    try {
      const d = await td.invoke('gitDiff', { id: st.pid, top: st.git.top, area: e.area, path: e.path, orig: e.orig });
      await this.pane.setData(d, e.path);
    } catch (err) {
      this.pane.error(`無法比對：${err.message}`);
    }
  }

  headHtml(p) {
    const e = this.tab.entry;
    const areaName = Object.fromEntries(GIT_GROUPS)[e.area];
    const restore = e.area === 'unstaged' ? '<button class="secondary sm" data-act="restore" title="捨棄工作目錄的變更，改回暫存區的版本">↶ 還原檔案…</button>'
      : e.area === 'untracked' ? '<button class="secondary sm" data-act="restore" title="刪除這個未追蹤的檔案">刪除檔案…</button>' : '';
    return `<span class="p" title="${esc(e.rel)}">${esc(e.rel)}</span><span class="st g-${esc(e.status)}">${esc(areaName)}・${esc(e.label)}</span>`
      + `${p.statsHtml()}<span class="sp"></span>${p.navHtml()}${restore}`
      + `${e.status !== 'D' ? '<button class="secondary sm" data-act="open">開啟檔案</button>' : ''}`
      + `${e.area !== 'untracked' ? '<button class="ib sm" data-act="history" title="檔案歷史">🕘</button>' : ''}<button class="ib sm" data-act="reload" title="重新整理">⟳</button>`;
  }

  action(act) {
    const e = this.tab.entry;
    if (act === 'open') return openFile(e.file);
    if (act === 'reload') return this.load();
    if (act === 'restore') return restoreEntries([e]);
    if (act === 'history') return openHistory(e.file);
    return null;
  }

  onFileChanged() { return this.load(); }
  saveViewState() { return null; }
  destroy() { this.el.remove(); }
}

/** 開啟差異分頁（預覽方式：取代目前的預覽分頁） */
async function openDiff(entry, { preview = true } = {}) {
  const key = `${entry.area}:${entry.path}`;
  let t = st.tabs.find((x) => x.kind === 'diff' && `${x.entry.area}:${x.entry.path}` === key);
  if (t) {
    t.entry = entry;
    if (!preview && t.preview) pinTab(t);
    activate(t.id);
    t.view.load();
    return t;
  }
  t = { kind: 'diff', entry, file: null, name: `${basename(entry.rel)}（${entry.area === 'staged' ? '已暫存' : '差異'}）`, title: `${entry.rel} — ${entry.label}`, preview };
  const old = preview ? st.tabs.find((x) => x.preview && !isDirty(x)) : null;
  addTab(t);
  t.view = new DiffView(t);
  t.view.el.hidden = true;
  if (old) closeTab(old.id, true);
  activate(t.id);
  await t.view.load();
  renderGit();
  return t;
}

/* ───────────── 尋找與取代 ───────────── */

function findRegex() {
  const q = $('#findInput').value;
  if (!q) return null;
  try {
    const src = st.find.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(src, st.find.caseSens ? 'gm' : 'gim');
    $('#findInput').classList.remove('bad');
    return re;
  } catch {
    $('#findInput').classList.add('bad');
    return null;
  }
}

function allMatches(text, re, limit = 20000) {
  const out = [];
  if (!re) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function codeTab() { const t = activeTab(); return t && t.kind === 'file' && !t.unavailable ? t : null; }

function openFind(replace) {
  const t = codeTab();
  if (!t) return;
  st.find.open = true;
  $('#findBar').hidden = false;
  const sel = t.view.ta.value.slice(t.view.ta.selectionStart, t.view.ta.selectionEnd);
  if (sel && !sel.includes('\n')) $('#findInput').value = sel;
  const input = replace ? $('#replaceInput') : $('#findInput');
  input.focus();
  input.select();
  refreshFind();
}

function closeFind() {
  st.find.open = false;
  $('#findBar').hidden = true;
  const t = codeTab();
  if (t) { t.view.markHit(-1); t.view.focus(); }
}

let findTimer = null;
function scheduleFindCount() { if (st.find.open) { clearTimeout(findTimer); findTimer = setTimeout(refreshFind, 200); } }

function refreshFind(current) {
  const t = codeTab();
  if (!t) { $('#findCount').textContent = ''; return; }
  const ms = allMatches(t.view.text, findRegex());
  const q = $('#findInput').value;
  if (!q) { $('#findCount').textContent = ''; return; }
  if (!ms.length) { $('#findCount').textContent = '沒有結果'; return; }
  const i = current === undefined ? -1 : current;
  $('#findCount').textContent = i >= 0 ? `${i + 1} / ${ms.length.toLocaleString()}${ms.length >= 20000 ? '+' : ''}` : `${ms.length.toLocaleString()} 筆`;
}

function findStep(dir) {
  const t = codeTab();
  if (!t) return;
  const ta = t.view.ta;
  const ms = allMatches(ta.value, findRegex());
  if (!ms.length) { refreshFind(); return; }
  let i;
  if (dir > 0) { i = ms.findIndex(([s]) => s >= ta.selectionEnd); if (i < 0) i = 0; } else {
    i = -1;
    for (let k = ms.length - 1; k >= 0; k--) if (ms[k][0] < ta.selectionStart) { i = k; break; }
    if (i < 0) i = ms.length - 1;
  }
  ta.setSelectionRange(ms[i][0], ms[i][1]);
  t.view.onCaret();
  t.view.reveal(true);
  t.view.markHit(t.view.caretLine());
  refreshFind(i);
}

function replaceOne() {
  const t = codeTab();
  if (!t || t.view.ta.readOnly) return;
  const ta = t.view.ta;
  const re = findRegex();
  if (!re) return;
  const ms = allMatches(ta.value, re);
  const hit = ms.find(([s, e]) => s === ta.selectionStart && e === ta.selectionEnd);
  if (hit) {
    const sel = ta.value.slice(hit[0], hit[1]);
    const rep = st.find.regex ? sel.replace(new RegExp(re.source, re.flags.replace('g', '')), $('#replaceInput').value) : $('#replaceInput').value;
    applyEdit(t.view, { from: hit[0], to: hit[1], insert: rep, selStart: hit[0] + rep.length, selEnd: hit[0] + rep.length });
  }
  findStep(1);
}

function replaceAll() {
  const t = codeTab();
  if (!t || t.view.ta.readOnly) return;
  const re = findRegex();
  if (!re) return;
  const text = t.view.text;
  const n = allMatches(text, re, Infinity).length;
  if (!n) { notice('沒有符合的內容'); return; }
  const rep = $('#replaceInput').value;
  const out = st.find.regex ? text.replace(re, rep) : text.replace(re, () => rep);
  applyEdit(t.view, { from: 0, to: text.length, insert: out, selStart: 0, selEnd: 0 });
  notice(`已取代 ${n.toLocaleString()} 處`);
  refreshFind();
}

/* ───────────── 改寫硬碟檔案之後：重新載入與復原 ───────────── */

/** 尚未儲存的分頁不能被取代或還原蓋掉 */
function guardDirty(files) {
  const t = st.tabs.find((x) => x.kind === 'file' && files.includes(x.file) && isDirty(x));
  if (!t) return true;
  activate(t.id);
  notice(`「${t.name}」有尚未儲存的變更，請先儲存或放棄修改再操作`, 'err');
  return false;
}

/** 擴充改寫了硬碟上的檔案：重新載入沒有修改過的分頁、關閉被刪除檔案的分頁，重新整理比對、檔案樹與 Git */
async function afterDiskChange(changed) {
  const set = new Set(changed);
  if (!set.size) return;
  for (const t of [...st.tabs]) {
    if (t.kind !== 'file' || !t.file || !set.has(t.file)) continue;
    const s = await td.invoke('stat', t.file).catch(() => null);
    if (!s) { if (!isDirty(t)) await closeTab(t.id, true); continue; }
    if (isDirty(t)) { checkExternal(t); continue; }
    const vs = t.view.saveViewState && t.view.saveViewState();
    try {
      fillDoc(t, await readDoc(t.file));
      if (vs) t.view.restoreViewState(vs);
    } catch { /* 檔案讀不到時留給下次檢查 */ }
  }
  for (const t of st.tabs) if ((t.kind === 'diff' || t.kind === 'history') && set.has(t.entry.file)) t.view.onFileChanged();
  st.fileList = null;
  await loadTree();
  renderTabs();
  updateStatusBar();
  await refreshGit();
}

/** 操作結果的提示列；undoId 有值時附上「復原」 */
function resultBanner(msg, undoId, failures = []) {
  const why = failures.length
    ? `　${failures.length} 個沒有完成：${failures.slice(0, 2).map((f) => `${basename(f.path || f.file)}（${f.reason}）`).join('、')}${failures.length > 2 ? '…' : ''}`
    : '';
  const acts = [];
  if (undoId) acts.push(['↶ 復原', () => undoOp(undoId).catch(fail), 'primary']);
  acts.push(['關閉', () => {}]);
  banner(msg + why, acts);
}

async function undoOp(id) {
  const r = await td.invoke('undo', id);
  if (srch.undo && srch.undo.id === id) srch.undo = null;
  await afterDiskChange(r.restored);
  if (r.skipped.length) resultBanner(`已復原 ${r.restored.length} 個檔案。`, null, r.skipped);
  else { banner(''); notice(`已復原「${r.label}」（${r.restored.length} 個檔案）`); }
  if (srch.query) await runSearch();
  else renderSearchBar();
  return r;
}

/* ───────────── 跨檔案搜尋與取代 ───────────── */

const srch = {
  caseSens: false,
  word: false,
  regex: false,
  showRep: false,
  more: false,
  useIgnore: true, // 套用搜尋排除設定與 .gitignore
  query: null, // 目前結果使用的搜尋條件
  result: null, // { files: [{ rel, file, readOnly, matches: [{ ..., off }], collapsed }], total, truncated, tooMany, error }
  running: false,
  replacing: false, // 取代進行中（避免重複按下）
  seq: 0,
  undo: null, // { id, label }
  sel: -1, // 鍵盤選取的列
};
const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const SEARCH_PREFS = ['caseSens', 'word', 'regex', 'showRep', 'more', 'useIgnore'];

function loadSearchPrefs() {
  const p = store.get('search', {});
  for (const k of SEARCH_PREFS) if (typeof p[k] === 'boolean') srch[k] = p[k];
  $('#sInclude').value = p.include || '';
  $('#sExclude').value = p.exclude || '';
  syncSearchForm();
}

function saveSearchPrefs() {
  const p = { include: $('#sInclude').value, exclude: $('#sExclude').value };
  for (const k of SEARCH_PREFS) p[k] = srch[k];
  store.set('search', p);
}

function syncSearchForm() {
  $('#sCase').classList.toggle('on', srch.caseSens);
  $('#sWord').classList.toggle('on', srch.word);
  $('#sRegex').classList.toggle('on', srch.regex);
  $('#sRepRow').hidden = !srch.showRep;
  $('#sRepToggle').textContent = srch.showRep ? '▾' : '▸';
  $('#sMore').hidden = !srch.more;
  $('#sUseIgnore').checked = srch.useIgnore;
  const custom = $('#sInclude').value || $('#sExclude').value || !srch.useIgnore;
  $('#sMoreBtn').textContent = `${srch.more ? '▾' : '▸'} 檔案篩選${!srch.more && custom ? '（使用中）' : ''}`;
}

const searchOpts = () => ({
  query: $('#sQuery').value,
  regex: srch.regex,
  caseSens: srch.caseSens,
  word: srch.word,
  include: $('#sInclude').value,
  exclude: $('#sExclude').value,
  useIgnore: srch.useIgnore,
});

/** 專案內已開啟的檔案分頁（以編輯器中的內容搜尋與取代） */
function openFileTabs() {
  const m = new Map();
  for (const t of st.tabs) {
    if (t.kind !== 'file' || !t.file || t.unavailable || t.decompiled) continue;
    const rel = relOf(t.file);
    if (rel !== null) m.set(rel, t);
  }
  return m;
}

function searchBuffer(t, rel, re, regex, limit = 5000) {
  const r = C.findInText(t.view.text, re, { limit, groups: regex });
  return { rel, file: t.file, readOnly: t.readOnly ? t.encoding : '', matches: r.matches };
}

let searchTimer = null;
function runSearchSoon(ms = 350) { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch().catch(fail), ms); }

async function runSearch() {
  clearTimeout(searchTimer);
  const o = searchOpts();
  const seq = ++srch.seq;
  srch.sel = -1;
  if (!o.query || !st.pid) {
    srch.query = null;
    srch.result = null;
    srch.running = false;
    $('#sQuery').classList.remove('bad');
    td.invoke('cancelSearch').catch(() => {});
    renderSearch();
    return;
  }
  let re;
  try {
    re = C.searchRegex(o);
    $('#sQuery').classList.remove('bad');
  } catch (err) {
    $('#sQuery').classList.add('bad');
    srch.result = { error: `規則運算式有誤：${err.message}` };
    srch.running = false;
    renderSearch();
    return;
  }
  srch.running = true;
  renderSearchBar();
  const open = openFileTabs();
  const keep = C.pathFilter(o.include, o.exclude);
  try {
    const r = await td.invoke('search', { id: st.pid, ...o, skip: [...open.keys()] });
    if (seq !== srch.seq || r.canceled) return;
    const list = [...r.files];
    let total = r.total;
    const hidden = new Set(r.hidden || []);
    for (const [rel, t] of open) {
      if (!keep(rel) || hidden.has(rel)) continue;
      const f = searchBuffer(t, rel, re, o.regex);
      if (f.matches.length) { list.push(f); total += f.matches.length; }
    }
    list.sort((a, b) => collator.compare(a.rel, b.rel));
    srch.query = o;
    srch.result = { ...r, files: list, total };
  } catch (err) {
    if (seq === srch.seq) srch.result = { error: err.message };
  } finally {
    if (seq === srch.seq) {
      srch.running = false;
      renderSearch();
    }
  }
}

/** 重新搜尋單一檔案（取代之後更新清單） */
async function searchOneFile(f) {
  const q = srch.query;
  const t = st.tabs.find((x) => x.kind === 'file' && x.file === f.file && !x.unavailable);
  if (t) return searchBuffer(t, f.rel, C.searchRegex(q), q.regex).matches;
  const r = await td.invoke('search', { id: st.pid, ...q, only: [f.rel] });
  return r.files && r.files[0] ? r.files[0].matches : [];
}

const countAll = () => (srch.result && srch.result.files ? srch.result.files.reduce((n, f) => n + f.matches.length, 0) : 0);
const countSelected = () => (srch.result && srch.result.files ? srch.result.files.reduce((n, f) => n + (f.readOnly ? 0 : f.matches.filter((m) => !m.off).length), 0) : 0);

function renderSearch() {
  renderSearchBar();
  renderSearchResults();
}

function renderSearchBar() {
  const bar = $('#sBar');
  const r = srch.result;
  if (!st.pid) { bar.innerHTML = ''; return; }
  let msg = '';
  if (srch.running) msg = '搜尋中…';
  else if (r && r.error) msg = `<span class="err">${esc(r.error)}</span>`;
  else if (r) {
    const n = countAll();
    msg = n ? `${r.files.length.toLocaleString()} 個檔案中有 ${n.toLocaleString()} 筆結果` : '沒有結果';
    if (!n && r.ignored) msg += `<br><span class="faint">有 ${r.ignored.toLocaleString()} 個檔案或資料夾依搜尋排除設定與 .gitignore 略過，可在「檔案篩選」取消套用</span>`;
    if (r.truncated) msg += `<br><span class="warn">結果太多，只列出前 ${r.total.toLocaleString()} 筆，請縮小搜尋範圍</span>`;
    if (r.tooMany) msg += '<br><span class="warn">專案檔案太多，只搜尋了一部分</span>';
    const sk = r.skipped || {};
    if (sk.large) msg += `<br><span class="faint">略過 ${sk.large} 個超過 10 MB 的檔案</span>`;
  }
  const acts = r && r.files && r.files.length
    ? '<button class="ib sm" data-sact="collapseAll" title="全部收合／展開">⊟</button><button class="ib sm" data-sact="clear" title="清除結果">✕</button>' : '';
  const sel = countSelected();
  let html = msg || acts ? `<div class="sline"><span class="smsg">${msg}</span>${acts}</div>` : '';
  if (srch.showRep && r && r.files && r.files.length) {
    html += `<div class="sline"><button class="sm" data-sact="replaceSel" ${sel && !srch.replacing ? '' : 'disabled'}>${srch.replacing ? '取代中…' : `取代所選（${sel.toLocaleString()}）`}</button>`
      + '<button class="ib sm" data-sact="checkAll" title="全選">☑</button><button class="ib sm" data-sact="checkNone" title="全不選">☐</button></div>';
  }
  if (srch.undo) html += `<div class="sline"><button class="secondary sm" data-sact="undo" title="${esc(srch.undo.label)}">↶ 復原上次取代</button><span class="smsg faint">${esc(srch.undo.label)}</span></div>`;
  bar.innerHTML = html;
}

const oneLine = (s) => String(s).replace(/\n/g, '↵');

function matchPreview(m, rep) {
  const before = m.cut ? `…${m.before}` : m.before.replace(/^\s+/, '');
  const shown = m.multi ? `${m.text.split('\n')[0]}↵…` : m.text;
  const hit = rep === null
    ? `<mark>${esc(shown)}</mark>`
    : `<del>${esc(shown)}</del><ins>${esc(oneLine(C.expandReplacement(rep, m, srch.query.regex)))}</ins>`;
  return `${esc(before)}${hit}${esc(m.after)}`;
}

function renderSearchResults() {
  const box = $('#sResults');
  const r = srch.result;
  if (!st.pid) { box.innerHTML = '<div class="empty-msg">建立專案後，可以在整個專案中搜尋與取代。</div>'; return; }
  if (!r || r.error || !r.files) {
    box.innerHTML = r ? '' : '<div class="empty-msg">輸入要搜尋的文字。<br>展開左邊的 ▸ 可以取代：結果會先列出來，確認後再逐一或勾選取代。</div>';
    return;
  }
  const rep = srch.showRep ? $('#sReplace').value : null;
  const dirty = new Set(st.tabs.filter(isDirty).map((t) => t.file));
  const rows = [];
  let row = 0;
  r.files.forEach((f, fi) => {
    const on = f.matches.filter((m) => !m.off).length;
    const name = basename(f.rel);
    const canRep = srch.showRep && !f.readOnly;
    rows.push(`<div class="row sfile${row++ === srch.sel ? ' sel' : ''}" data-f="${fi}" title="${esc(f.rel)}">`
      + `<span class="tw">${f.collapsed ? '▸' : '▾'}</span>`
      + (srch.showRep ? `<input type="checkbox" class="sck" ${on ? 'checked' : ''} ${f.readOnly ? 'disabled' : ''} data-part="${on && on < f.matches.length ? 1 : ''}">` : '')
      + `<span class="ic">${iconFor(name)}</span><span class="nm">${esc(name)}</span><span class="dir">${esc(dirname(f.rel))}</span>`
      + (f.readOnly ? `<span class="lock" title="${esc(String(f.readOnly).toUpperCase())} 編碼的檔案為唯讀，不能取代">🔒</span>` : '')
      + (dirty.has(f.file) ? '<span class="dmark" title="已開啟且尚未儲存：取代會改在編輯器中，不會寫入硬碟">●</span>' : '')
      + `<span class="cnt">${f.matches.length}</span>`
      + `<span class="acts">${canRep ? '<button class="ib xs" data-sact="repFile" title="取代這個檔案中勾選的項目">⇄</button>' : ''}<button class="ib xs" data-sact="dismissFile" title="從清單移除">✕</button></span></div>`);
    if (f.collapsed) return;
    f.matches.forEach((m, mi) => {
      rows.push(`<div class="row smatch${m.off ? ' off' : ''}${row++ === srch.sel ? ' sel' : ''}" data-f="${fi}" data-m="${mi}" title="第 ${m.line} 行，第 ${m.col} 欄">`
        + (srch.showRep ? `<input type="checkbox" class="sck" ${m.off ? '' : 'checked'} ${f.readOnly ? 'disabled' : ''}>` : '')
        + `<span class="pv">${matchPreview(m, rep)}</span><span class="ln">${m.line}</span>`
        + `<span class="acts">${canRep ? '<button class="ib xs" data-sact="repOne" title="取代這一處">⇄</button>' : ''}<button class="ib xs" data-sact="dismiss" title="從清單移除">✕</button></span></div>`);
    });
  });
  box.innerHTML = rows.join('');
  for (const c of $$('.sck[data-part="1"]', box)) c.indeterminate = true;
}

/** 在編輯器開啟符合的位置並選取 */
async function openMatch(f, m, preview = true) {
  const t = await openFile(f.file, { preview });
  if (!t || t.unavailable) return;
  const ta = t.view.ta;
  if (ta.value.slice(m.start, m.end) === m.text) {
    t.view.focus();
    ta.setSelectionRange(m.start, m.end);
    t.view.onCaret();
    t.view.reveal(true);
    t.view.markHit(t.view.caretLine());
  } else {
    t.view.gotoLine(m.line, m.col);
  }
}

/** 只改變不同的那一段（一個 ⌘Z 就能復原整次取代） */
function applySpanEdit(view, old, out) {
  const max = Math.min(old.length, out.length);
  let s = 0;
  while (s < max && old[s] === out[s]) s++;
  let e = 0;
  while (e < max - s && old[old.length - 1 - e] === out[out.length - 1 - e]) e++;
  const insert = out.slice(s, out.length - e);
  applyEdit(view, { from: s, to: old.length - e, insert, selStart: s, selEnd: s + insert.length });
}

/**
 * 取代：targets = [{ f, ms }]。
 * 已開啟且尚未儲存的檔案改在編輯器中取代（可用 ⌘Z 復原）；其餘寫入硬碟（可按「復原上次取代」還原）。
 */
async function replaceTargets(targets, opts = {}) {
  if (srch.replacing) { notice('正在取代，請稍候'); return; }
  srch.replacing = true;
  renderSearchBar();
  try {
    await doReplace(targets, opts);
  } finally {
    srch.replacing = false;
    renderSearchBar();
  }
}

async function doReplace(targets, { confirm = false } = {}) {
  const q = srch.query;
  if (!q) return;
  const rep = $('#sReplace').value;
  targets = targets.map((x) => ({ f: x.f, ms: x.ms })).filter((x) => x.ms.length && !x.f.readOnly);
  const n = targets.reduce((s, x) => s + x.ms.length, 0);
  if (!n) { notice('沒有勾選要取代的項目'); return; }
  if (confirm && (targets.length > 1 || n > 1)) {
    const r = await td.dialog.message({
      type: 'question',
      message: `要在 ${targets.length.toLocaleString()} 個檔案中取代 ${n.toLocaleString()} 處嗎？`,
      detail: `「${oneLine(q.query)}」→「${oneLine(rep)}」\n\n沒有在編輯器中修改過的檔案會直接寫入硬碟，之後可以按「復原上次取代」還原；已開啟且尚未儲存的檔案會改在編輯器中取代，可以用 ${MOD}Z 復原。`,
      buttons: ['取代', '取消'], defaultId: 0, cancelId: 1,
    });
    if (r.response !== 0) return;
  }
  const jobs = targets.map((x) => {
    const reps = x.ms.map((m) => ({ start: m.start, end: m.end, text: m.text, replacement: C.expandReplacement(rep, m, q.regex) }));
    const t = st.tabs.find((tt) => tt.kind === 'file' && tt.file === x.f.file && !tt.unavailable);
    return { ...x, reps, t, inBuffer: !!t && isDirty(t), done: false, reason: '' };
  });
  // 編輯器中：要切到那個分頁才能用 execCommand（才會進入復原記錄）
  const back = st.active;
  for (const j of jobs.filter((x) => x.inBuffer)) {
    const old = j.t.view.text;
    const out = C.applyReplacements(old, j.reps);
    if (out === null) { j.reason = '內容在搜尋之後被修改過，請重新搜尋'; continue; }
    if (st.active !== j.t.id) activate(j.t.id);
    applySpanEdit(j.t.view, old, out);
    j.done = true;
  }
  if (back && st.active !== back && st.tabs.some((t) => t.id === back)) activate(back);
  const disk = jobs.filter((x) => !x.inBuffer);
  if (disk.length) {
    const label = `「${oneLine(q.query)}」→「${oneLine(rep)}」`;
    const r = await td.invoke('replaceInFiles', { id: st.pid, label, items: disk.map((j) => ({ file: j.f.file, reps: j.reps })) });
    r.results.forEach((res, i) => { if (res.ok) disk[i].done = true; else disk[i].reason = res.reason; });
    if (r.undoId) srch.undo = { id: r.undoId, label: `${label}（${r.results.filter((x) => x.ok).length} 個檔案）` };
    await afterDiskChange(disk.filter((j) => j.done).map((j) => j.f.file));
  }
  for (const j of jobs.filter((x) => x.done)) await refreshSearchFile(j.f, j.reps);
  const done = jobs.filter((x) => x.done);
  const count = done.reduce((s, j) => s + j.reps.length, 0);
  const buf = done.filter((j) => j.inBuffer).length;
  const failed = jobs.filter((x) => !x.done).map((j) => ({ file: j.f.file, reason: j.reason }));
  renderSearch();
  if (failed.length) resultBanner(`已取代 ${count.toLocaleString()} 處。`, null, failed);
  else notice(`已取代 ${count.toLocaleString()} 處（${done.length} 個檔案${buf ? `，其中 ${buf} 個在編輯器中、尚未儲存` : ''}）`);
}

/**
 * 取代之後更新那個檔案的結果：重新搜尋，只保留原本還在清單上、沒有被取代的項目（位置依取代的長度調整），
 * 沒有勾選的維持不勾選。
 */
async function refreshSearchFile(f, reps) {
  const r = srch.result;
  if (!r || !r.files) return;
  const sorted = [...reps].sort((a, b) => a.start - b.start);
  const replaced = new Set(sorted.map((x) => x.start));
  const shift = (pos) => {
    let d = 0;
    for (const x of sorted) if (x.start < pos) d += x.replacement.length - (x.end - x.start);
    return pos + d;
  };
  const on = new Set();
  const off = new Set();
  for (const m of f.matches) if (!replaced.has(m.start)) (m.off ? off : on).add(shift(m.start));
  let fresh = [];
  try { fresh = await searchOneFile(f); } catch { /* 讀不到就清掉 */ }
  f.matches = fresh.filter((m) => on.has(m.start) || off.has(m.start));
  for (const m of f.matches) m.off = off.has(m.start);
  if (!f.matches.length) r.files = r.files.filter((x) => x !== f);
}

function searchRowAt(el) {
  const row = el.closest('.row[data-f]');
  if (!row || !srch.result || !srch.result.files) return null;
  const f = srch.result.files[Number(row.dataset.f)];
  if (!f) return null;
  const m = row.dataset.m !== undefined ? f.matches[Number(row.dataset.m)] : null;
  return { row, f, m };
}

function onSearchClick(e, dbl) {
  const hit = searchRowAt(e.target);
  const act = e.target.closest('[data-sact]');
  if (!hit) return;
  const { f, m } = hit;
  srch.sel = $$('#sResults .row').indexOf(hit.row);
  if (e.target.classList.contains('sck')) {
    const v = e.target.checked;
    if (m) m.off = !v; else for (const x of f.matches) x.off = !v;
    renderSearch();
    return;
  }
  if (act) {
    const a = act.dataset.sact;
    if (a === 'repOne') replaceTargets([{ f, ms: [m] }]).catch(fail);
    else if (a === 'repFile') replaceTargets([{ f, ms: f.matches.filter((x) => !x.off) }]).catch(fail);
    else if (a === 'dismiss') { f.matches = f.matches.filter((x) => x !== m); if (!f.matches.length) srch.result.files = srch.result.files.filter((x) => x !== f); renderSearch(); }
    else if (a === 'dismissFile') { srch.result.files = srch.result.files.filter((x) => x !== f); renderSearch(); }
    return;
  }
  if (!m) { f.collapsed = !f.collapsed; renderSearchResults(); return; }
  markSearchSel();
  openMatch(f, m, !dbl).catch(fail);
}

function onSearchBarClick(e) {
  const b = e.target.closest('[data-sact]');
  if (!b || !srch.result) return;
  const a = b.dataset.sact;
  const files = srch.result.files || [];
  if (a === 'clear') { $('#sQuery').value = ''; runSearch().catch(fail); }
  else if (a === 'collapseAll') { const c = !files.every((f) => f.collapsed); for (const f of files) f.collapsed = c; renderSearchResults(); }
  else if (a === 'checkAll' || a === 'checkNone') { for (const f of files) for (const m of f.matches) m.off = a === 'checkNone'; renderSearch(); }
  else if (a === 'replaceSel') replaceTargets(files.map((f) => ({ f, ms: f.matches.filter((m) => !m.off) })), { confirm: true }).catch(fail);
  else if (a === 'undo' && srch.undo) undoOp(srch.undo.id).catch(fail);
}

function markSearchSel() {
  const rows = $$('#sResults .row');
  rows.forEach((r, i) => r.classList.toggle('sel', i === srch.sel));
  if (rows[srch.sel]) rows[srch.sel].scrollIntoView({ block: 'nearest' });
}

function onSearchKey(e) {
  const rows = $$('#sResults .row');
  if (!rows.length) return;
  const cur = rows[srch.sel];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    srch.sel = Math.max(0, Math.min(rows.length - 1, srch.sel + (e.key === 'ArrowDown' ? 1 : -1)));
    markSearchSel();
    const hit = searchRowAt(rows[srch.sel]);
    if (hit && hit.m) openMatch(hit.f, hit.m, true).then(() => $('#sResults').focus()).catch(fail);
  } else if (cur && e.key === 'Enter') {
    e.preventDefault();
    const hit = searchRowAt(cur);
    if (!hit) return;
    if (hit.m) openMatch(hit.f, hit.m, false).catch(fail);
    else { hit.f.collapsed = !hit.f.collapsed; renderSearchResults(); }
  } else if (cur && e.key === ' ' && srch.showRep) {
    e.preventDefault();
    const hit = searchRowAt(cur);
    if (!hit || hit.f.readOnly) return;
    if (hit.m) hit.m.off = !hit.m.off;
    else { const v = hit.f.matches.some((m) => m.off); for (const m of hit.f.matches) m.off = !v; }
    renderSearch();
  } else if (cur && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    const hit = searchRowAt(cur);
    if (!hit) return;
    if (hit.m) { hit.f.matches = hit.f.matches.filter((x) => x !== hit.m); if (!hit.f.matches.length) srch.result.files = srch.result.files.filter((x) => x !== hit.f); }
    else srch.result.files = srch.result.files.filter((x) => x !== hit.f);
    renderSearch();
    srch.sel = Math.min(srch.sel, $$('#sResults .row').length - 1);
    markSearchSel();
  }
}

/** ⌘⇧F／⌘⇧H：切到搜尋分頁，選取的文字（單行）帶入搜尋框 */
function openSearch(replace, include) {
  setSide('search');
  if (replace && !srch.showRep) { srch.showRep = true; syncSearchForm(); saveSearchPrefs(); renderSearch(); }
  if (include !== undefined) { $('#sInclude').value = include; srch.more = true; syncSearchForm(); saveSearchPrefs(); }
  const t = codeTab();
  const q = $('#sQuery');
  if (t) {
    const ta = t.view.ta;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n') && sel.length < 200) q.value = srch.regex ? sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : sel;
  }
  const input = replace && q.value ? $('#sReplace') : q;
  input.focus();
  input.select();
  if (q.value && (include !== undefined || !srch.query || srch.query.query !== q.value)) runSearch().catch(fail);
}

function bindSearch() {
  const q = $('#sQuery');
  q.addEventListener('input', () => runSearchSoon());
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch().catch(fail); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); $('#sResults').focus(); srch.sel = Math.max(0, srch.sel); markSearchSel(); }
  });
  let rt = null;
  $('#sReplace').addEventListener('input', () => { clearTimeout(rt); rt = setTimeout(renderSearchResults, 120); });
  $('#sReplace').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const files = srch.result && srch.result.files;
    if (files && files.length) replaceTargets(files.map((f) => ({ f, ms: f.matches.filter((m) => !m.off) })), { confirm: true }).catch(fail);
  });
  for (const [id, key] of [['#sCase', 'caseSens'], ['#sWord', 'word'], ['#sRegex', 'regex']]) {
    $(id).onclick = () => { srch[key] = !srch[key]; syncSearchForm(); saveSearchPrefs(); runSearch().catch(fail); };
  }
  $('#sRepToggle').onclick = () => { srch.showRep = !srch.showRep; syncSearchForm(); saveSearchPrefs(); renderSearch(); if (srch.showRep) $('#sReplace').focus(); };
  $('#sMoreBtn').onclick = () => { srch.more = !srch.more; syncSearchForm(); saveSearchPrefs(); if (srch.more) $('#sInclude').focus(); };
  $('#sUseIgnore').onchange = () => { srch.useIgnore = $('#sUseIgnore').checked; syncSearchForm(); saveSearchPrefs(); runSearch().catch(fail); };
  for (const id of ['#sInclude', '#sExclude']) {
    $(id).addEventListener('input', () => { saveSearchPrefs(); runSearchSoon(500); });
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch().catch(fail); } });
  }
  const res = $('#sResults');
  res.addEventListener('click', (e) => onSearchClick(e, false));
  res.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-sact], .sck')) onSearchClick(e, true); });
  res.addEventListener('keydown', onSearchKey);
  res.addEventListener('contextmenu', (e) => {
    const hit = searchRowAt(e.target);
    if (!hit) return;
    const { f, m } = hit;
    const items = [];
    if (m) items.push(['開啟', () => openMatch(f, m, false)]);
    if (srch.showRep && !f.readOnly) {
      if (m) items.push(['取代這一處', () => replaceTargets([{ f, ms: [m] }])]);
      items.push(['取代這個檔案中勾選的項目', () => replaceTargets([{ f, ms: f.matches.filter((x) => !x.off) }])]);
    }
    items.push('-', ['從清單移除', () => {
      if (m) f.matches = f.matches.filter((x) => x !== m);
      if (!m || !f.matches.length) srch.result.files = srch.result.files.filter((x) => x !== f);
      renderSearch();
    }]);
    items.push('-', ['複製路徑', () => copyText(f.file)], ['複製相對路徑', () => copyText(f.rel)]);
    contextMenu(e, items);
  });
  $('#sBar').addEventListener('click', onSearchBarClick);
}

/* ───────────── Git 還原 ───────────── */

/** 檔案在「變更」或「未追蹤」中的項目（可以還原的） */
function restorableEntry(rel) {
  const g = st.git;
  if (!g || !g.repo || rel === null) return null;
  return g.unstaged.find((x) => x.rel === rel) || g.untracked.find((x) => x.rel === rel) || null;
}

const isUntracked = (rel) => !!(st.git && st.git.repo && st.git.untracked.some((x) => x.rel === rel));

/** 捨棄工作目錄的變更（變更 → 暫存區的版本；未追蹤 → 刪除），先確認 */
async function restoreEntries(entries) {
  entries = entries.filter((e) => e && (e.area === 'unstaged' || e.area === 'untracked'));
  if (!entries.length || !st.git || !st.git.repo) return;
  if (!guardDirty(entries.map((e) => e.file))) return;
  const un = entries.filter((e) => e.area === 'untracked').length;
  const tr = entries.length - un;
  const one = entries.length === 1 ? basename(entries[0].rel) : '';
  const onlyDelete = un && !tr;
  const message = one
    ? (un ? `要刪除未追蹤的檔案「${one}」嗎？` : `要捨棄「${one}」的變更嗎？`)
    : onlyDelete ? `要刪除 ${un} 個未追蹤的檔案嗎？` : `要還原 ${entries.length} 個檔案嗎？`;
  const names = entries.length > 1
    ? entries.slice(0, 12).map((e) => `• ${e.rel}${e.area === 'untracked' ? '（未追蹤，刪除）' : ''}`).join('\n') + (entries.length > 12 ? `\n…等 ${entries.length} 個檔案` : '')
    : '';
  const detail = [
    names,
    tr ? '工作目錄的修改會被捨棄，改回暫存區的版本（沒有 git add 過時，就是最近一次提交的版本）。已暫存的變更不受影響。' : '',
    un ? '未追蹤的檔案會被刪除（不會移到垃圾桶）。' : '',
    '還原後可以按「復原」改回來（只在這次開啟 ToolDock 期間有效）。',
  ].filter(Boolean).join('\n\n');
  const ans = await td.dialog.message({ type: 'warning', message, detail, buttons: [onlyDelete ? '刪除' : '還原', '取消'], defaultId: 1, cancelId: 1 });
  if (ans.response !== 0) return;
  const r = await td.invoke('gitRestore', { id: st.pid, top: st.git.top, items: entries.map((e) => ({ area: e.area, path: e.path })) });
  const ok = entries.filter((_, i) => r.results[i] && r.results[i].ok);
  for (const e of ok) {
    const d = st.tabs.find((t) => t.kind === 'diff' && t.entry.area === e.area && t.entry.path === e.path);
    if (d) await closeTab(d.id, true);
  }
  await afterDiskChange(ok.map((e) => e.file));
  const what = ok.length === 1 ? basename(ok[0].rel) : `${ok.length} 個檔案`;
  resultBanner(ok.length ? `已${onlyDelete ? '刪除' : '還原'} ${what}。` : '沒有還原任何檔案。', r.undoId, r.results.filter((x) => !x.ok));
}

/** 比對中的「還原此段」 */
async function revertHunk(tab, h) {
  const e = tab.entry;
  if (!h || !guardDirty([e.file])) return;
  const r = await td.invoke('gitRevertHunk', { id: st.pid, top: st.git.top, path: e.path, hunk: h });
  await afterDiskChange([e.file]);
  resultBanner(`已還原 ${basename(e.rel)} 的一段變更。`, r.undoId);
}

/* ───────────── 檔案歷史 ───────────── */

const fmtTime = (ms) => new Date(ms).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** 儲存庫相對路徑（不在儲存庫內時回傳 null） */
function repoRel(file) {
  const top = st.git && st.git.repo ? st.git.top : null;
  if (!top || !file) return null;
  const sep = st.info.sep;
  const root = top.endsWith(sep) ? top : top + sep;
  if (!file.startsWith(root)) return null;
  return file.slice(root.length).split(sep).join('/');
}

async function openHistory(file) {
  if (!st.git) await refreshGit();
  if (!st.git || !st.git.repo) { notice('這個專案不是 Git 儲存庫'); return null; }
  const path = repoRel(file);
  if (path === null) { notice('檔案不在儲存庫內'); return null; }
  let t = st.tabs.find((x) => x.kind === 'history' && x.entry.file === file);
  if (t) { activate(t.id); return t; }
  const rel = relOf(file) ?? path;
  t = addTab({ kind: 'history', file: null, entry: { file, path, rel }, name: `${basename(file)}（歷史）`, title: `${rel} — 檔案歷史`, preview: false });
  t.view = new HistoryView(t);
  t.view.el.hidden = true;
  activate(t.id);
  await t.view.load();
  return t;
}

class HistoryView {
  constructor(tab) {
    this.tab = tab;
    this.commits = [];
    this.idx = 0;
    this.seq = 0;
    this.mode = store.get('histMode', 'commit');
    this.el = document.createElement('div');
    this.el.className = 'view hist';
    this.el.innerHTML = '<div class="hside"><div class="hinfo"></div><div class="hlist list" tabindex="0"></div></div><div class="hmain"></div>';
    $('#stage').append(this.el);
    this.list = $('.hlist', this.el);
    this.pane = new DiffPane($('.hmain', this.el), {
      head: (p) => this.headHtml(p),
      onAction: (act) => this.action(act),
      onOpenLine: (line) => { if (this.mode === 'working') openFile(this.tab.entry.file, { line }).catch(fail); },
      sameText: () => (this.mode === 'working' ? '和目前的檔案內容相同。' : '這次提交沒有改變內容（可能只有重新命名或權限變更）。'),
    });
    this.list.addEventListener('click', (e) => { const r = e.target.closest('.hrow'); if (r) this.select(Number(r.dataset.i)).catch(fail); });
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      this.select(Math.max(0, Math.min(this.commits.length - 1, this.idx + (e.key === 'ArrowDown' ? 1 : -1)))).catch(fail);
    });
  }

  async load() {
    const e = this.tab.entry;
    const info = $('.hinfo', this.el);
    info.textContent = '讀取提交紀錄…';
    try {
      const r = await td.invoke('gitLog', { id: st.pid, top: st.git.top, path: e.path });
      this.commits = r.commits;
      info.innerHTML = `<b title="${esc(e.rel)}">${esc(basename(e.path))}</b><span>${r.commits.length ? `${r.commits.length}${r.limited ? '+' : ''} 個提交` : ''}</span>`;
      this.renderList();
      if (!this.commits.length) { this.pane.error('這個檔案還沒有提交紀錄。'); return; }
      await this.select(Math.min(this.idx, this.commits.length - 1));
    } catch (err) {
      info.textContent = '';
      this.list.innerHTML = '';
      this.pane.error(`無法讀取檔案歷史：${err.message}`);
    }
  }

  renderList() {
    this.list.innerHTML = this.commits.map((c, i) => {
      const tip = `${c.short} ${c.subject}\n${c.author}　${fmtTime(c.at)}${c.orig ? `\n由 ${c.orig} 重新命名` : ''}`;
      const badge = c.status && c.status !== 'M' ? `<span class="gs g-${esc(c.status)}">${esc(c.status)}</span>` : '';
      return `<div class="hrow${i === this.idx ? ' sel' : ''}" data-i="${i}" title="${esc(tip)}">`
        + `<div class="s1">${esc(c.subject || '（沒有說明）')}</div>`
        + `<div class="s2"><span class="h">${esc(c.short)}</span><span class="a">${esc(c.author)}</span><span>${esc(fmtTime(c.at))}</span>${badge}</div></div>`;
    }).join('');
  }

  async select(i) {
    if (!this.commits[i]) return;
    this.idx = i;
    for (const r of $$('.hrow', this.list)) r.classList.toggle('sel', Number(r.dataset.i) === i);
    const row = $(`.hrow[data-i="${i}"]`, this.list);
    if (row) row.scrollIntoView({ block: 'nearest' });
    await this.loadDiff();
  }

  async loadDiff() {
    const c = this.commits[this.idx];
    if (!c) return;
    const seq = ++this.seq;
    this.pane.loading();
    try {
      const d = await td.invoke('gitVersion', {
        id: st.pid, top: st.git.top, rev: c.hash, path: c.path, orig: c.orig, status: c.status, mode: this.mode, target: this.tab.entry.path,
      });
      if (seq === this.seq) await this.pane.setData(d, c.path);
    } catch (err) {
      if (seq === this.seq) this.pane.error(`無法比對：${err.message}`);
    }
  }

  headHtml(p) {
    const c = this.commits[this.idx];
    return `<span class="p" title="${esc(`${c.hash}\n${c.subject}`)}">${esc(c.short)}　${esc(c.subject)}</span>`
      + `<div class="seg"><button data-act="mode-commit" class="${this.mode === 'commit' ? 'on' : ''}" title="上一版 ↔ 這個提交">這次提交的變更</button>`
      + `<button data-act="mode-working" class="${this.mode === 'working' ? 'on' : ''}" title="這個提交 ↔ 目前的檔案">與目前檔案比較</button></div>`
      + `${p.statsHtml()}<span class="sp"></span>${p.navHtml()}`
      + `${c.status !== 'D' ? '<button class="secondary sm" data-act="restore" title="把目前的檔案改成這個提交的版本">↶ 還原成這個版本…</button>' : ''}`
      + '<button class="ib sm" data-act="copy" title="複製提交編號">⧉</button><button class="ib sm" data-act="reload" title="重新整理">⟳</button>';
  }

  action(act) {
    if (act === 'mode-commit' || act === 'mode-working') {
      this.mode = act.slice(5);
      store.set('histMode', this.mode);
      return this.loadDiff();
    }
    if (act === 'restore') return restoreVersion(this);
    if (act === 'copy') return copyText(this.commits[this.idx].hash);
    if (act === 'reload') return this.load();
    return null;
  }

  onFileChanged() { return this.mode === 'working' ? this.loadDiff() : null; }
  saveViewState() { return null; }
  destroy() { this.el.remove(); }
}

/** 把目前的檔案改成某個提交的版本 */
async function restoreVersion(view) {
  const c = view.commits[view.idx];
  const e = view.tab.entry;
  if (!c || !guardDirty([e.file])) return;
  const ans = await td.dialog.message({
    type: 'warning',
    message: `要把「${basename(e.path)}」改成 ${c.short} 的版本嗎？`,
    detail: `${c.subject}\n${c.author}　${fmtTime(c.at)}${c.path !== e.path ? `\n（當時的路徑：${c.path}）` : ''}\n\n目前檔案的內容會被取代。只會改寫工作目錄中的這個檔案，不會修改暫存區或提交；之後可以按「復原」改回來。`,
    buttons: ['還原', '取消'], defaultId: 1, cancelId: 1,
  });
  if (ans.response !== 0) return;
  const r = await td.invoke('gitRestoreVersion', { id: st.pid, top: st.git.top, rev: c.hash, path: c.path, target: e.path });
  await afterDiskChange([e.file]);
  resultBanner(`已把 ${basename(e.path)} 還原成 ${c.short} 的版本。`, r.undoId);
}

/* ───────────── 跳到定義 ───────────── */

/** 跳轉紀錄：⌃-（Windows 為 Alt+←）回到上一個位置 */
const navHist = { back: [], fwd: [] };

function here() {
  const t = codeTab();
  if (!t || !t.file) return null;
  return { file: t.file, s: t.view.ta.selectionStart, e: t.view.ta.selectionEnd, top: t.view.el.scrollTop };
}

function pushNav() {
  const l = here();
  if (!l) return;
  const last = navHist.back[navHist.back.length - 1];
  if (last && last.file === l.file && last.s === l.s) return;
  navHist.back.push(l);
  if (navHist.back.length > 50) navHist.back.shift();
  navHist.fwd = [];
}

async function goLocation(l) {
  const t = await openFile(l.file);
  if (!t || t.unavailable) return;
  const len = t.view.ta.value.length;
  t.view.focus();
  t.view.ta.setSelectionRange(Math.min(l.s, len), Math.min(l.e, len));
  t.view.onCaret();
  t.view.el.scrollTop = l.top;
}

async function navGo(dir) {
  const from = dir < 0 ? navHist.back : navHist.fwd;
  const to = dir < 0 ? navHist.fwd : navHist.back;
  const l = from.pop();
  if (!l) { notice(dir < 0 ? '沒有上一個位置' : '沒有下一個位置'); return; }
  const cur = here();
  if (cur) to.push(cur);
  await goLocation(l).catch(fail);
}

/** 打開定義所在的檔案並選取名稱 */
async function openDefinition(d) {
  pushNav();
  const t = await openFile(d.file);
  if (!t || t.unavailable) return;
  const text = t.view.ta.value;
  const ls = C.lineStart(text, d.line);
  let s = ls + d.col - 1;
  if (text.slice(s, s + d.name.length) !== d.name) {
    // 檔案在建立索引後改過：在那一行附近找名稱
    const i = text.indexOf(d.name, ls);
    s = i >= 0 && i - ls < 400 ? i : ls;
  }
  t.view.focus();
  t.view.ta.setSelectionRange(s, s + (text.slice(s, s + d.name.length) === d.name ? d.name.length : 0));
  t.view.onCaret();
  t.view.reveal(true);
  t.view.markHit(t.view.caretLine());
}

/** 找名稱的定義：專案索引＋尚未儲存的分頁（以編輯器內容解析） */
async function findDefinitions(name, t) {
  const ci = C.symbolCaseInsensitive(t.lang);
  const same = (n) => (ci ? n.toLowerCase() === name.toLowerCase() : n === name);
  const local = [];
  const skip = [];
  const addLocal = (tab, rel) => {
    for (const s of C.symbolsIn(tab.view.text, tab.lang)) {
      if (same(s.name)) local.push({ ...s, rel, file: tab.file, family: C.symbolFamily(tab.lang) });
    }
  };
  for (const x of st.tabs) {
    if (x.kind !== 'file' || !x.file || x.unavailable || x.decompiled) continue;
    const rel = relOf(x.file);
    if (rel !== null && isDirty(x)) { skip.push(rel); addLocal(x, rel); }
  }
  // 專案外的檔案（用「開啟檔案」開的）：只找它自己
  if (t.file && relOf(t.file) === null && !t.decompiled) addLocal(t, t.file);
  let remote = { items: [] };
  if (st.pid) remote = await td.invoke('definitions', { id: st.pid, name, ci, skip });
  return [...local, ...remote.items];
}

async function goToDefinition(t = codeTab(), pos, at) {
  if (!t || t.unavailable) return;
  const ta = t.view.ta;
  const w = C.wordAt(ta.value, pos === undefined ? ta.selectionStart : pos, t.lang);
  if (!w) { notice('游標不在名稱上'); return; }
  if (!C.symbolFamily(t.lang)) notice(`${C.LANG_NAME[t.lang] || t.lang} 沒有定義規則，改用名稱比對所有語言`);
  const rel = t.file ? relOf(t.file) ?? t.file : null;
  const timer = setTimeout(() => notice(`尋找「${w.name}」的定義…（第一次會建立索引）`), 300);
  let items;
  try { items = await findDefinitions(w.name, t); } finally { clearTimeout(timer); }
  const cur = C.cursorInfo(ta.value, w.start);
  const self = rel ? { rel, line: cur.line, col: cur.col } : null;
  const hints = C.importHints(ta.value, w.name, t.lang, rel || '');
  const ranked = C.rankDefinitions(items, { rel, family: C.symbolFamily(t.lang), hints, self });
  if (!ranked.length) {
    const isSelf = items.length > 0;
    notice(isSelf ? `這裡就是「${w.name}」的定義，改為尋找所有參考` : `找不到「${w.name}」的定義，改為尋找所有參考`);
    findReferences(w.name, t);
    return;
  }
  notice('');
  if (ranked.length === 1 || (ranked[0].score === 0 && ranked[1].score > 0)) { await openDefinition(ranked[0]); return; }
  showDefPicker(w.name, ranked, at || caretPoint(t));
}

/** ⇧F12：在專案中搜尋整個字（大小寫相符；SQL 等不分大小寫的語言除外） */
function findReferences(name, t = codeTab()) {
  srch.word = true;
  srch.regex = false;
  srch.caseSens = !(t && C.symbolCaseInsensitive(t.lang));
  syncSearchForm();
  saveSearchPrefs();
  $('#sQuery').value = name;
  setSide('search');
  runSearch().catch(fail);
}

/** 游標那一行的螢幕位置（顯示候選清單用） */
function caretPoint(t) {
  const row = t.view.pre.children[t.view.caretLine()];
  const r = (row || t.view.el).getBoundingClientRect();
  return { x: r.left + 60, y: r.bottom + 2 };
}

const defPick = { list: [], sel: 0 };

function showDefPicker(name, list, at) {
  const box = $('#defPick');
  defPick.list = list.slice(0, 100);
  defPick.sel = 0;
  const head = `<div class="label">「${esc(name)}」有 ${list.length} 個定義${list.length > 100 ? '（只列出前 100 個）' : ''}　↑↓ 選擇・Enter 開啟・Esc 關閉</div>`;
  box.innerHTML = head + defPick.list.map((d, i) => `<button class="item dp${i === 0 ? ' on' : ''}" data-i="${i}" title="${esc(`${d.rel}:${d.line}`)}">`
    + `<span class="row1"><span class="kd">${esc(d.kind)}</span><span class="nm">${esc(d.name)}</span><span class="loc">${esc(basename(d.rel))}:${d.line}</span><span class="dir">${esc(dirname(d.rel))}</span></span>`
    + `<span class="pv">${esc(d.text)}</span></button>`).join('');
  box.hidden = false;
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(4, Math.min(at.x, innerWidth - r.width - 8))}px`;
  box.style.top = `${at.y + r.height > innerHeight - 8 ? Math.max(4, at.y - r.height - 24) : at.y}px`;
  box.focus();
}

function closeDefPicker(refocus = true) {
  const box = $('#defPick');
  if (box.hidden) return;
  box.hidden = true;
  const t = codeTab();
  if (refocus && t) t.view.focus();
}

function markDefPick() {
  $$('#defPick .dp').forEach((b, i) => b.classList.toggle('on', i === defPick.sel));
  const on = $('#defPick .dp.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function bindDefinitions() {
  const box = $('#defPick');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.dp');
    if (!b) return;
    closeDefPicker(false);
    openDefinition(defPick.list[Number(b.dataset.i)]).catch(fail);
  });
  box.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.dp');
    if (b && Number(b.dataset.i) !== defPick.sel) { defPick.sel = Number(b.dataset.i); markDefPick(); }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      defPick.sel = Math.max(0, Math.min(defPick.list.length - 1, defPick.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      markDefPick();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const d = defPick.list[defPick.sel];
      closeDefPicker(false);
      if (d) openDefinition(d).catch(fail);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDefPicker();
    }
  });
  box.addEventListener('focusout', (e) => { if (!box.contains(e.relatedTarget)) setTimeout(() => closeDefPicker(false), 0); });
  // 按住 ⌘（Windows 為 Ctrl）時游標變成手指，點名稱就跳到定義
  const modKey = IS_MAC ? 'Meta' : 'Control';
  addEventListener('keydown', (e) => { if (e.key === modKey) document.body.classList.add('mod-down'); });
  addEventListener('keyup', (e) => { if (e.key === modKey) document.body.classList.remove('mod-down'); });
  addEventListener('blur', () => document.body.classList.remove('mod-down'));
  $('#stage').addEventListener('click', (e) => {
    if (!mod(e) || e.shiftKey || e.altKey || e.target.tagName !== 'TEXTAREA') return;
    const t = codeTab();
    if (!t || e.target !== t.view.ta) return;
    e.preventDefault();
    const pos = t.view.ta.selectionStart;
    t.view.ta.setSelectionRange(pos, pos);
    goToDefinition(t, pos, { x: e.clientX, y: e.clientY + 14 }).catch(fail);
  });
}

/* ───────────── 鍵盤快捷鍵 ───────────── */

/**
 * 可以修改的快捷鍵：mac／win 是預設值（'Mod' 在 macOS 是 ⌘、其他平台是 Ctrl）。
 * editor: true 的功能只在游標位於編輯器時有效。
 */
const KEY_COMMANDS = [
  { id: 'save', group: '檔案', title: '儲存', mac: ['Mod+S'], win: ['Mod+S'], run: () => save(activeTab()) },
  { id: 'saveAs', group: '檔案', title: '另存新檔…', mac: ['Mod+Alt+S'], win: ['Mod+Alt+S'], run: () => save(activeTab(), true) },
  { id: 'newFile', group: '檔案', title: '新增未命名檔案', mac: ['Mod+N'], win: ['Mod+N'], run: () => newUntitled() },
  { id: 'openFile', group: '檔案', title: '開啟檔案…', mac: ['Mod+O'], win: ['Mod+O'], run: () => openFileDialog() },
  { id: 'quickOpen', group: '檔案', title: '搜尋檔名', mac: ['Mod+P'], win: ['Mod+P'], run: () => { setSide('files'); $('#filter').focus(); $('#filter').select(); } },
  { id: 'find', group: '尋找與取代', title: '尋找', mac: ['Mod+F'], win: ['Mod+F'], run: () => openFind(false) },
  { id: 'replace', group: '尋找與取代', title: '取代', mac: ['Mod+Alt+F'], win: ['Mod+H', 'Mod+Alt+F'], run: () => openFind(true) },
  { id: 'findNext', group: '尋找與取代', title: '下一個符合的項目', mac: ['Mod+G', 'F3'], win: ['F3'], run: () => findStep(1) },
  { id: 'findPrev', group: '尋找與取代', title: '上一個符合的項目', mac: ['Mod+Shift+G', 'Shift+F3'], win: ['Shift+F3'], run: () => findStep(-1) },
  { id: 'searchProject', group: '尋找與取代', title: '在專案中搜尋', mac: ['Mod+Shift+F'], win: ['Mod+Shift+F'], run: () => openSearch(false) },
  { id: 'replaceProject', group: '尋找與取代', title: '在專案中取代', mac: ['Mod+Shift+H'], win: ['Mod+Shift+H'], run: () => openSearch(true) },
  { id: 'gotoLine', group: '前往', title: '前往行…', mac: ['Ctrl+G', 'Mod+L'], win: ['Mod+G', 'Mod+L'], run: () => gotoLine() },
  { id: 'definition', group: '前往', title: '跳到定義', mac: ['F12'], win: ['F12'], run: () => goToDefinition() },
  { id: 'references', group: '前往', title: '尋找所有參考', mac: ['Shift+F12'], win: ['Shift+F12'], run: () => referencesAtCaret() },
  { id: 'navBack', group: '前往', title: '回到上一個位置', mac: ['Ctrl+-'], win: ['Alt+Left'], run: () => navGo(-1) },
  { id: 'navForward', group: '前往', title: '前往下一個位置', mac: ['Ctrl+Shift+-'], win: ['Alt+Right'], run: () => navGo(1) },
  { id: 'toggleComment', group: '編輯', title: '切換行註解', mac: ['Mod+/'], win: ['Mod+/'], editor: true, run: () => toggleCommentAtCaret() },
  { id: 'wordWrap', group: '編輯', title: '切換自動換行', mac: ['Alt+Z'], win: ['Alt+Z'], run: () => td.settings.update('codeEditor.wordWrap', !setting('wordWrap', false)) },
  { id: 'keybindings', group: '其他', title: '鍵盤快捷鍵', mac: ['Mod+K'], win: ['Mod+K'], run: () => openKeysPanel() },
];
const KEY_BY_ID = Object.fromEntries(KEY_COMMANDS.map((c) => [c.id, c]));

/** 不能修改的按鍵（只在面板中列出說明） */
const FIXED_KEYS = [
  ['Tab／Shift+Tab', '縮排／取消縮排（有選取多行時整段）'],
  ['Enter', '換行並延續縮排'],
  [`${IS_MAC ? '⌘' : 'Ctrl'}＋點擊名稱`, '跳到定義'],
  ['Esc', '關閉尋找列、選單、定義清單'],
  ['Enter／Shift+Enter', '尋找列：下一個／上一個'],
  [`Enter／${IS_MAC ? '⌘' : 'Ctrl'}+Enter`, '尋找列的取代框：取代一個／全部取代'],
  ['↑↓、Enter、空白鍵、Delete', '專案搜尋結果：瀏覽、開啟、勾選、從清單移除'],
  ['↑↓、Enter', '定義清單：選擇、開啟'],
];

const keys = { overrides: {}, map: null, rec: null };

const defaultsOf = (c) => (IS_MAC ? c.mac : c.win).map((k) => C.normalizeCombo(k, IS_MAC));
const keysOf = (id) => (keys.map && keys.map.keys.get(id)) || [];
/** 功能目前的第一組快捷鍵（顯示用）；沒有時回傳空字串 */
const keyLabel = (id) => (keysOf(id)[0] ? C.comboLabel(keysOf(id)[0], IS_MAC) : '');

function loadKeymap(overrides) {
  keys.overrides = overrides && typeof overrides === 'object' ? overrides : {};
  keys.map = C.resolveKeymap(KEY_COMMANDS, keys.overrides, IS_MAC);
  refreshKeyLabels();
}

/** 畫面上提到快捷鍵的地方：歡迎畫面、選單、提示文字 */
function refreshKeyLabels() {
  for (const el of $$('[data-cmd]')) el.textContent = keyLabel(el.dataset.cmd);
  $('#filter').placeholder = keyLabel('quickOpen') ? `搜尋檔名（${keyLabel('quickOpen')}）` : '搜尋檔名';
  $('#sQuery').placeholder = keyLabel('searchProject') ? `在專案中搜尋（${keyLabel('searchProject')}）` : '在專案中搜尋';
  $('#findNext').title = `下一個（Enter${keyLabel('findNext') ? `、${keyLabel('findNext')}` : ''}）`;
  $('#findPrev').title = `上一個（Shift+Enter${keyLabel('findPrev') ? `、${keyLabel('findPrev')}` : ''}）`;
  $('#stKeys').title = `鍵盤快捷鍵${keyLabel('keybindings') ? `（${keyLabel('keybindings')}）` : ''}`;
  const shown = [['quickOpen', 'save'], ['find', 'gotoLine'], ['toggleComment', null], ['searchProject', 'replaceProject'], ['definition', 'navBack'], ['keybindings', null]];
  const cell = (id) => (id ? `<td>${esc(keyLabel(id) || '—')}</td><td>${esc(KEY_BY_ID[id].title)}</td>` : '<td></td><td></td>');
  $('#welcomeKeys').innerHTML = shown.map(([a, b]) => `<tr>${cell(a)}${b ? cell(b) : a === 'toggleComment' ? `<td>${IS_MAC ? '⇥ / ⇧⇥' : 'Tab / Shift+Tab'}</td><td>縮排／取消縮排</td>` : cell(null)}</tr>`).join('');
}

/** 全域快捷鍵：找到對應的功能就執行 */
function dispatchKey(e) {
  if (e.isComposing || e.keyCode === 229) return false;
  const combo = C.comboFromEvent(e);
  const id = combo && keys.map && keys.map.index.get(combo);
  if (!id) return false;
  const c = KEY_BY_ID[id];
  if (c.editor) {
    const t = codeTab();
    if (!t || document.activeElement !== t.view.ta) return false;
  }
  e.preventDefault();
  Promise.resolve(c.run()).catch(fail);
  return true;
}

function toggleCommentAtCaret() {
  const t = codeTab();
  if (!t || t.view.ta.readOnly) return;
  const ta = t.view.ta;
  const tok = C.lineComment(t.lang);
  if (!tok) { notice(`${C.LANG_NAME[t.lang] || t.lang} 沒有行註解`); return; }
  applyEdit(t.view, C.toggleComment(ta.value, ta.selectionStart, ta.selectionEnd, tok));
}

function referencesAtCaret() {
  const t = codeTab();
  if (!t) return;
  const w = C.wordAt(t.view.ta.value, t.view.ta.selectionStart, t.lang);
  if (w) findReferences(w.name, t); else notice('游標不在名稱上');
}

/* 面板 */

function openKeysPanel() {
  closeMenus();
  $('#keysPanel').hidden = false;
  $('#keysFilter').value = '';
  renderKeysPanel();
  $('#keysFilter').focus();
}

function closeKeysPanel() {
  stopRecording();
  $('#keysPanel').hidden = true;
  const t = codeTab();
  if (t) t.view.focus();
}

const kbd = (combo) => `<kbd>${esc(C.comboLabel(combo, IS_MAC))}</kbd>`;

function renderKeysPanel() {
  const q = $('#keysFilter').value.trim().toLowerCase();
  const byKey = keys.filterCombo || null;
  const match = (c) => {
    if (byKey) return keysOf(c.id).includes(byKey);
    if (!q) return true;
    return c.title.toLowerCase().includes(q) || c.group.includes(q) || keysOf(c.id).some((k) => C.comboLabel(k, IS_MAC).toLowerCase().includes(q) || k.toLowerCase().includes(q));
  };
  const rows = [];
  let group = '';
  for (const c of KEY_COMMANDS.filter(match)) {
    if (c.group !== group) { group = c.group; rows.push(`<div class="kgrp">${esc(group)}</div>`); }
    const list = keysOf(c.id);
    const custom = keys.map.custom.has(c.id) && !C.sameKeys(list, defaultsOf(c));
    const rec = keys.rec && keys.rec.id === c.id;
    const chips = rec
      ? `<span class="krec">${esc(keys.rec.msg || '請按下新的組合鍵…（Esc 取消）')}</span>`
      : list.length ? list.map((k) => `<span class="kchip">${kbd(k)}<button class="kx" data-kact="remove" data-key="${esc(k)}" title="移除這組快捷鍵">✕</button></span>`).join('') : '<span class="knone">（未設定）</span>';
    rows.push(`<div class="krow${custom ? ' custom' : ''}${rec ? ' rec' : ''}" data-id="${c.id}">`
      + `<span class="kt">${esc(c.title)}${c.editor ? '<span class="kwhen">編輯器中</span>' : ''}</span>`
      + `<span class="kk">${chips}</span>`
      + `<span class="ka"><button class="ib sm" data-kact="edit" title="修改（改成一組新的快捷鍵）">✎</button><button class="ib sm" data-kact="add" title="再加一組快捷鍵">＋</button>`
      + `${custom ? '<button class="ib sm" data-kact="reset" title="還原預設">↺</button>' : ''}</span>`
      + `${custom ? `<span class="kdef">預設：${defaultsOf(c).map((k) => esc(C.comboLabel(k, IS_MAC))).join('、') || '（未設定）'}</span>` : ''}</div>`);
  }
  if (!byKey && !q) {
    rows.push('<div class="kgrp">固定的按鍵（不能修改）</div>');
    for (const [k, d] of FIXED_KEYS) rows.push(`<div class="krow fixed"><span class="kt">${esc(d)}</span><span class="kk"><kbd>${esc(k)}</kbd></span></div>`);
  }
  $('#keysBody').innerHTML = rows.join('') || `<div class="empty-msg">${byKey ? `${esc(C.comboLabel(byKey, IS_MAC))} 沒有指定給任何功能` : '找不到符合的功能'}</div>`;
  const n = Object.keys(keys.overrides).length;
  $('#keysResetAll').disabled = !n;
  $('#keysByKey').classList.toggle('on', !!byKey || (keys.rec && keys.rec.id === '*'));
  $('#keysByKey').textContent = byKey ? `按鍵：${C.comboLabel(byKey, IS_MAC)} ✕` : keys.rec && keys.rec.id === '*' ? '請按下要查的按鍵…' : '⌨ 以按鍵查詢';
  if (keys.map.conflicts.length) {
    const [k, a, b] = keys.map.conflicts[0];
    $('#keysNote').textContent = `注意：${C.comboLabel(k, IS_MAC)} 同時指定給「${KEY_BY_ID[a].title}」與「${KEY_BY_ID[b].title}」，目前由「${KEY_BY_ID[a].title}」使用`;
  } else {
    $('#keysNote').textContent = `修改後立即生效並自動儲存。ToolDock 選單使用的按鍵（例如 ${IS_MAC ? '⌘W、⇧⌘S、⌘H' : 'Ctrl+W、Ctrl+Shift+S'}）不能使用。`;
  }
}

/** 開始錄製：mode = 'edit'（取代）| 'add'（新增）；id = '*' 表示以按鍵查詢 */
function startRecording(id, mode) {
  stopRecording();
  keys.rec = { id, mode, msg: '' };
  addEventListener('keydown', onRecordKey, true);
  renderKeysPanel();
}

function stopRecording() {
  if (!keys.rec) return;
  keys.rec = null;
  removeEventListener('keydown', onRecordKey, true);
}

function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.isComposing) return;
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { stopRecording(); renderKeysPanel(); return; }
  const combo = C.comboFromEvent(e);
  if (!combo) return; // 只按了修飾鍵，繼續等
  const rec = keys.rec;
  if (rec.id === '*') { stopRecording(); keys.filterCombo = combo; renderKeysPanel(); return; }
  const why = C.comboProblem(combo, IS_MAC);
  if (why) { rec.msg = `${C.comboLabel(combo, IS_MAC)}：${why}。請改按其他組合鍵（Esc 取消）`; renderKeysPanel(); return; }
  stopRecording();
  assignKey(rec.id, combo, rec.mode).catch(fail);
}

/** 指定快捷鍵；被其他功能使用時先確認 */
async function assignKey(id, combo, mode) {
  const owner = keys.map.index.get(combo);
  if (owner && owner !== id) {
    const r = await td.dialog.message({
      type: 'question',
      message: `${C.comboLabel(combo, IS_MAC)} 已經是「${KEY_BY_ID[owner].title}」的快捷鍵`,
      detail: `要改給「${KEY_BY_ID[id].title}」嗎？「${KEY_BY_ID[owner].title}」會移除這組快捷鍵。`,
      buttons: ['改用', '取消'], defaultId: 0, cancelId: 1,
    });
    if (r.response !== 0) { renderKeysPanel(); return; }
    setKeys(owner, keysOf(owner).filter((k) => k !== combo));
  }
  const cur = keysOf(id);
  setKeys(id, mode === 'add' ? [...cur.filter((k) => k !== combo), combo] : [combo]);
  await saveKeymap();
  notice(`「${KEY_BY_ID[id].title}」：${C.comboLabel(combo, IS_MAC)}`);
}

/** 設定某個功能的快捷鍵（和預設相同時移除自訂） */
function setKeys(id, list) {
  if (C.sameKeys(list, defaultsOf(KEY_BY_ID[id]))) delete keys.overrides[id];
  else keys.overrides[id] = list;
  keys.map = C.resolveKeymap(KEY_COMMANDS, keys.overrides, IS_MAC);
}

async function saveKeymap() {
  refreshKeyLabels();
  if (!$('#keysPanel').hidden) renderKeysPanel();
  try { await td.invoke('setKeybindings', keys.overrides); } catch (err) { fail(err); }
}

function bindKeysPanel() {
  $('#keysClose').onclick = closeKeysPanel;
  $('#keysPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'keysPanel') closeKeysPanel(); });
  $('#keysFilter').addEventListener('input', () => { keys.filterCombo = null; renderKeysPanel(); });
  $('#keysByKey').onclick = () => {
    if (keys.filterCombo || (keys.rec && keys.rec.id === '*')) { stopRecording(); keys.filterCombo = null; renderKeysPanel(); return; }
    $('#keysFilter').value = '';
    startRecording('*');
  };
  $('#keysResetAll').onclick = async () => {
    const r = await td.dialog.message({ type: 'question', message: '要把所有快捷鍵還原成預設嗎？', buttons: ['全部還原', '取消'], defaultId: 1, cancelId: 1 });
    if (r.response !== 0) return;
    keys.overrides = {};
    keys.map = C.resolveKeymap(KEY_COMMANDS, keys.overrides, IS_MAC);
    await saveKeymap();
    notice('已還原所有快捷鍵');
  };
  $('#keysBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kact]');
    const row = e.target.closest('.krow[data-id]');
    if (!b || !row) return;
    const id = row.dataset.id;
    const act = b.dataset.kact;
    if (act === 'edit' || act === 'add') startRecording(id, act);
    else if (act === 'remove') { setKeys(id, keysOf(id).filter((k) => k !== b.dataset.key)); saveKeymap(); }
    else if (act === 'reset') { setKeys(id, defaultsOf(KEY_BY_ID[id])); saveKeymap(); }
  });
  $('#keysBody').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.krow[data-id]');
    if (row && !e.target.closest('[data-kact]')) startRecording(row.dataset.id, 'edit');
  });
}

/* ───────────── 快捷鍵與事件 ───────────── */

async function gotoLine() {
  const t = codeTab();
  if (!t) return;
  const max = (t.view.text.match(/\n/g) || []).length + 1;
  const v = await ask(`前往行（1–${max.toLocaleString()}，可用「行:欄」）`, '');
  if (!v) { t.view.focus(); return; }
  const m = v.trim().match(/^(\d+)(?:[:,](\d+))?$/);
  if (!m) { notice('請輸入行號'); return; }
  t.view.gotoLine(Math.max(1, Math.min(max, Number(m[1]))), Number(m[2] || 1));
}

function onKeyDown(e) {
  if (!$('#modal').hidden || keys.rec) return;
  if (!$('#keysPanel').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeKeysPanel(); }
    return;
  }
  if (e.key === 'Escape') {
    closeMenus();
    if (st.find.open) { e.preventDefault(); closeFind(); }
    return;
  }
  dispatchKey(e);
}

/** 側欄寬度拖曳 */
function initSplitter() {
  const sp = $('#sideSplit');
  const setW = (w) => document.documentElement.style.setProperty('--side-w', `${Math.max(160, Math.min(innerWidth * 0.6, w))}px`);
  setW(store.get('sideW', 260));
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sp.classList.add('drag');
    const move = (ev) => setW(ev.clientX);
    const up = (ev) => {
      sp.classList.remove('drag');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      store.set('sideW', Math.max(160, ev.clientX));
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

/** 新增檔案的位置：選取的是資料夾就放在裡面，否則放在選取檔案的資料夾 */
function selDir() {
  const sel = st.tree.sel || '';
  if (!sel) return '';
  const row = $(`#tree .row[data-rel="${CSS.escape(sel)}"]`);
  return row && row.dataset.dir ? sel : dirname(sel);
}

const ACTIONS = {
  addProject: () => addProject(),
  renameProject: () => renameProject(),
  removeProject: () => removeProject(),
  revealProject: () => project() && td.invoke('reveal', project().root),
  openInGit: () => openInFlow(),
  newFile: () => newUntitled(),
  openFile: () => openFileDialog(),
  newFileIn: () => st.pid && createIn(selDir(), false),
  newFolderIn: () => st.pid && createIn(selDir(), true),
  refresh: () => refreshAll(),
  refreshGit: () => refreshGit(),
  collapse: () => { st.tree.expanded.clear(); renderTree(); saveStateSoon(); },
  keybindings: () => openKeysPanel(),
};

async function runCommand(cmd) {
  if (cmd && typeof cmd === 'object') { if (cmd.command === 'openProject') await openProjectCommand(cmd); return; }
  if (cmd === 'addProject') await addProject();
  else if (cmd === 'openFile') await openFileDialog();
  else if (cmd === 'showChanges') { setSide('git'); await refreshGit(); }
  else if (cmd === 'search') openSearch(false);
  else if (cmd === 'keybindings') openKeysPanel();
}

async function drainPending() {
  const c = await td.invoke('takePending');
  if (c) await runCommand(c);
}

let focusTimer = 0;
function onWindowFocus() {
  if (Date.now() - focusTimer < 1500) return;
  focusTimer = Date.now();
  const t = activeTab();
  if (t) checkExternal(t);
  refreshGitSoon(200);
}

function bind() {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu, .menu-wrap')) closeMenus(); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a && ACTIONS[a.dataset.act] && !a.closest('.dhead')) { closeMenus(); Promise.resolve(ACTIONS[a.dataset.act]()).catch(fail); return; }
    const r = e.target.closest('[data-recent]');
    if (r) { closeMenus(); openFile(r.dataset.recent).catch(fail); }
  });

  $('#projSel').onchange = (e) => switchProject(e.target.value).catch(fail);
  $('#addProjBtn').onclick = () => addProject().catch(fail);
  $('#welcomeAdd').onclick = () => addProject().catch(fail);
  $('#welcomeOpen').onclick = () => openFileDialog().catch(fail);
  $('#projMenuBtn').onclick = () => {
    const m = $('#projMenu');
    const show = m.hidden;
    closeMenus();
    m.hidden = !show;
    if (show) refreshTargets();
  };
  for (const b of $$('#sideTabs button')) b.onclick = () => setSide(b.dataset.side);

  const tree = $('#tree');
  tree.addEventListener('click', (e) => onTreeClick(e, false).catch(fail));
  tree.addEventListener('dblclick', (e) => onTreeClick(e, true).catch(fail));
  tree.addEventListener('contextmenu', onTreeContext);
  tree.addEventListener('keydown', (e) => {
    const rows = $$('.row', tree);
    const i = rows.findIndex((r) => r.classList.contains('sel'));
    const cur = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { st.tree.sel = n.dataset.rel; markTreeSel(); }
    } else if (cur && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && cur.dataset.dir) {
      e.preventDefault();
      toggleDir(cur.dataset.rel, e.key === 'ArrowRight').catch(fail);
    } else if (cur && e.key === 'ArrowLeft') {
      const p = dirname(cur.dataset.rel);
      if (p) { st.tree.sel = p; markTreeSel(); }
    } else if (cur && e.key === 'Enter') {
      e.preventDefault();
      if (cur.dataset.dir) toggleDir(cur.dataset.rel).catch(fail);
      else openFile(absOf(cur.dataset.rel)).catch(fail);
    } else if (cur && e.key === 'F2') {
      renameEntry(cur.dataset.rel);
    }
  });

  const filter = $('#filter');
  let ft = null;
  filter.addEventListener('input', () => { filterSel = 0; clearTimeout(ft); ft = setTimeout(() => renderFilter(), 80); });
  filter.addEventListener('keydown', onFilterKey);

  const changes = $('#changes');
  changes.addEventListener('click', (e) => {
    const h = e.target.closest('.grp-h');
    if (h && e.target.closest('[data-rvall]')) { restoreEntries(st.git[h.dataset.grp]).catch(fail); return; }
    if (h) { const g = h.dataset.grp; if (st.gitCollapsed.has(g)) st.gitCollapsed.delete(g); else st.gitCollapsed.add(g); renderGit(); return; }
    const pa = e.target.closest('[data-pact]');
    if (pa) { if (pa.dataset.pact === 'restore') restorePicked().catch(fail); else clearPicks(); return; }
    const row = e.target.closest('.row[data-area]');
    if (row && e.target.closest('[data-rv]')) { restoreEntries([gitEntry(row)]).catch(fail); return; }
    if (row && e.target.closest('.pk')) { togglePick(row); return; }
    if (row && (IS_MAC ? e.metaKey : e.ctrlKey)) { togglePick(row); return; }
    if (row && e.shiftKey) { pickRange(row); return; }
    if (row) {
      st.gitAnchor = PICK_AREAS.has(row.dataset.area) ? rowKey(row) : null;
      if (st.gitPick.size) { st.gitPick.clear(); renderGit(); }
      openDiff(gitEntry(row)).catch(fail);
    }
  });
  // ⇧ 點選不要選到文字
  changes.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('.row[data-area]')) e.preventDefault(); });
  changes.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && clearPicks()) { e.preventDefault(); e.stopPropagation(); return; }
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); pickAll(); }
  });
  changes.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-area]');
    if (!row || e.target.closest('[data-rv], .pk') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const en = gitEntry(row);
    if (en.status === 'D') openDiff(en, { preview: false }).catch(fail);
    else openFile(en.file).catch(fail);
  });
  changes.addEventListener('contextmenu', (e) => {
    const gh = e.target.closest('.grp-h');
    if (gh && (gh.dataset.grp === 'unstaged' || gh.dataset.grp === 'untracked')) {
      const list = st.git[gh.dataset.grp];
      contextMenu(e, [[gh.dataset.grp === 'untracked' ? `刪除全部未追蹤的檔案（${list.length}）…` : `捨棄全部變更（${list.length}）…`, () => restoreEntries(list)]]);
      return;
    }
    const row = e.target.closest('.row[data-area]');
    if (!row) return;
    const en = gitEntry(row);
    const picked = PICK_AREAS.has(row.dataset.area) && st.gitPick.has(rowKey(row));
    if (picked && st.gitPick.size > 1) {
      contextMenu(e, [[`還原所選的 ${st.gitPick.size} 個檔案…`, () => restorePicked()], ['取消選取', () => clearPicks()]]);
      return;
    }
    const items = [['查看差異', () => openDiff(en, { preview: false })]];
    if (PICK_AREAS.has(row.dataset.area)) items.push([picked ? '取消選取' : '選取（可多選後一次還原）', () => togglePick(row)]);
    if (en.status !== 'D') items.push(['開啟檔案', () => openFile(en.file)]);
    if (!en.rel.startsWith('..') && en.status !== 'D') items.push(['在檔案樹中顯示', () => revealInTree(en.rel)]);
    if (en.area !== 'untracked' && en.status !== 'A') items.push(['檔案歷史', () => openHistory(en.file)]);
    if (en.area === 'unstaged') items.push('-', ['捨棄變更（改回暫存區的版本）…', () => restoreEntries([en])]);
    else if (en.area === 'untracked') items.push('-', ['刪除未追蹤的檔案…', () => restoreEntries([en])]);
    items.push('-', ['複製路徑', () => copyText(en.file)], ['複製相對路徑', () => copyText(en.rel)]);
    if (en.status !== 'D') items.push([IS_MAC ? '在 Finder 中顯示' : '在檔案總管中顯示', () => td.invoke('reveal', en.file)]);
    contextMenu(e, items);
  });

  const tabs = $('#tabs');
  tabs.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    if (e.button === 1) { e.preventDefault(); closeTab(Number(el.dataset.id)); return; }
    if (e.button === 0 && !e.target.closest('.x')) activate(Number(el.dataset.id));
  });
  tabs.addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (x) closeTab(Number(x.closest('.tab').dataset.id));
  });
  tabs.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.tab');
    const t = el && st.tabs.find((x) => x.id === Number(el.dataset.id));
    if (t) pinTab(t);
  });
  tabs.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    const id = Number(el.dataset.id);
    const t = st.tabs.find((x) => x.id === id);
    const items = [['關閉', () => closeTab(id)], ['關閉其他分頁', () => closeAll(id)], ['全部關閉', () => closeAll()]];
    if (t.file) {
      const rel = relOf(t.file);
      items.push('-', ['複製路徑', () => copyText(t.file)]);
      if (rel !== null) items.push(['在檔案樹中顯示', () => revealInTree(rel)]);
      if (rel !== null && st.gitMap.has(rel)) items.push(['查看 Git 差異', () => openDiffForRel(rel)]);
      if (st.git && st.git.repo && repoRel(t.file) !== null && !isUntracked(rel)) items.push(['檔案歷史', () => openHistory(t.file)]);
      const rv = restorableEntry(rel);
      if (rv) items.push([rv.area === 'untracked' ? '刪除未追蹤的檔案…' : '還原 Git 變更…', () => restoreEntries([rv])]);
    }
    if (t.kind === 'file' && !t.unavailable) items.push('-', ['另存新檔…', () => save(t, true)]);
    contextMenu(e, items);
  });

  // 尋找列
  $('#findInput').addEventListener('input', () => {
    const t = codeTab();
    if (!t) return;
    // 邊打字邊找：從選取的開頭往後找
    const ta = t.view.ta;
    ta.setSelectionRange(ta.selectionStart, ta.selectionStart);
    findStep(1);
  });
  $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } });
  $('#replaceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (mod(e)) replaceAll(); else replaceOne(); } });
  $('#findNext').onclick = () => findStep(1);
  $('#findPrev').onclick = () => findStep(-1);
  $('#findClose').onclick = closeFind;
  $('#replaceOne').onclick = replaceOne;
  $('#replaceAll').onclick = replaceAll;
  $('#findCase').onclick = () => { st.find.caseSens = !st.find.caseSens; $('#findCase').classList.toggle('on', st.find.caseSens); refreshFind(); };
  $('#findRegex').onclick = () => { st.find.regex = !st.find.regex; $('#findRegex').classList.toggle('on', st.find.regex); refreshFind(); };

  // 狀態列
  $('#stLang').innerHTML = C.LANGS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  $('#stLang').onchange = (e) => { const t = codeTab(); if (t) { t.langManual = true; t.view.setLang(e.target.value); } };
  $('#stEol').onclick = () => {
    const t = codeTab();
    if (!t || t.readOnly) return;
    t.eol = t.eol === '\r\n' ? '\n' : '\r\n';
    t.savedText = null; // 換行字元改變也算修改
    updateTab(t);
    updateStatusBar();
    notice(`存檔時會使用 ${t.eol === '\r\n' ? 'CRLF' : 'LF'}`);
  };
  $('#stWrap').onclick = () => td.settings.update('codeEditor.wordWrap', !setting('wordWrap', false)).catch(fail);
  $('#stIndent').onclick = () => td.settings.update('codeEditor.insertSpaces', !setting('insertSpaces', true)).catch(fail);
  $('#stKeys').onclick = () => openKeysPanel();

  addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onWindowFocus(); });
  addEventListener('beforeunload', () => { saveState(); });

  td.on('command', () => drainPending().catch(fail));
  td.on('settingsChanged', ({ settings }) => {
    st.info.settings = settings;
    applySettings();
    if (/exclude/.test(Object.keys(settings).join())) { st.fileList = null; }
  });
}
const mod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

async function init() {
  st.diffMode = store.get('diffMode', 'sbs');
  initSplitter();
  bind();
  bindSearch();
  bindDefinitions();
  bindKeysPanel();
  loadSearchPrefs();
  st.info = await td.invoke('info');
  loadKeymap(st.info.keybindings);
  st.projects = st.info.projects;
  applySettings();
  renderRecent();
  renderGit();
  const last = st.projects.find((p) => p.id === st.info.lastProject) ? st.info.lastProject : (st.projects[0] && st.projects[0].id);
  if (last) await switchProject(last, last === st.info.lastProject ? st.info.state : undefined);
  else { renderProjects(); renderTree(); }
  renderTabs();
  updateStatusBar();
  refreshTargets();
  await drainPending();
}

init().catch((err) => { console.error(err); fail(err); });
