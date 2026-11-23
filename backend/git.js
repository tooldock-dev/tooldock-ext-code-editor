'use strict';
/**
 * Git：專案的異動清單（git status）、比對兩側的內容（HEAD／索引／工作目錄）、檔案歷史，
 * 以及把工作目錄的檔案還原成暫存區或歷史版本。
 * 只執行讀取的 git 指令，不修改暫存區、分支與提交；還原是由擴充自己寫入工作目錄的檔案。
 * status 使用 GIT_OPTIONAL_LOCKS=0，不會和使用者自己的 git 指令搶鎖。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const files = require('./files');
const { isBinary } = files;
const C = require('../ui/code-core');

const MAX_BLOB = 10 * 1024 * 1024;
const FALLBACK = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
  : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];

const STATUS_TEXT = { M: '修改', A: '新增', D: '刪除', R: '重新命名', C: '複製', T: '類型變更', U: '衝突', '?': '未追蹤' };
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

let resolvedGit = null;

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? stderr.toString('utf8').trim() : '';
        reject(err);
      } else resolve(stdout);
    });
  });
}

/** 執行 git；找不到 git 時依序嘗試常見的安裝位置（打包後的 App 不一定有使用者的 PATH） */
async function git(args, cwd, gitPath) {
  const candidates = [gitPath, resolvedGit, 'git', ...FALLBACK].filter(Boolean);
  let last;
  for (const bin of [...new Set(candidates)]) {
    try {
      const out = await run(bin, args, cwd);
      resolvedGit = bin;
      return out;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      last = err;
    }
  }
  const e = new Error('找不到 git，請先安裝 Git，或在設定中指定 git 執行檔位置');
  e.code = 'NO_GIT';
  e.cause = last;
  throw e;
}

/** 解析 git status --porcelain=v1 -z -b */
function parseStatus(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, noCommits: false, detached: false, entries: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const h = p.slice(3);
      let m;
      if ((m = h.match(/^No commits yet on (.+)$/)) || (m = h.match(/^Initial commit on (.+)$/))) {
        out.branch = m[1];
        out.noCommits = true;
      } else if (h.startsWith('HEAD (no branch)')) {
        out.detached = true;
      } else {
        m = h.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
        if (m) {
          out.branch = m[1];
          out.upstream = m[2] || '';
          const ab = m[3] || '';
          out.ahead = Number((ab.match(/ahead (\d+)/) || [])[1] || 0);
          out.behind = Number((ab.match(/behind (\d+)/) || [])[1] || 0);
        }
      }
      continue;
    }
    const xy = p.slice(0, 2);
    const file = p.slice(3);
    let orig = '';
    if (xy[0] === 'R' || xy[0] === 'C') orig = parts[++i] || '';
    out.entries.push({ xy, path: file, orig });
  }
  return out;
}

/** 依暫存區／工作目錄分組 */
function group(entries) {
  const g = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const e of entries) {
    if (e.xy === '!!') continue;
    if (e.xy === '??') { g.untracked.push({ path: e.path, status: '?' }); continue; }
    if (CONFLICT.has(e.xy)) { g.conflict.push({ path: e.path, status: 'U', xy: e.xy }); continue; }
    const [x, y] = e.xy;
    if (x !== ' ') g.staged.push({ path: e.path, status: x, orig: e.orig || undefined });
    if (y !== ' ') g.unstaged.push({ path: e.path, status: y });
  }
  return g;
}

/** 專案所在儲存庫的根目錄；不是儲存庫時回傳 null */
async function topLevel(root, gitPath) {
  try {
    return path.resolve((await git(['rev-parse', '--show-toplevel'], root, gitPath)).toString('utf8').trim());
  } catch {
    return null;
  }
}

