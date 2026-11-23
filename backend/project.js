'use strict';
/**
 * 接收 Git 工具定義的專案交換格式 git-tool.project v1。
 * 格式說明：https://github.com/tooldock-dev/tooldock-ext-git（README〈專案交換格式〉、exchange/project.v1.schema.json）
 *
 * 程式碼編輯器只處理同一台電腦內的交付（帶 path）。從 .tdx 檔匯入時路徑不可信也沒有意義，
 * 依格式規定忽略 path，請使用者改用 Git 工具複製（clone）。
 */
const fs = require('fs');
const path = require('path');

const TYPE = 'git-tool.project';

/** 驗證 payload，回傳 { name, root, file, line }；不能開啟時丟出例外（訊息給使用者看） */
function parsePayload(payload, { origin = 'share' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('交換包內容不正確');
  if (origin === 'file') throw new Error('這是分享給別人的專案，請先用 Git 工具複製（clone）到本機，再從 Git 工具「在程式碼編輯器開啟」');
  const p = typeof payload.path === 'string' ? payload.path.trim() : '';
  if (!p) throw new Error('交換包沒有專案路徑');
  if (p.length > 4096 || !path.isAbsolute(p)) throw new Error('專案路徑必須是絕對路徑');
  const root = path.resolve(p);
  let st;
  try { st = fs.statSync(root); } catch { throw new Error(`資料夾不存在：${root}`); }
  if (!st.isDirectory()) throw new Error(`不是資料夾：${root}`);
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 100) : path.basename(root);
  let file = null;
  let line = null;
  if (typeof payload.file === 'string' && payload.file.trim() && payload.file.length <= 1024) {
    const abs = path.resolve(root, payload.file.trim());
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      file = abs;
      if (Number.isInteger(payload.line) && payload.line > 0) line = payload.line;
    }
  }
  return { name, root, file, line };
}

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 要開啟哪個專案：資料夾相同的專案；指定了檔案時，也可以是包含這個檔案、最深的現有專案
 * （例如 Git 工具送來儲存庫根目錄，而你的專案是其中的子資料夾）。都沒有時回傳 null，由呼叫端建立。
 */
function pickProject(projects, { root, file }) {
  const same = projects.find((p) => path.resolve(p.root) === root);
  if (same) return same;
  if (!file) return null;
  const hits = projects.filter((p) => inside(path.resolve(p.root), file) && inside(root, path.resolve(p.root)));
  hits.sort((a, b) => b.root.length - a.root.length);
  return hits[0] || null;
}

module.exports = { TYPE, parsePayload, pickProject };
