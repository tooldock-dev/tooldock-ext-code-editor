'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ui/code-core');

test('語言判斷：副檔名、特殊檔名、認不出時為純文字', () => {
  assert.equal(C.langFor('/a/b/App.tsx'), 'typescript');
  assert.equal(C.langFor('C:\\x\\Program.CS'), 'csharp');
  assert.equal(C.langFor('Dockerfile'), 'dockerfile');
  assert.equal(C.langFor('Dockerfile.prod'), 'dockerfile');
  assert.equal(C.langFor('CMakeLists.txt'), 'cmake');
  assert.equal(C.langFor('.env.local'), 'bash');
  assert.equal(C.langFor('pkg.PKS'), 'sql');
  assert.equal(C.langFor('README'), 'plaintext');
  assert.equal(C.langFor('a.unknownext'), 'plaintext');
  // 對應到的語言都在選單裡
  const ids = new Set(C.LANGS.map(([id]) => id));
  for (const f of ['a.js', 'a.py', 'a.vue', 'a.yml', 'a.ps1', 'a.bat', 'a.kt', 'a.proto', 'a.toml', 'a.gradle']) assert.ok(ids.has(C.langFor(f)), f);
});

test('高亮分行：跨行的 span 在每行補上結束與重新開啟', () => {
  const html = 'a <span class="c">/* x\ny <span class="d">z\nw</span> */</span> b\nlast';
  const lines = C.splitHtmlLines(html);
  assert.deepEqual(lines, [
    'a <span class="c">/* x</span>',
    '<span class="c">y <span class="d">z</span></span>',
    '<span class="c"><span class="d">w</span> */</span> b',
    'last',
  ]);
  assert.deepEqual(C.splitHtmlLines(''), ['']);
  assert.deepEqual(C.splitHtmlLines('a\n'), ['a', '']);
});

test('縮排：單行插入對齊的空白、多行整段縮排與取消縮排', () => {
  assert.deepEqual(C.indent('ab', 1, 1, '    ', false), { from: 1, to: 1, insert: '   ', selStart: 4, selEnd: 4 });
  assert.deepEqual(C.indent('ab', 1, 1, '\t', false), { from: 1, to: 1, insert: '\t', selStart: 2, selEnd: 2 });
  const t = 'a\n  b\nc';
  const r = C.indent(t, 0, t.length, '  ', false);
  assert.equal(r.insert, '  a\n    b\n  c');
  const back = C.indent(r.insert, 0, r.insert.length, '  ', true);
  assert.equal(back.insert, t);
  assert.equal(C.indent('abc', 1, 1, '  ', true), null, '沒有縮排可取消');
});

test('Enter：延續縮排；括號後多縮一層，夾在成對括號中間時展開成三行', () => {
  assert.equal(C.newline('  foo', 5, 5, '  ').insert, '\n  ');
  assert.equal(C.newline('if (a) {', 8, 8, '  ').insert, '\n  ');
  const r = C.newline('f() {}', 5, 5, '    ');
  assert.equal(r.insert, '\n    \n');
  assert.equal(r.selStart, 10);
  assert.equal(C.newline('def f():', 8, 8, '    ').insert, '\n    ');
  assert.equal(C.newline('url: x:', 7, 7, '  ').insert, '\n', '一般的冒號不縮排');
});

test('切換註解：保留縮排、全部已註解時取消', () => {
  const t = '  a\n\n    b';
  const on = C.toggleComment(t, 0, t.length, '//');
  assert.equal(on.insert, '  // a\n\n  //   b');
  const off = C.toggleComment(on.insert, 0, on.insert.length, '//');
  assert.equal(off.insert, '  a\n\n    b');
  assert.equal(C.toggleComment('x = 1', 2, 2, '#').insert, '# x = 1');
  assert.equal(C.toggleComment('x', 0, 0, null), null);
  assert.equal(C.lineComment('python'), '#');
  assert.equal(C.lineComment('sql'), '--');
  assert.equal(C.lineComment('xml'), null);
});

/** 用 ops 從 a 重建 b，確認差異結果正確 */
function apply(a, b, ops) {
  const out = [];
  let ia = 0;
  for (const o of ops) {
    if (o.t === '=') { assert.equal(a[o.a], b[o.b]); assert.equal(o.a, ia); ia++; out.push(a[o.a]); } else if (o.t === '-') { assert.equal(o.a, ia); ia++; } else out.push(b[o.b]);
  }
  assert.equal(ia, a.length);
  return out;
}

