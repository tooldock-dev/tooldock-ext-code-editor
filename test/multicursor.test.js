'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ui/code-core');

const caret = (pos, p) => ({ a: pos, h: pos, ...(p ? { p: true } : {}) });
const pos = (sels) => sels.map((s) => (s.a === s.h ? s.h : [s.a, s.h]));
const wordAt = (text, p) => { const w = C.wordAt(text, p, 'javascript'); return w && { start: w.start, end: w.end }; };

test('多游標：排序、合併重疊與同一點的游標，剛好一個主要游標', () => {
  const s = C.normalizeSels([caret(5), { a: 2, h: 6 }, caret(9, true), caret(9), { a: 12, h: 10, p: true }]);
  assert.deepEqual(pos(s), [[2, 6], 9, [12, 10]]);
  assert.equal(s.filter((x) => x.p).length, 1);
  assert.equal(C.primaryOf(s).h, 9);
  assert.equal(C.normalizeSels([caret(1), caret(3)]).filter((x) => x.p).length, 1);
});

test('多游標：每個游標插入文字，一次編輯涵蓋所有位置', () => {
  const text = 'a\nb\nc';
  const r = C.insertAtSels(text, [caret(1), caret(3), caret(5, true)], ';');
  assert.equal(r.text, 'a;\nb;\nc;');
  assert.equal(text.slice(0, r.from) + r.insert + text.slice(r.to), r.text);
  assert.deepEqual(pos(r.sels), [2, 5, 8]);
  assert.equal(C.primaryOf(r.sels).h, 8);
  // 取代選取；陣列依序分配（貼上與選取數量相同的多行文字）
  const r2 = C.insertAtSels('x1 x2 x3', [{ a: 0, h: 2 }, { a: 3, h: 5 }, { a: 6, h: 8 }], ['A', 'BB', 'C']);
  assert.equal(r2.text, 'A BB C');
  assert.deepEqual(pos(r2.sels), [1, 4, 6]);
});

test('多游標：Backspace／Delete、以字為單位刪除、行首不再往前', () => {
  assert.equal(C.deleteAtSels('ab\ncd', [caret(2), caret(5)], false).text, 'a\nc');
  assert.equal(C.deleteAtSels('ab\ncd', [caret(0), caret(3)], true).text, 'b\nd');
  assert.equal(C.deleteAtSels('ab', [caret(0)], false), null);
  assert.equal(C.deleteAtSels('foo bar\nfoo baz', [caret(7), caret(15)], false, true).text, 'foo \nfoo ');
  // 表情符號（surrogate pair）整個刪掉
  assert.equal(C.deleteAtSels('a😀\nb😀', [caret(3), caret(7)], false).text, 'a\nb');
});

test('多游標：Enter 延續縮排、Tab 縮排、同一行的兩個游標只取消縮排一次', () => {
  const r = C.newlineAtSels('  a\n  b', [caret(3), caret(7)], '  ');
  assert.equal(r.text, '  a\n  \n  b\n  ');
  assert.deepEqual(pos(r.sels), [6, 13]);
  assert.equal(C.indentSels('a\nb', [caret(0), caret(2)], '  ').text, '  a\n  b');
  assert.equal(C.indentSels('    ab', [caret(4), caret(5)], '  ', true).text, '  ab');
});

test('列選取：矩形每行一個選取，略過太短的行；寬度 0 時每行都有游標', () => {
  const text = 'abcdef\nab\nabcdef\n\nabcdef';
  const s = C.columnSels(text, 0, 2, 4, 4);
  assert.deepEqual(s.map((x) => text.slice(x.a, x.h)), ['cd', 'cd', 'cd']);
  assert.equal(C.lineIndexAt(text, C.primaryOf(s).h), 4);
  const z = C.columnSels(text, 0, 3, 3, 3);
  assert.equal(z.length, 4);
  const r = C.insertAtSels(text, z, '|');
  assert.equal(r.text, 'abc|def\nab|\nabc|def\n|\nabcdef');
  // 從下往上拖：主要游標在第 0 行
  const up = C.columnSels(text, 2, 1, 0, 1);
  assert.equal(C.lineIndexAt(text, C.primaryOf(up).h), 0);
});