/** 專案的 Git 狀態；不是儲存庫時回傳 { repo: false } */
async function status(root, gitPath) {
  let top;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], root, gitPath)).toString('utf8').trim();
  } catch (err) {
    if (err.code === 'NO_GIT') return { repo: false, noGit: true, message: err.message };
    return { repo: false, message: '這個專案不是 Git 儲存庫' };
  }
  // Windows 上 rev-parse 回傳正斜線路徑
  top = path.resolve(top);
  const st = parseStatus(await git(['status', '--porcelain=v1', '-z', '-b', '-uall', '--', '.'], root, gitPath));
  let head = '';
  if (!st.noCommits) {
    try { head = (await git(['log', '-1', '--format=%h %s'], root, gitPath)).toString('utf8').trim(); } catch { /* 忽略 */ }
  }
  const g = group(st.entries);
  const decorate = (list, area) => list.map((e) => {
    const abs = path.join(top, e.path);
    return { ...e, area, file: abs, rel: path.relative(root, abs).split(path.sep).join('/'), label: STATUS_TEXT[e.status] || e.status };
  });
  return {
    repo: true,
    top,
    branch: st.detached ? `（分離的 HEAD）${head.split(' ')[0] || ''}` : st.branch,
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
    noCommits: st.noCommits,
    head,
    conflict: decorate(g.conflict, 'conflict'),
    staged: decorate(g.staged, 'staged'),
    unstaged: decorate(g.unstaged, 'unstaged'),
    untracked: decorate(g.untracked, 'untracked'),
  };
}

/** Buffer → 文字；二進位或過大時回傳說明 */
function decode(buf) {
  if (buf.length > MAX_BLOB) return { text: '', note: `檔案超過 ${MAX_BLOB / 1024 / 1024} MB，不顯示內容` };
  if (isBinary(buf)) return { text: '', binary: true, note: '二進位檔案' };
  let s = buf;
  if (s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) s = s.subarray(3);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(s) }; } catch { return { text: new TextDecoder('big5').decode(s), note: '以 Big5 解碼' }; }
}

async function blob(top, rev, rel, gitPath) {
  try {
    return { exists: true, ...decode(await git(['cat-file', 'blob', `${rev}:${rel}`], top, gitPath)) };
  } catch {
    return { exists: false, text: '' };
  }
}

function working(top, rel) {
  const f = path.join(top, rel);
  try {
    const st = fs.statSync(f);
    if (st.isDirectory()) return { exists: true, text: '', note: '子模組或資料夾' };
    return { exists: true, ...decode(fs.readFileSync(f)) };
  } catch {
    return { exists: false, text: '' };
  }
}

/**
 * 比對兩側：
 *   staged     HEAD（重新命名時為原路徑）↔ 索引
 *   unstaged   索引 ↔ 工作目錄
 *   untracked  （無）↔ 工作目錄
 *   conflict   HEAD ↔ 工作目錄（含衝突標記）
 */
async function diffSides(top, { area, path: rel, orig }, gitPath) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('路徑不正確');
  const full = path.resolve(top, rel);
  if (!full.startsWith(path.resolve(top) + path.sep)) throw new Error('路徑不在儲存庫內');
  let left, right, leftLabel, rightLabel;
  if (area === 'staged') {
    left = await blob(top, 'HEAD', orig || rel, gitPath);
    right = await blob(top, '', rel, gitPath);
    leftLabel = orig ? `HEAD：${orig}` : 'HEAD';
    rightLabel = '已暫存';
  } else if (area === 'unstaged') {
    left = await blob(top, '', rel, gitPath);
    if (!left.exists) left = await blob(top, 'HEAD', rel, gitPath);
    right = working(top, rel);
    leftLabel = '已暫存／HEAD';
    rightLabel = '工作目錄';
  } else if (area === 'untracked') {
    left = { exists: false, text: '' };
    right = working(top, rel);
    leftLabel = '（新檔案）';
    rightLabel = '工作目錄';
  } else if (area === 'conflict') {
    left = await blob(top, 'HEAD', rel, gitPath);
    right = working(top, rel);
    leftLabel = 'HEAD';
    rightLabel = '工作目錄（含衝突標記）';
  } else {
    throw new Error(`未知的比對區域：${area}`);
  }
  return { path: rel, left: { ...left, label: leftLabel }, right: { ...right, label: rightLabel } };
}

/* ───────────── 還原（只改寫工作目錄的檔案，不動暫存區與提交） ───────────── */

