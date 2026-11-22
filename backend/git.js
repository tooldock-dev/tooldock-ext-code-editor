'use strict';
/**
 * Git：專案的異動清單（git status）與比對兩側的內容（HEAD／索引／工作目錄）。
 * 只讀取，不修改儲存庫；status 使用 GIT_OPTIONAL_LOCKS=0，不會和使用者自己的 git 指令搶鎖。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { isBinary } = require('./files');

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

module.exports = { git, topLevel, status, parseStatus, group, diffSides, decode, STATUS_TEXT };
