'use strict';
/**
 * 會改寫硬碟檔案的操作（跨檔案取代、Git 還原）都經過這裡：
 * 寫入前把原本的內容留在記憶體，之後可以「復原」。只保留最近幾次操作，擴充重新啟動後就沒有了。
 * 復原時檔案若又被改過（修改時間或大小不同），那個檔案就不復原，以免蓋掉之後的修改。
 */
const fs = require('fs');
const crypto = require('crypto');
const { writeAtomic, notifyChange } = require('./files');

const KEEP = 10; // 保留最近幾次操作
const MAX_BACKUP = 64 * 1024 * 1024; // 一次操作最多備份的總大小；超過的檔案不能復原

let history = [];

const stamp = (st) => (st ? { mtime: st.mtimeMs, size: st.size } : null);
const statOf = (file) => { try { return fs.statSync(file); } catch { return null; } };

class Op {
  constructor(label) {
    this.id = crypto.randomUUID();
    this.label = label;
    this.at = Date.now();
    this.files = [];
    this.bytes = 0;
  }

  /** 同一次操作中同一個檔案只備份第一次寫入前的內容 */
  backup(file) {
    const seen = this.files.find((f) => f.file === file);
    if (seen) return seen;
    const st = statOf(file);
    const entry = { file, before: null, mode: st ? st.mode : undefined, existed: !!st, canUndo: true };
    if (st) {
      if (this.bytes + st.size > MAX_BACKUP) entry.canUndo = false;
      else { entry.before = fs.readFileSync(file); this.bytes += st.size; }
    }
    return entry;
  }

  /** 寫入檔案（Buffer 或字串）；新檔案可指定 mode */
  write(file, data, mode) {
    const entry = this.backup(file);
    const st = writeAtomic(file, data, mode);
    entry.after = stamp(st);
    if (!this.files.includes(entry)) this.files.push(entry);
    return st;
  }

  /** 刪除檔案 */
  remove(file) {
    const entry = this.backup(file);
    fs.rmSync(file);
    notifyChange(file);
    entry.after = null;
    if (!this.files.includes(entry)) this.files.push(entry);
  }
}

function begin(label) { return new Op(label); }

/** 有寫入任何檔案時記錄下來；回傳操作 id（沒有可以復原的內容時為 null） */
function commit(op) {
  if (!op.files.length) return null;
  history = [op, ...history.filter((h) => h.id !== op.id)].slice(0, KEEP);
  return op.files.some((f) => f.canUndo) ? op.id : null;
}

/** 復原：回傳 { restored: [檔案], skipped: [{ file, reason }] } */
function undo(id) {
  const op = history.find((h) => h.id === id);
  if (!op) throw new Error('已經沒有可以復原的紀錄（只保留最近幾次操作，擴充重新啟動後也會清除）');
  history = history.filter((h) => h.id !== id);
  const restored = [];
  const skipped = [];
  for (const f of [...op.files].reverse()) {
    if (!f.canUndo) { skipped.push({ file: f.file, reason: '檔案太大，沒有保留備份' }); continue; }
    const now = stamp(statOf(f.file));
    const same = f.after ? now && now.mtime === f.after.mtime && now.size === f.after.size : !now;
    if (!same) { skipped.push({ file: f.file, reason: '之後又被修改過' }); continue; }
    try {
      if (f.existed) writeAtomic(f.file, f.before, f.mode);
      else { fs.rmSync(f.file, { force: true }); notifyChange(f.file); }
      restored.push(f.file);
    } catch (err) {
      skipped.push({ file: f.file, reason: err.message });
    }
  }
  return { label: op.label, restored, skipped };
}

const _reset = () => { history = []; };

module.exports = { begin, commit, undo, _reset, MAX_BACKUP };