test('列選取：全形字與 Tab 依顯示欄位對齊', () => {
  assert.equal(C.visualCol('中文ab', 2), 4);
  assert.equal(C.visualCol('\tx', 1, 4), 4);
  assert.equal(C.offsetAtCol('中文ab', 4).off, 2);
  assert.equal(C.offsetAtCol('中文ab', 3).off, 2); // 在「文」的右半邊，靠近後面的邊界
  assert.deepEqual(C.offsetAtCol('ab', 9), { off: 2, past: true });
  const text = '中文ab\nabcdef';
  const s = C.columnSels(text, 0, 4, 1, 4);
  assert.deepEqual(s.map((x) => x.h), [2, 9]);
});

test('多游標：移動（左右收合選取、以字移動、Home 在第一個非空白字元與行首間切換、上下保留欄位）', () => {
  const text = '  foo bar\nx\n  foo bar';
  let s = C.moveSels(text, [{ a: 2, h: 5 }, { a: 14, h: 17, p: true }], 'Left');
  assert.deepEqual(pos(s), [2, 14]);
  s = C.moveSels(text, [caret(2), caret(14, true)], 'Right', { word: true });
  assert.deepEqual(pos(s), [5, 17]);
  s = C.moveSels(text, [caret(5), caret(17, true)], 'Home');
  assert.deepEqual(pos(s), [2, 14]);
  s = C.moveSels(text, s, 'Home');
  assert.deepEqual(pos(s), [0, 12]);
  s = C.moveSels(text, [caret(5), caret(17, true)], 'End', { extend: true });
  assert.deepEqual(pos(s), [[5, 9], [17, 21]]);
  // 往下經過短的行之後回到原本的欄位
  let d = C.moveSels(text, [caret(7, true)], 'Down');
  assert.equal(d[0].h, 11);
  d = C.moveSels(text, d, 'Down');
  assert.equal(d[0].h, 19);
  // 兩個游標移到同一點時合併
  assert.equal(C.moveSels('ab', [caret(1), caret(2, true)], 'End').length, 1);
});

test('多游標：⌥⌘↑↓ 在上下一行同一欄加游標，到頭時回傳 null', () => {
  const text = 'abcd\nab\nabcd';
  let s = C.addCaretVertical(text, [caret(3, true)], 1);
  assert.deepEqual(pos(s), [3, 7]);
  assert.equal(C.primaryOf(s).h, 7);
  s = C.addCaretVertical(text, s, 1);
  assert.deepEqual(pos(s), [3, 7, 11]); // 經過短行後仍回到第 3 欄
  assert.equal(C.addCaretVertical(text, s, 1), null);
  assert.equal(C.addCaretVertical(text, [caret(2)], -1), null);
});

test('多游標：⌘D 先選字、再選下一個（只找整個字）、到結尾從頭找；⇧⌘L 全部選取', () => {
  const text = 'foo food foo\nfoo';
  let r = C.nextOccurrence(text, [caret(1, true)], { wordAt });
  assert.deepEqual(pos(r.sels), [[0, 3]]);
  assert.equal(r.word, true);
  r = C.nextOccurrence(text, r.sels, { word: r.word, wordAt });
  assert.deepEqual(pos(r.sels), [[0, 3], [9, 12]]);
  r = C.nextOccurrence(text, r.sels, { word: true, wordAt });
  assert.deepEqual(pos(r.sels), [[0, 3], [9, 12], [13, 16]]);
  assert.equal(C.nextOccurrence(text, r.sels, { word: true, wordAt }), null);
  // 選取不是從游標開始時不限整個字：food 裡的 foo 也算；從中間開始時會繞回前面
  const w = C.nextOccurrence(text, [{ a: 9, h: 12, p: true }], { wordAt });
  assert.deepEqual(pos(w.sels), [[9, 12], [13, 16]]);
  const wrap = C.nextOccurrence(text, w.sels, { wordAt });
  assert.deepEqual(pos(wrap.sels), [[0, 3], [9, 12], [13, 16]]);
  const all = C.allOccurrences(text, [caret(14, true)], { wordAt });
  assert.equal(all.length, 3);
  assert.equal(C.primaryOf(all).a, 13);
  assert.equal(C.allOccurrences(text, [{ a: 0, h: 3 }]).length, 4);
});