/** 儲存庫相對路徑 → 絕對路徑；必須在儲存庫內，而且在專案資料夾內 */
function repoPath(top, root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('路徑不正確');
  const abs = path.resolve(top, rel);
  if (!abs.startsWith(path.resolve(top) + path.sep)) throw new Error('路徑不在儲存庫內');
  if (!files.inside(root, abs)) throw new Error('路徑不在專案資料夾內');
  return abs;
}

/**
 * 某個版本的檔案內容（rev 為空字串時是暫存區），套用 git 的換行轉換與 smudge 過濾器（例如 Git LFS），
 * 和 git checkout 寫出來的內容相同。舊版 git 不支援 --filters 時改用原始內容。
 */
async function checkoutContent(top, rev, rel, gitPath) {
  const spec = `${rev}:${rel}`;
  try {
    return await git(['cat-file', '--filters', spec], top, gitPath);
  } catch (err) {
    if (/unknown option|usage:/i.test(err.stderr || '')) return git(['cat-file', 'blob', spec], top, gitPath);
    throw err;
  }
}

/** 暫存區中檔案的權限（100644、100755…）；不在暫存區時回傳 null */
async function indexMode(top, rel, gitPath) {
  try {
    const out = (await git(['ls-files', '-s', '--', rel], top, gitPath)).toString('utf8');
    const m = out.match(/^(\d{6}) /);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 捨棄工作目錄的變更：items = [{ area: 'unstaged' | 'untracked', path }]
 *   unstaged   改回暫存區的版本；檔案被刪除時重新建立
 *   untracked  刪除檔案
 * op 為 edits.begin() 的操作。回傳 [{ path, ok, reason }]。
 */
async function restore(top, root, items, op, gitPath) {
  const results = [];
  for (const it of items) {
    const res = { path: it.path, ok: false };
    results.push(res);
    try {
      const abs = repoPath(top, root, it.path);
      if (it.area === 'untracked') {
        let st;
        try { st = fs.lstatSync(abs); } catch { throw new Error('檔案已不存在'); }
        if (st.isDirectory()) throw new Error('這是資料夾');
        op.remove(abs);
      } else if (it.area === 'unstaged') {
        const mode = await indexMode(top, it.path, gitPath);
        if (!mode) throw new Error('暫存區沒有這個檔案');
        if (mode === '120000' || mode === '160000') throw new Error('符號連結與子模組請用 Git 工具還原');
        let buf;
        try { buf = await checkoutContent(top, '', it.path, gitPath); } catch { throw new Error('讀不到這個檔案在暫存區的版本'); }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        op.write(abs, buf, mode === '100755' ? 0o755 : undefined);
      } else {
        throw new Error('已暫存與衝突的變更請用 Git 工具處理');
      }
      res.ok = true;
    } catch (err) {
      res.reason = err.message;
    }
  }
  return results;
}

const norm = (s) => String(s || '').replace(/\r\n?/g, '\n');

/**
 * 還原「變更」（暫存區 ↔ 工作目錄）中的一段：重新計算差異，找到和畫面上相同的那一段（hunk），
 * 確認工作目錄的內容沒有變過，再把那一段改回暫存區的內容。
 */
async function revertHunk(top, root, rel, hunk, op, gitPath) {
  const abs = repoPath(top, root, rel);
  const d = await diffSides(top, { area: 'unstaged', path: rel }, gitPath);
  if (d.left.binary || d.right.binary) throw new Error('二進位檔案不能逐段還原');
  if (!d.left.exists || !d.right.exists) throw new Error('新增或刪除的檔案請還原整個檔案');
  if (d.left.note || d.right.note) throw new Error(`無法逐段還原：${d.left.note || d.right.note}`);
  const a = C.toLines(norm(d.left.text));
  const b = C.toLines(norm(d.right.text));
  const h = C.hunks(C.diffLines(a, b)).find((x) => C.sameHunk(x, hunk));
  if (!h) throw new Error('差異已經變更，請重新整理後再試');
  const doc = files.readText(abs);
  if (doc.tooLarge || doc.binary) throw new Error('檔案過大或是二進位檔');
  if (doc.readOnly) throw new Error(`${doc.encoding.toUpperCase()} 編碼的檔案不能逐段還原`);
  if (C.toLines(doc.text).join('\n') !== b.join('\n')) throw new Error('檔案已經變更，請重新整理後再試');
  const lines = C.revertHunk(a, b, h);
  // 結尾換行：這一段在檔案最後時跟暫存區一樣，否則維持工作目錄原本的樣子
  const atEnd = h.bStart + h.bLen === b.length;
  const endNl = atEnd ? norm(d.left.text).endsWith('\n') : doc.text.endsWith('\n');
  const text = lines.length ? lines.join('\n') + (endNl ? '\n' : '') : '';
  op.write(abs, files.encodeText(text, doc.eol, doc.bom));
  return { path: rel, lines: lines.length };
}

/* ───────────── 檔案歷史 ───────────── */

const LOG_LIMIT = 300;

/** 解析 git log --name-status 的輸出（每筆以 \x1e 開頭，欄位以 \x1f 分隔） */
function parseLog(buf) {
  const out = [];
  for (const chunk of buf.toString('utf8').split('\x1e')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [hash, short, author, at, subject] = lines[0].split('\x1f');
    if (!hash) continue;
    const c = { hash, short, author, at: Number(at) * 1000, subject: subject || '', status: '', path: '', orig: '' };
    for (const l of lines.slice(1)) {
      if (!l) continue;
      const parts = l.split('\t');
      c.status = parts[0][0];
      if ((c.status === 'R' || c.status === 'C') && parts.length >= 3) { c.orig = parts[1]; c.path = parts[2]; } else c.path = parts[1] || '';
      break;
    }
    out.push(c);
  }
  return out;
}

/** 檔案的提交紀錄（跟著重新命名往前找），最多 300 筆；每筆附上當時的路徑 */
async function fileLog(top, root, rel, gitPath) {
  repoPath(top, root, rel);
  const args = ['-c', 'core.quotePath=false', 'log', '--follow', `-n${LOG_LIMIT}`, '--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s', '--name-status', '--', rel];
  let commits;
  try { commits = parseLog(await git(args, top, gitPath)); } catch (err) {
    if (/does not have any commits|bad default revision/i.test(err.stderr || '')) return { commits: [], limited: false };
    throw new Error(err.stderr || err.message);
  }
  for (const c of commits) if (!c.path) c.path = rel;
  return { commits, limited: commits.length >= LOG_LIMIT };
}

const HASH = /^[0-9a-f]{7,64}$/i;

/**
 * 歷史版本的比對兩側：
 *   commit    這次提交的變更：上一版（重新命名時為原路徑）↔ 這一版
 *   working   這一版 ↔ 目前的工作目錄（target 為目前的路徑）
 */
async function versionSides(top, root, { rev, path: rel, orig, status, mode, target }, gitPath) {
  if (!HASH.test(String(rev))) throw new Error('提交編號不正確');
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('路徑不正確');
  const short = String(rev).slice(0, 7);
  const at = status === 'D' ? { exists: false, text: '', note: '這次提交刪除了檔案' } : await blob(top, rev, rel, gitPath);
  if (mode === 'working') {
    const t = repoPath(top, root, target);
    return { path: target, left: { ...at, label: `${short}：${rel}` }, right: { ...working(top, path.relative(top, t)), label: '目前的檔案' } };
  }
  const prev = await blob(top, `${rev}^`, orig || rel, gitPath);
  return { path: rel, left: { ...prev, label: orig ? `上一版：${orig}` : '上一版' }, right: { ...at, label: short } };
}

/** 把工作目錄的檔案（target）改成某個提交的版本（rev:path） */
async function restoreVersion(top, root, { rev, path: rel, target }, op, gitPath) {
  if (!HASH.test(String(rev))) throw new Error('提交編號不正確');
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('路徑不正確');
  const abs = repoPath(top, root, target);
  let buf;
  try { buf = await checkoutContent(top, rev, rel, gitPath); } catch { throw new Error('這個版本沒有這個檔案'); }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  op.write(abs, buf);
  return { path: target };
}

module.exports = {
  git, topLevel, status, parseStatus, group, diffSides, decode, STATUS_TEXT,
  repoPath, restore, revertHunk, parseLog, fileLog, versionSides, restoreVersion,
};
