'use strict';
/* 程式碼編輯器畫面：專案、檔案樹、多分頁編輯（高亮）、Git 異動清單與差異比對 */
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
  gitMap: new Map(), // 專案相對路徑 → 狀態字母
  gitDirs: new Map(), // 有異動的資料夾 → 狀態字母
  side: 'files',
  diffMode: 'sbs',
  find: { open: false, caseSens: false, regex: false },
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
  } else if (mod && e.key === '/') {
    e.preventDefault();
    if (ta.readOnly) return;
    const tok = C.lineComment(view.tab.lang);
    if (!tok) { notice(`${C.LANG_NAME[view.tab.lang] || view.tab.lang} 沒有行註解`); return; }
    applyEdit(view, C.toggleComment(ta.value, ta.selectionStart, ta.selectionEnd, tok));
  } else if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    requestAnimationFrame(() => view.onCaret(true));
  }
}

/* ───────────── 分頁 ───────────── */

const activeTab = () => st.tabs.find((t) => t.id === st.active) || null;
const isDirty = (t) => t.kind === 'file' && !t.unavailable && t.view.text !== t.savedText;

function tabIcon(t) {
  if (t.kind === 'diff') return '±';
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

/** 開啟檔案；preview 時取代目前的預覽分頁（沒有修改過的才會被取代） */
async function openFile(file, { preview = false, line, col } = {}) {
  let t = st.tabs.find((x) => x.kind === 'file' && x.file === file);
  if (t) {
    if (!preview && t.preview) pinTab(t);
    activate(t.id);
    if (line) t.view.gotoLine(line, col);
    return t;
  }
  const doc = await td.invoke('read', file);
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
  if (!t.langManual) t.lang = C.langFor(t.name);
  t.view.tab.lang = t.lang;
  t.view.setReadOnly(t.readOnly);
  t.view.setText(doc.text);
  if (t.readOnly) notice(`${t.name} 以 ${t.encoding.toUpperCase()} 開啟，為唯讀`);
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
  if (t.readOnly) { notice(`${t.encoding.toUpperCase()} 編碼的檔案為唯讀，請另存新檔（會存成 UTF-8）`); if (!as) return false; }
  let file = t.file;
  if (!file || as) {
    const p = project();
    const r = await td.dialog.save({ title: '另存新檔', defaultPath: t.file || (p ? `${p.root}${st.info.sep}${t.name}` : t.name) });
    if (r.canceled || !r.filePath) return false;
    file = r.filePath;
  }
  const text = t.view.text;
  try {
    const r = await td.invoke('write', { file, text, eol: t.eol, bom: t.bom });
    const renamed = file !== t.file;
    Object.assign(t, { file, name: r.name, title: file, mtime: r.mtime, savedText: text, preview: false, readOnly: false, encoding: 'utf8' });
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
    for (const d of st.tabs) if (d.kind === 'diff' && d.entry.file === file) d.view.load();
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
      fillDoc(t, await td.invoke('read', t.file));
      t.view.restoreViewState(vs);
      notice(`${t.name} 已在外部修改，已重新載入`);
      return;
    }
    if (t.id !== st.active) return;
    banner(`「${t.name}」已在外部修改，但這裡也有尚未儲存的變更。`, [
      ['重新載入（放棄這裡的變更）', async () => { fillDoc(t, await td.invoke('read', t.file)); renderTabs(); }],
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
  $('#stEnc').textContent = isFile ? (t.encoding === 'utf8' ? (t.bom ? 'UTF-8 BOM' : 'UTF-8') : `${t.encoding.toUpperCase()}（唯讀）`) : '';
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
  py: '🐍', java: '☕', cs: '#️⃣', go: '🐹', rs: '🦀', rb: '💎', php: '🐘', sql: '🗃', sh: '🐚', bat: '🐚', ps1: '🐚', xml: '📰', yml: '⚙️', yaml: '⚙️',
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
  if (items.length) items.push('-');
  items.push(['新增檔案…', () => createIn(dir, false)], ['新增資料夾…', () => createIn(dir, true)]);
  if (row) items.push(['重新命名…', () => renameEntry(rel)]);
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
    box.innerHTML = `<div class="empty-msg">${esc(g.message || '這個專案不是 Git 儲存庫')}<br><button class="secondary sm" data-act="refreshGit">重新檢查</button></div>`;
    count.hidden = true;
    return;
  }
  const total = GIT_GROUPS.reduce((n, [k]) => n + g[k].length, 0);
  count.hidden = !total;
  count.textContent = total > 999 ? '999+' : String(total);
  const ab = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  head.innerHTML = `<div class="br"><span>⎇</span><span class="name" title="${esc(g.upstream ? `追蹤 ${g.upstream}` : '')}">${esc(g.branch || '（未知分支）')}</span>`
    + `${ab ? `<span class="ab" title="領先 ${g.ahead}、落後 ${g.behind} 個提交">${ab}</span>` : ''}<button class="ib sm" data-act="refreshGit" title="重新整理">⟳</button></div>`
    + `<div class="head" title="${esc(g.head)}">${g.noCommits ? '尚未有任何提交' : esc(g.head)}</div>`;
  if (!total) { box.innerHTML = '<div class="empty-msg">沒有異動，工作目錄是乾淨的 ✓</div>'; return; }
  const rows = [];
  for (const [area, title] of GIT_GROUPS) {
    const list = g[area];
    if (!list.length) continue;
    const closed = st.gitCollapsed.has(area);
    rows.push(`<div class="grp-h" data-grp="${area}"><span class="tw">${closed ? '▸' : '▾'}</span>${title}<span class="n">${list.length}</span></div>`);
    if (closed) continue;
    list.forEach((e, i) => {
      const name = basename(e.rel);
      const dir = dirname(e.rel);
      const sel = activeDiffKey() === `${area}:${e.path}` ? ' sel' : '';
      rows.push(`<div class="row${sel}" data-area="${area}" data-i="${i}" title="${esc(`${e.rel}（${e.label}${e.orig ? `，原為 ${e.orig}` : ''}）`)}" style="padding-left:20px">`
        + `<span class="ic">${iconFor(name)}</span><span class="nm g-${esc(e.status)}">${esc(name)}</span><span class="dir">${esc(dir)}</span>`
        + `<span class="gs g-${esc(e.status)}">${e.status === '?' ? 'U' : esc(e.status)}</span></div>`);
    });
  }
  box.innerHTML = rows.join('');
}

const activeDiffKey = () => { const t = activeTab(); return t && t.kind === 'diff' ? `${t.entry.area}:${t.entry.path}` : ''; };
const gitEntry = (row) => st.git[row.dataset.area][Number(row.dataset.i)];

function setSide(side) {
  st.side = side;
  for (const b of $$('#sideTabs button')) b.classList.toggle('on', b.dataset.side === side);
  $('#filesPane').hidden = side !== 'files';
  $('#gitPane').hidden = side !== 'git';
  if (side === 'git' && !st.git) refreshGit();
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

class DiffView {
  constructor(tab) {
    this.tab = tab;
    this.expanded = new Set();
    this.el = document.createElement('div');
    this.el.className = 'view diff';
    this.el.innerHTML = `<div class="dhead"></div><div class="dlabels"><div></div><div></div></div><div class="dbody"></div>`;
    this.head = $('.dhead', this.el);
    this.body = $('.dbody', this.el);
    this.body.addEventListener('click', (e) => {
      const f = e.target.closest('.fold');
      if (f) { this.expanded.add(Number(f.dataset.start)); this.renderBody(); }
    });
    this.body.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.dr[data-b]');
      if (r && this.tab.entry.area !== 'staged') openFile(this.tab.entry.file, { line: Number(r.dataset.b) + 1 }).catch(fail);
    });
    this.head.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) { this.expanded.clear(); st.diffMode = b.dataset.mode; store.set('diffMode', st.diffMode); this.render(); }
      else if (b.dataset.nav) this.nav(Number(b.dataset.nav));
      else if (b.dataset.act === 'open') openFile(this.tab.entry.file).catch(fail);
      else if (b.dataset.act === 'reload') this.load();
    });
    $('#stage').append(this.el);
  }

  async load() {
    const e = this.tab.entry;
    this.body.innerHTML = '<div class="dnote">讀取中…</div>';
    try {
      const d = await td.invoke('gitDiff', { id: st.pid, top: st.git.top, area: e.area, path: e.path, orig: e.orig });
      this.data = d;
      this.lang = C.langFor(e.path);
      await ensureLang(this.lang);
      const a = d.left.text.replace(/\r\n?/g, '\n');
      const b = d.right.text.replace(/\r\n?/g, '\n');
      this.a = C.toLines(a);
      this.b = C.toLines(b);
      this.ops = C.diffLines(this.a, this.b);
      this.stats = C.diffStats(this.ops);
      // 整段高亮後再切行，多行註解與字串才會正確
      this.ha = C.splitHtmlLines(highlightCode(this.a.join('\n'), this.lang));
      this.hb = C.splitHtmlLines(highlightCode(this.b.join('\n'), this.lang));
      this.render();
    } catch (err) {
      this.data = null;
      this.head.innerHTML = '';
      this.body.innerHTML = `<div class="dnote">無法比對：${esc(err.message)}</div>`;
    }
  }

  render() {
    const e = this.tab.entry;
    const d = this.data;
    if (!d) return;
    const s = this.stats;
    const areaName = Object.fromEntries(GIT_GROUPS)[e.area];
    this.head.innerHTML = `<span class="p" title="${esc(e.rel)}">${esc(e.rel)}</span><span class="st g-${esc(e.status)}">${esc(areaName)}・${esc(e.label)}</span>`
      + `<span class="add">+${s.added}</span><span class="del">−${s.removed}</span><span class="sp"></span>`
      + `<div class="seg"><button data-mode="sbs" class="${st.diffMode === 'sbs' ? 'on' : ''}">並排</button><button data-mode="uni" class="${st.diffMode === 'uni' ? 'on' : ''}">行內</button></div>`
      + `<button class="ib sm" data-nav="-1" title="上一個變更">↑</button><button class="ib sm" data-nav="1" title="下一個變更">↓</button>`
      + `${e.status !== 'D' ? '<button class="secondary sm" data-act="open">開啟檔案</button>' : ''}<button class="ib sm" data-act="reload" title="重新整理">⟳</button>`;
    const labels = $('.dlabels', this.el);
    labels.hidden = st.diffMode !== 'sbs';
    labels.children[0].textContent = `${d.left.label}${d.left.note ? `（${d.left.note}）` : ''}`;
    labels.children[1].textContent = `${d.right.label}${d.right.note ? `（${d.right.note}）` : ''}`;
    this.renderBody();
  }

  renderBody() {
    const d = this.data;
    if (!d) return;
    if (d.left.binary || d.right.binary) { this.body.innerHTML = '<div class="dnote">二進位檔案，無法顯示差異。</div>'; return; }
    if (!this.ops.length) { this.body.innerHTML = '<div class="dnote">檔案是空的。</div>'; return; }
    if (!this.stats.added && !this.stats.removed) {
      this.body.innerHTML = `<div class="dnote">內容相同${this.tab.entry.status === 'R' ? '（只有重新命名）' : '（可能只有權限或換行字元不同）'}。</div>`;
      return;
    }
    const sbs = st.diffMode === 'sbs';
    this.body.className = `dbody ${sbs ? 'sbs' : 'uni'}`;
    const digits = String(Math.max(this.a.length, this.b.length)).length;
    this.body.style.setProperty('--lnw', `calc(${digits}ch + 16px)`);
    const rows = C.fold(sbs ? C.sideBySide(this.ops) : C.unified(this.ops), 3, this.expanded);
    const A = (i) => lineHtml(this.ha[i] || '');
    const B = (i) => lineHtml(this.hb[i] || '');
    const out = [];
    let prev = 'eq';
    for (const r of rows) {
      if (r.kind === 'fold') { out.push(`<div class="dr fold" data-start="${r.start}"><span>⋯ 展開 ${r.count} 行未變更的內容</span></div>`); prev = 'eq'; continue; }
      const start = r.kind !== 'eq' && prev === 'eq' ? ' data-chg="1"' : '';
      const bAttr = r.b !== null ? ` data-b="${r.b}"` : '';
      prev = r.kind;
      if (sbs) {
        const lk = r.kind === 'eq' ? '' : r.a === null ? 'none' : 'del';
        const rk = r.kind === 'eq' ? '' : r.b === null ? 'none' : 'add';
        out.push(`<div class="dr"${start}${bAttr}><span class="n ${lk}">${r.a !== null ? r.a + 1 : ''}</span><span class="c ${lk}">${r.a !== null ? A(r.a) : ''}</span>`
          + `<span class="n ${rk}">${r.b !== null ? r.b + 1 : ''}</span><span class="c ${rk}">${r.b !== null ? B(r.b) : ''}</span></div>`);
      } else {
        const k = r.kind === 'eq' ? '' : r.kind;
        out.push(`<div class="dr"${start}${bAttr}><span class="n ${k}">${r.a !== null ? r.a + 1 : ''}</span><span class="n ${k}">${r.b !== null ? r.b + 1 : ''}</span>`
          + `<span class="s ${k}">${r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}</span><span class="c ${k}">${r.kind === 'del' ? A(r.a) : B(r.b)}</span></div>`);
      }
    }
    this.body.innerHTML = out.join('');
    this.focusIdx = -1;
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
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (!$('#modal').hidden) return;
  if (e.key === 'Escape') {
    closeMenus();
    if (st.find.open) { e.preventDefault(); closeFind(); }
    return;
  }
  if (e.key === 'F3' || (IS_MAC && mod && k === 'g' && !e.ctrlKey)) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); return; }
  if (e.ctrlKey && !e.metaKey && k === 'g') { e.preventDefault(); gotoLine(); return; }
  if (!mod) return;
  if (k === 's') { e.preventDefault(); save(activeTab(), e.shiftKey || e.altKey); }
  else if (k === 'f' && !e.altKey) { e.preventDefault(); openFind(false); }
  else if (k === 'h' || (k === 'f' && e.altKey)) { e.preventDefault(); openFind(true); }
  else if (k === 'p') { e.preventDefault(); setSide('files'); $('#filter').focus(); $('#filter').select(); }
  else if (k === 'n') { e.preventDefault(); newUntitled(); }
  else if (k === 'o') { e.preventDefault(); openFileDialog().catch(fail); }
  else if (k === 'l' && !e.shiftKey && !e.altKey) { e.preventDefault(); gotoLine(); }
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
  newFile: () => newUntitled(),
  openFile: () => openFileDialog(),
  newFileIn: () => st.pid && createIn(selDir(), false),
  newFolderIn: () => st.pid && createIn(selDir(), true),
  refresh: () => refreshAll(),
  refreshGit: () => refreshGit(),
  collapse: () => { st.tree.expanded.clear(); renderTree(); saveStateSoon(); },
};

