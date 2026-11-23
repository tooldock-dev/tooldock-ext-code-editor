'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const terminal = require('../backend/terminal');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-term-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('終端機：各平台的預設指令', () => {
  assert.deepEqual(terminal.plan('darwin', '/p'), [{ cmd: 'open', args: ['-a', 'Terminal', '/p'], wait: true }]);
  assert.deepEqual(terminal.plan('darwin', '/p', ' iTerm '), [{ cmd: 'open', args: ['-a', 'iTerm', '/p'], wait: true }]);
  assert.deepEqual(terminal.plan('darwin', '/p', '/Applications/Warp.app')[0].args, ['-a', '/Applications/Warp.app', '/p']);
  assert.deepEqual(terminal.plan('darwin', '/p', '/usr/local/bin/myterm'), [{ cmd: '/usr/local/bin/myterm', args: [], detached: true }]);
  const win = terminal.plan('win32', 'C:\\p');
  assert.deepEqual(win.map((c) => c.cmd), ['wt.exe', 'powershell.exe', 'cmd.exe']);
  assert.deepEqual(win[0].args, ['-d', 'C:\\p']);
  assert.ok(win[1].detached && win[2].detached, 'PowerShell、cmd 要開新的主控台視窗');
  assert.deepEqual(terminal.plan('win32', 'C:\\p', 'C:\\x\\t.exe'), [{ cmd: 'C:\\x\\t.exe', args: [], detached: true }]);
  assert.deepEqual(terminal.plan('win32', 'C:\\p', 'C:\\x y\\t.cmd'), [{ cmd: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\x y\\t.cmd"'], verbatim: true, detached: true }], '批次檔透過 cmd.exe');
  const linux = terminal.plan('linux', '/p');
  assert.equal(linux[0].cmd, 'x-terminal-emulator');
  assert.ok(linux.find((c) => c.cmd === 'gnome-terminal').args.includes('--working-directory=/p'));
});

test('終端機：找不到就試下一個，全部找不到時提示設定', () => withTmp(async (dir) => {
  const tried = [];
  const run = async (c, cwd) => { tried.push([c.cmd, cwd]); return c.cmd === 'powershell.exe'; };
  const r = await terminal.open(dir, '', { platform: 'win32', run });
  assert.deepEqual(r, { dir, command: 'powershell.exe' });
  assert.deepEqual(tried, [['wt.exe', dir], ['powershell.exe', dir]], '工作目錄都是指定的資料夾');
  await assert.rejects(terminal.open(dir, '', { platform: 'linux', run: async () => false }), /找不到可用的終端機程式/);
  await assert.rejects(terminal.open(dir, 'nope', { platform: 'linux', run: async () => false }), /找不到終端機程式「nope」/);
  await assert.rejects(terminal.open(dir, '/no/such/term', { platform: 'linux', run: async () => true }), /找不到終端機程式「\/no\/such\/term」/, '路徑不存在時不執行');
  await assert.rejects(terminal.open(path.join(dir, 'missing'), ''), /資料夾不存在/);
  fs.writeFileSync(path.join(dir, 'f.txt'), '');
  await assert.rejects(terminal.open(path.join(dir, 'f.txt'), ''), /請選擇資料夾/);
  await assert.rejects(terminal.open('relative', ''), /路徑不正確/);
}));

test('終端機：自訂執行檔以資料夾為工作目錄執行', { skip: process.platform === 'win32' }, () => withTmp(async (dir) => {
  const proj = path.join(dir, '專案 a');
  fs.mkdirSync(proj);
  const out = path.join(dir, 'cwd.txt');
  const script = path.join(dir, 'term.sh');
  fs.writeFileSync(script, `#!/bin/sh\npwd > "${out}"\n`, { mode: 0o755 });
  const r = await terminal.open(proj, script);
  assert.equal(r.command, script);
  for (let i = 0; i < 250 && !(fs.existsSync(out) && fs.statSync(out).size); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(fs.readFileSync(out, 'utf8').trim(), proj);
  await assert.rejects(terminal.open(proj, path.join(dir, 'no-such-term')), /找不到終端機程式/);
}));

test('終端機：macOS 找不到 App 時顯示錯誤', { skip: process.platform !== 'darwin' }, () => withTmp(async (dir) => {
  await assert.rejects(terminal.open(dir, 'NoSuchTerminalApp-xyz'), /無法開啟終端機「NoSuchTerminalApp-xyz」/);
}));