test('差異比對：結果可以從舊版重建新版，且刪改最少', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f'];
  const b = ['a', 'x', 'c', 'd', 'f', 'g'];
  const ops = C.diffLines(a, b);
  assert.deepEqual(apply(a, b, ops), b);
  assert.deepEqual(C.diffStats(ops), { added: 2, removed: 2 });
  assert.deepEqual(C.diffLines([], ['x']), [{ t: '+', b: 0 }]);
  assert.deepEqual(C.diffLines(['x'], []), [{ t: '-', a: 0 }]);
  assert.deepEqual(C.diffLines(['x'], ['x']), [{ t: '=', a: 0, b: 0 }]);
});

test('差異比對：隨機資料皆能正確重建；超過上限時退回整段取代', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 200; k++) {
    const a = Array.from({ length: rnd(30) }, () => String(rnd(6)));
    const b = Array.from({ length: rnd(30) }, () => String(rnd(6)));
    assert.deepEqual(apply(a, b, C.diffLines(a, b)), b);
  }
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
  const ops = C.diffLines(a, b, 3);
  assert.deepEqual(apply(a, b, ops), b);
  assert.deepEqual(C.diffStats(ops), { added: 50, removed: 50 });
});

test('並排與行內的列；未變更的長段落摺疊', () => {
  const a = C.toLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nold\n12\n');
  const b = C.toLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nnew\nadded\n12\n');
  assert.equal(a.length, 12, '結尾換行不算一行');
  const ops = C.diffLines(a, b);
  const sbs = C.sideBySide(ops);
  assert.deepEqual(sbs.filter((r) => r.kind !== 'eq'), [{ kind: 'mod', a: 10, b: 10 }, { kind: 'add', a: null, b: 11 }]);
  const uni = C.unified(ops);
  assert.deepEqual(uni.filter((r) => r.kind !== 'eq').map((r) => r.kind), ['del', 'add', 'add']);
  const folded = C.fold(sbs, 3);
  assert.deepEqual(folded[0], { kind: 'fold', start: 0, count: 7 }, '開頭留 3 行前後文');
  assert.equal(folded.length, 1 + 3 + 2 + 1);
  assert.equal(C.fold(sbs, 3, new Set([0])).length, sbs.length, '展開後全部顯示');
});

test('變更分段：與並排比對的分段一致；逐段改回左側內容', () => {
  const a = C.toLines('a\nb\nc\nd\ne\nf\n');
  const b = C.toLines('a\nB\nc\nd\nx\ny\ne\n');
  const hs = C.hunks(C.diffLines(a, b));
  assert.deepEqual(hs, [
    { aStart: 1, aLen: 1, bStart: 1, bLen: 1 },
    { aStart: 4, aLen: 0, bStart: 4, bLen: 2 },
    { aStart: 5, aLen: 1, bStart: 7, bLen: 0 },
  ]);
  assert.deepEqual(C.revertHunk(a, b, hs[0]), ['a', 'b', 'c', 'd', 'x', 'y', 'e']);
  assert.deepEqual(C.revertHunk(a, b, hs[1]), ['a', 'B', 'c', 'd', 'e']);
  assert.deepEqual(C.revertHunk(a, b, hs[2]), ['a', 'B', 'c', 'd', 'x', 'y', 'e', 'f']);
  // 每一段都改回去就等於左側
  let cur = b;
  for (let i = hs.length - 1; i >= 0; i--) cur = C.revertHunk(a, cur, hs[i]);
  assert.deepEqual(cur, a);
  assert.ok(C.sameHunk(hs[1], { ...hs[1] }));
  assert.ok(!C.sameHunk(hs[1], hs[2]));
  // 隨機資料：分段數與並排比對的變更區塊數相同
  let seed = 3;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 100; k++) {
    const x = Array.from({ length: rnd(20) }, () => String(rnd(4)));
    const y = Array.from({ length: rnd(20) }, () => String(rnd(4)));
    const ops = C.diffLines(x, y);
    const rows = C.sideBySide(ops);
    const starts = rows.filter((r, i) => r.kind !== 'eq' && (i === 0 || rows[i - 1].kind === 'eq')).length;
    const h = C.hunks(ops);
    assert.equal(h.length, starts);
    let z = y;
    for (let i = h.length - 1; i >= 0; i--) z = C.revertHunk(x, z, h[i]);
    assert.deepEqual(z, x);
  }
});