test('多游標：選取的文字、插入數字序列', () => {
  assert.deepEqual(C.selectedTexts('ab cd', [{ a: 3, h: 5 }, { a: 0, h: 2 }]), ['ab', 'cd']);
  assert.equal(C.sequenceAtSels('a\nb\nc', [caret(0), caret(2), caret(4)], { start: 8, step: 1, pad: 2 }).text, '08a\n09b\n10c');
  assert.equal(C.sequenceAtSels('a\nb', [caret(0), caret(2)], { start: 0, step: -5 }).text, '0a\n-5b');
});

test('分享：CSV 解析（引號、引號內換行、跳脫、CRLF、BOM、分號分隔）', () => {
  const { rows, delimiter } = C.parseCsv('﻿名稱,說明\r\n"A,1","第一行\n第二行"\r\nB,"他說""好"""\r\n\r\n');
  assert.equal(delimiter, ',');
  assert.deepEqual(rows, [['名稱', '說明'], ['A,1', '第一行\n第二行'], ['B', '他說"好"']]);
  assert.equal(C.guessDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(C.guessDelimiter('a\tb\n1\t2'), '\t');
  const t = C.csvToTable('id,name,,name\n001,王小明\n002,李,x,y,z\n');
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'name', '欄位 3', 'name (2)', '欄位 5']);
  assert.ok(t.columns.every((c) => c.type === 'string'));
  assert.deepEqual(t.rows[0], ['001', '王小明', null, null, null]);
  assert.equal(t.rows[1].length, 5);
  assert.throws(() => C.csvToTable('\n\n'), /沒有內容/);
});

test('分享：JSON 轉表格（物件陣列取鍵的聯集、二維陣列、包在單一屬性裡、巢狀值與大整數）', () => {
  const t = C.jsonToTable([{ a: 1, b: 'x' }, { b: 'y', c: { d: 1 } }, { a: 9007199254740993 }]);
  assert.deepEqual(t.columns.map((c) => c.name), ['a', 'b', 'c']);
  assert.deepEqual(t.rows[0], [1, 'x', null]);
  assert.deepEqual(t.rows[1], [null, 'y', { type: 'json', value: { d: 1 } }]);
  assert.equal(t.rows[2][0].type, 'bigint');
  const g = C.jsonToTable([['姓名', '時數'], ['A', 1.5], ['B']]);
  assert.deepEqual(g.columns.map((c) => c.name), ['姓名', '時數']);
  assert.deepEqual(g.rows, [['A', 1.5], ['B', null]]);
  assert.equal(C.jsonToTable({ total: 2, data: [{ x: 1 }] }).rows.length, 1);
  assert.equal(C.jsonToTable({ a: 1 }), null);
  assert.equal(C.jsonToTable([1, 2, 3]), null);
  assert.equal(C.jsonToTable([]), null);
});

test('分享：依副檔名決定方式', () => {
  assert.deepEqual(C.shareKinds('README.MD'), [{ kind: 'text', mime: 'text/markdown' }]);
  assert.deepEqual(C.shareKinds('a.csv').map((k) => k.kind), ['table', 'text']);
  assert.equal(C.shareKinds('a.json')[1].mime, 'application/json');
  assert.deepEqual(C.shareKinds('a.js'), []);
});