async function runCommand(cmd) {
  if (cmd === 'addProject') await addProject();
  else if (cmd === 'openFile') await openFileDialog();
  else if (cmd === 'showChanges') { setSide('git'); await refreshGit(); }
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
  $('#projMenuBtn').onclick = () => { const m = $('#projMenu'); const show = m.hidden; closeMenus(); m.hidden = !show; };
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
    if (h) { const g = h.dataset.grp; if (st.gitCollapsed.has(g)) st.gitCollapsed.delete(g); else st.gitCollapsed.add(g); renderGit(); return; }
    const row = e.target.closest('.row[data-area]');
    if (row) openDiff(gitEntry(row)).catch(fail);
  });
  changes.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-area]');
    if (!row) return;
    const en = gitEntry(row);
    if (en.status === 'D') openDiff(en, { preview: false }).catch(fail);
    else openFile(en.file).catch(fail);
  });
  changes.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-area]');
    if (!row) return;
    const en = gitEntry(row);
    const items = [['查看差異', () => openDiff(en, { preview: false })]];
    if (en.status !== 'D') items.push(['開啟檔案', () => openFile(en.file)]);
    if (!en.rel.startsWith('..') && en.status !== 'D') items.push(['在檔案樹中顯示', () => revealInTree(en.rel)]);
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
  for (const k of $$('[data-key]')) k.textContent = `${MOD}${k.dataset.key}`;
  st.diffMode = store.get('diffMode', 'sbs');
  initSplitter();
  bind();
  st.info = await td.invoke('info');
  st.projects = st.info.projects;
  applySettings();
  renderRecent();
  renderGit();
  const last = st.projects.find((p) => p.id === st.info.lastProject) ? st.info.lastProject : (st.projects[0] && st.projects[0].id);
  if (last) await switchProject(last, last === st.info.lastProject ? st.info.state : undefined);
  else { renderProjects(); renderTree(); }
  renderTabs();
  updateStatusBar();
  await drainPending();
}

init().catch((err) => { console.error(err); fail(err); });