test('跨檔案搜尋：行欄位置、大小寫、整個字、規則運算式、預覽', () => {
  const text = 'const foo = 1;\nlet Foo2 = foo + food;\n\tfoo();\n';
  const find = (o) => C.findInText(text, C.searchRegex(o)).matches;
  assert.deepEqual(find({ query: 'foo' }).map((m) => [m.line, m.col]), [[1, 7], [2, 5], [2, 12], [2, 18], [3, 2]]);
  assert.equal(find({ query: 'foo', caseSens: true }).length, 4);
  assert.deepEqual(find({ query: 'foo', word: true }).map((m) => [m.line, m.col]), [[1, 7], [2, 12], [3, 2]]);
  assert.deepEqual(find({ query: 'fo+\\d', regex: true }).map((m) => m.text), ['Foo2']);
  assert.equal(find({ query: 'a.b' }).length, 0, '一般模式不把 . 當萬用字元');
  const m = find({ query: 'food' })[0];
  assert.equal(text.slice(m.start, m.end), 'food');
  assert.equal(m.before, 'let Foo2 = foo + ');
  assert.equal(m.after, ';');
  assert.equal(m.cut, false);
  assert.equal(C.searchRegex({ query: '' }), null);
  assert.throws(() => C.searchRegex({ query: '(', regex: true }));
  // 長的行：前面截掉；跨行的符合只顯示第一行
  const long = `${'x'.repeat(100)}needle tail`;
  const lm = C.findInText(long, C.searchRegex({ query: 'needle' })).matches[0];
  assert.equal(lm.cut, true);
  assert.equal(lm.before.length, 50);
  const ml = C.findInText('a\nbc\nd', C.searchRegex({ query: 'b[^]*d', regex: true })).matches[0];
  assert.equal(ml.multi, true);
  assert.equal(ml.text, 'bc\nd');
  // 上限
  const r = C.findInText('aaaa', C.searchRegex({ query: 'a' }), { limit: 2 });
  assert.equal(r.matches.length, 2);
  assert.equal(r.truncated, true);
  // 空字串的符合不會卡住
  assert.equal(C.findInText('abc', C.searchRegex({ query: 'x*', regex: true })).matches.length, 0);
});

test('取代字串：$1、$<name>、$&、$$、\\n；一般模式照原樣', () => {
  const re = C.searchRegex({ query: '(?<k>\\w+)=(\\d+)', regex: true });
  const m = C.findInText('a=1', re, { groups: true }).matches[0];
  assert.equal(C.expandReplacement('$2:$1', m, true), '1:a');
  assert.equal(C.expandReplacement('$<k>-$&-$0-$$1', m, true), 'a-a=1-a=1-$1');
  assert.equal(C.expandReplacement('x\\ny\\t\\\\', m, true), 'x\ny\t\\');
  assert.equal(C.expandReplacement('$9', m, true), '$9', '沒有的群組照原樣');
  assert.equal(C.expandReplacement('$1\\n', m, false), '$1\\n');
  const g = C.findInText('abcdefghijkl', C.searchRegex({ query: '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', regex: true }), { groups: true }).matches[0];
  assert.equal(C.expandReplacement('$11$10', g, true), 'kj');
});

test('套用取代：檢查原文、不能重疊', () => {
  const text = 'one two one';
  assert.equal(C.applyReplacements(text, [
    { start: 8, end: 11, text: 'one', replacement: '1' },
    { start: 0, end: 3, text: 'one', replacement: 'ONE' },
  ]), 'ONE two 1');
  assert.equal(C.applyReplacements(text, [{ start: 0, end: 3, text: 'two', replacement: '' }]), null, '原文不同');
  assert.equal(C.applyReplacements(text, [
    { start: 0, end: 3, text: 'one', replacement: '' },
    { start: 2, end: 5, text: 'e t', replacement: '' },
  ]), null, '重疊');
});

test('檔案篩選：名稱、資料夾、根目錄路徑、** 與大括號', () => {
  const f = (inc, exc) => C.pathFilter(inc, exc);
  const files = ['a.js', 'src/b.ts', 'src/c.js', 'src/lib/d.min.js', 'test/e.js', 'docs/test.md', 'node/x.json'];
  const pick = (fn) => files.filter(fn);
  assert.deepEqual(pick(f('*.js')), ['a.js', 'src/c.js', 'src/lib/d.min.js', 'test/e.js']);
  assert.deepEqual(pick(f('src/')), ['src/b.ts', 'src/c.js', 'src/lib/d.min.js']);
  assert.deepEqual(pick(f('src/*.js')), ['src/c.js'], '有 / 時從根目錄比對，* 不跨資料夾');
  assert.deepEqual(pick(f('src/**/*.js')), ['src/c.js', 'src/lib/d.min.js']);
  assert.deepEqual(pick(f('*.{ts,md}')), ['src/b.ts', 'docs/test.md']);
  assert.deepEqual(pick(f('', 'test, *.min.js')), ['a.js', 'src/b.ts', 'src/c.js', 'docs/test.md', 'node/x.json'], 'test 只排除叫 test 的資料夾或檔案');
  assert.deepEqual(pick(f('*.js, *.json', 'src')), ['a.js', 'test/e.js', 'node/x.json']);
  assert.deepEqual(C.splitList('*.{js,ts}, a ,,b'), ['*.{js,ts}', 'a', 'b']);
  assert.ok(f('SRC/')('src/b.ts'), '不分大小寫');
});
