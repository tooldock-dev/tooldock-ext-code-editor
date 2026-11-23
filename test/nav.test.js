'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const symbols = require('../backend/symbols');
const classfile = require('../backend/classfile');
const decompiler = require('../backend/decompile');

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ce-nav-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); symbols.forget(dir); decompiler._reset(); }
}
const write = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };

test('符號索引：建立、只更新改過的檔案、刪除的檔案移出、排除清單、略過的檔案、不分大小寫', () => withTmp(async (dir) => {
  write(dir, 'src/a.js', 'function run() {}\nclass Shop {}\n');
  write(dir, 'src/b.py', 'def run():\n  pass\n');
  write(dir, 'node_modules/x/index.js', 'function run() {}\n');
  write(dir, 'db/pkg.sql', 'CREATE PROCEDURE Load_Data AS\n');
  write(dir, 'README.md', 'function run() {}\n');
  let r = await symbols.definitions(dir, 'node_modules', { name: 'run' });
  assert.deepEqual(r.items.map((x) => `${x.rel}:${x.line}:${x.kind}:${x.family}`).sort(), ['src/a.js:1:函式:js', 'src/b.py:1:函式:py']);
  assert.equal(r.stats.parsed, 3);
  assert.equal(r.items.find((x) => x.rel === 'src/a.js').file, path.join(dir, 'src', 'a.js'));
  // 沒有改過的檔案不重新解析
  r = await symbols.definitions(dir, 'node_modules', { name: 'Shop' });
  assert.equal(r.stats.parsed, 0);
  assert.equal(r.items.length, 1);
  // 修改、刪除
  write(dir, 'src/a.js', '\n\nfunction run() {}\n');
  fs.utimesSync(path.join(dir, 'src', 'a.js'), new Date(), new Date(Date.now() + 5000));
  fs.rmSync(path.join(dir, 'src', 'b.py'));
  r = await symbols.definitions(dir, 'node_modules', { name: 'run' });
  assert.deepEqual(r.items.map((x) => `${x.rel}:${x.line}`), ['src/a.js:3']);
  assert.equal(r.stats.parsed, 1);
  assert.equal((await symbols.definitions(dir, 'node_modules', { name: 'Shop' })).items.length, 0);
  // skip（尚未儲存的分頁由畫面自己解析）
  assert.equal((await symbols.definitions(dir, 'node_modules', { name: 'run', skip: ['src/a.js'] })).items.length, 0);
  // SQL 不分大小寫
  assert.equal((await symbols.definitions(dir, '', { name: 'load_data', ci: true })).items.length, 1);
  assert.equal((await symbols.definitions(dir, '', { name: 'load_data' })).items.length, 0);
  // 排除清單改變後，被排除的檔案移出索引
  assert.equal((await symbols.definitions(dir, '', { name: 'run' })).items.length, 2);
  assert.equal((await symbols.definitions(dir, 'node_modules', { name: 'run' })).items.length, 1);
  assert.deepEqual((await symbols.definitions(dir, '', { name: '' })).items, []);
}));

test('符號索引：同時查詢共用同一次建立', () => withTmp(async (dir) => {
  for (let i = 0; i < 300; i++) write(dir, `f${i}.js`, `function f${i}() {}\n`);
  const [a, b] = await Promise.all([symbols.definitions(dir, '', { name: 'f1' }), symbols.definitions(dir, '', { name: 'f299' })]);
  assert.equal(a.items.length, 1);
  assert.equal(b.items.length, 1);
  assert.equal(a.stats, b.stats);
}));

let javac = true;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); } catch { javac = false; }

const SRC = `package com.acme;

import java.util.*;

public class Order<T extends Comparable<T>> extends AbstractList<T> implements java.io.Serializable {
    public static final String NAME = "訂單";
    private static final long serialVersionUID = 1L;
    protected List<Map<String, T>> items = new ArrayList<>();
    public Order(int capacity) { }
    public T get(int index) { return null; }
    public int size() { return items.size() * 2; }
    public synchronized <R> R map(java.util.function.Function<T, R> fn, String... names) throws java.io.IOException { return null; }
    public enum Status { NEW, PAID }
    public class Line { int qty; }
}
`;

function compile(dir) {
  write(dir, 'src/com/acme/Order.java', SRC);
  execFileSync('javac', ['-parameters', '-encoding', 'UTF-8', '-d', path.join(dir, 'out'), path.join(dir, 'src/com/acme/Order.java')]);
  return path.join(dir, 'out', 'com', 'acme');
}

test('class 檔大綱（不需要 Java）：泛型、常數、可變參數、throws、列舉、內部類別', { skip: !javac && '沒有 javac' }, () => withTmp(async (dir) => {
  const out = compile(dir);
  const o = classfile.outline(fs.readFileSync(path.join(out, 'Order.class')));
  assert.equal(o.className, 'com.acme.Order');
  for (const s of [
    'package com.acme;',
    'public class Order<T extends Comparable<T>> extends java.util.AbstractList<T> implements java.io.Serializable {',
    '    public static final String NAME = "訂單";',
    '    private static final long serialVersionUID = 1L;',
    '    protected java.util.List<java.util.Map<String, T>> items;',
    '    public Order(int capacity) { /* 已編譯 */ }',
    '    public synchronized <R> R map(java.util.function.Function<T, R> fn, String... names) throws java.io.IOException { /* 已編譯 */ }',
  ]) assert.ok(o.text.includes(s), `缺少：${s}\n${o.text}`);
  const e = classfile.outline(fs.readFileSync(path.join(out, 'Order$Status.class'))).text;
  assert.ok(e.includes('enum Status {') && e.includes('    NEW,\n    PAID;') && !e.includes('values()'), e);
  const l = classfile.outline(fs.readFileSync(path.join(out, 'Order$Line.class'))).text;
  assert.ok(l.includes('public Line() {'), `不顯示編譯器加的 this$0：${l}`);
  assert.throws(() => classfile.outline(Buffer.from('not a class')), /不是 Java class/);
  assert.throws(() => classfile.outline(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0])), /不完整/);
}));

test('反編譯：有 Java 時用 CFR（含內部類別、中文字串），結果快取；找不到 Java 時退回大綱', { skip: !javac && '沒有 javac' }, () => withTmp(async (dir) => {
  const file = path.join(compile(dir), 'Order.class');
  const r = await decompiler.decompile(file);
  assert.equal(r.engine, 'cfr', r.note);
  assert.ok(r.text.includes('public class Order<T extends Comparable<T>>'), r.text);
  assert.ok(r.text.includes('return this.items.size() * 2;'), '有方法內容');
  assert.ok(r.text.includes('public static enum Status') && r.text.includes('public class Line'), '內部類別一起還原');
  assert.ok(r.text.includes('"訂單"'), '中文字串不跳脫');
  assert.equal(await decompiler.decompile(file), r, '快取');
  decompiler._reset();
  const o = await decompiler.decompile(file, { javaPath: path.join(dir, 'no-java') });
  assert.equal(o.engine, 'outline');
  assert.match(o.note, /設定的 java 執行檔無法執行/);
  assert.ok(o.text.includes('/* 已編譯 */'));
  write(dir, 'fake.class', 'hello');
  await assert.rejects(decompiler.decompile(path.join(dir, 'fake.class')), /不是 Java class/);
  assert.equal(decompiler.unescapeUnicode('"\\u4e2d" "\\\\u4e2d" "\\u0009" "\\u00e9"'), '"中" "\\\\u4e2d" "\\u0009" "é"');
}));
