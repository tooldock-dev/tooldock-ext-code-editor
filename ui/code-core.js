/**
 * 程式碼編輯器核心：語言判斷、高亮結果分行、行差異比對（Myers）、並排／行內比對的列。
 * 全部是純函式；畫面以 <script> 載入（window.CodeCore），npm test 直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodeCore = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /* ───────────── 語言 ───────────── */

  /** 語言選單：[highlight.js 語言 id, 顯示名稱]；id 對應 node_modules/highlight.js/es/languages/<id>.js */
  const LANGS = [
    ['plaintext', '純文字'], ['bash', 'Shell'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['clojure', 'Clojure'],
    ['cmake', 'CMake'], ['css', 'CSS'], ['dart', 'Dart'], ['diff', 'Diff'], ['dockerfile', 'Dockerfile'], ['dos', 'Batch'],
    ['elixir', 'Elixir'], ['erlang', 'Erlang'], ['fsharp', 'F#'], ['go', 'Go'], ['gradle', 'Gradle'], ['graphql', 'GraphQL'],
    ['groovy', 'Groovy'], ['haskell', 'Haskell'], ['ini', 'INI / TOML'], ['java', 'Java'], ['javascript', 'JavaScript'],
    ['json', 'JSON'], ['julia', 'Julia'], ['kotlin', 'Kotlin'], ['latex', 'LaTeX'], ['less', 'Less'], ['lua', 'Lua'],
    ['makefile', 'Makefile'], ['markdown', 'Markdown'], ['matlab', 'MATLAB'], ['nginx', 'Nginx'], ['objectivec', 'Objective-C'],
    ['perl', 'Perl'], ['php', 'PHP'], ['powershell', 'PowerShell'], ['properties', 'Properties'], ['protobuf', 'Protobuf'],
    ['python', 'Python'], ['r', 'R'], ['ruby', 'Ruby'], ['rust', 'Rust'], ['scala', 'Scala'], ['scss', 'SCSS'], ['sql', 'SQL'],
    ['swift', 'Swift'], ['typescript', 'TypeScript'], ['vbnet', 'VB.NET'], ['vbscript', 'VBScript'], ['verilog', 'Verilog'],
    ['vhdl', 'VHDL'], ['x86asm', 'x86 組合語言'], ['xml', 'HTML / XML'], ['yaml', 'YAML'],
  ];
  const LANG_NAME = Object.fromEntries(LANGS);

  const BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', jsonc: 'json', json5: 'json', ipynb: 'json', webmanifest: 'json',
    html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', xaml: 'xml', xsd: 'xml', xsl: 'xml',
    csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', plist: 'xml', config: 'xml', resx: 'xml', jsp: 'xml', aspx: 'xml', cshtml: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    py: 'python', pyw: 'python', pyi: 'python', java: 'java', cs: 'csharp', csx: 'csharp',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
    go: 'go', rs: 'rust', php: 'php', rb: 'ruby', erb: 'ruby', sql: 'sql', pks: 'sql', pkb: 'sql', prc: 'sql', fnc: 'sql', trg: 'sql',
    sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', env: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'dos', cmd: 'dos', yml: 'yaml', yaml: 'yaml', ini: 'ini', cfg: 'ini', conf: 'ini', toml: 'ini', editorconfig: 'ini',
    properties: 'properties', md: 'markdown', markdown: 'markdown', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
    m: 'objectivec', mm: 'objectivec', dart: 'dart', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', scala: 'scala', sc: 'scala',
    groovy: 'groovy', gradle: 'gradle', vb: 'vbnet', vbs: 'vbscript', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
    proto: 'protobuf', cmake: 'cmake', hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', cljs: 'clojure',
    fs: 'fsharp', fsx: 'fsharp', jl: 'julia', tex: 'latex', asm: 'x86asm', s: 'x86asm', v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  };
  const BY_NAME = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', 'cmakelists.txt': 'cmake',
    gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'groovy', '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash',
    '.bash_profile': 'bash', '.env': 'bash', '.gitignore': 'bash', '.npmrc': 'ini', '.gitconfig': 'ini', 'nginx.conf': 'nginx',
  };

  /** 依檔名判斷語言；認不出時為 plaintext */
  function langFor(filename) {
    const name = String(filename || '').split(/[\\/]/).pop().toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    if (/^dockerfile\./.test(name)) return 'dockerfile';
    if (/^\.env\./.test(name)) return 'bash';
    const dot = name.lastIndexOf('.');
    return (dot >= 0 && BY_EXT[name.slice(dot + 1)]) || 'plaintext';
  }

  const SLASH = ['javascript', 'typescript', 'java', 'csharp', 'c', 'cpp', 'go', 'rust', 'php', 'kotlin', 'swift', 'dart', 'scala', 'groovy', 'gradle', 'objectivec', 'fsharp', 'protobuf', 'less', 'scss', 'verilog', 'json'];
  const HASH = ['python', 'bash', 'ruby', 'perl', 'r', 'yaml', 'powershell', 'elixir', 'dockerfile', 'makefile', 'cmake', 'properties', 'julia', 'nginx', 'graphql'];
  const DASH = ['sql', 'lua', 'haskell', 'vhdl'];
  /** 行註解符號（⌘/ 切換註解）；沒有行註解的語言回傳 null */
  function lineComment(lang) {
    if (SLASH.includes(lang)) return '//';
    if (HASH.includes(lang)) return '#';
    if (DASH.includes(lang)) return '--';
    if (lang === 'vbnet' || lang === 'vbscript') return "'";
    if (lang === 'ini' || lang === 'clojure' || lang === 'x86asm') return ';';
    if (lang === 'latex' || lang === 'matlab' || lang === 'erlang') return '%';
    if (lang === 'dos') return 'REM ';
    return null;
  }

  /* ───────────── 文字 ───────────── */

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

  /**
   * 把 highlight.js 的結果（只含 <span class> 與 </span>）切成每行一段：
   * 跨行的 span（多行註解、字串）在行尾補上結束標籤，下一行開頭再重新開啟，讓每行都是完整的 HTML。
   */
  function splitHtmlLines(html) {
    const lines = [];
    const stack = [];
    let cur = '';
    let last = 0;
    const re = /<span[^>]*>|<\/span>|\n/g;
    let m;
    while ((m = re.exec(html))) {
      cur += html.slice(last, m.index);
      last = re.lastIndex;
      if (m[0] === '\n') {
        lines.push(cur + '</span>'.repeat(stack.length));
        cur = stack.join('');
      } else if (m[0] === '</span>') {
        stack.pop();
        cur += m[0];
      } else {
        stack.push(m[0]);
        cur += m[0];
      }
    }
    lines.push(cur + html.slice(last));
    return lines;
  }

  function cursorInfo(text, pos) {
    const before = text.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    return { line, col: pos - before.lastIndexOf('\n') };
  }

  /** 第 line 行（從 1 起算）的開頭位置 */
  function lineStart(text, line) {
    let pos = 0;
    for (let i = 1; i < line; i++) {
      const n = text.indexOf('\n', pos);
      if (n < 0) return pos;
      pos = n + 1;
    }
    return pos;
  }

  /** 選取範圍涵蓋的整行 [from, to)（不含最後的換行）；選取結尾剛好在行首時不含那一行 */
  function lineRange(text, s, e) {
    const end = e > s && text[e - 1] === '\n' ? e - 1 : e;
    const from = text.lastIndexOf('\n', s - 1) + 1;
    let to = text.indexOf('\n', end);
    if (to < 0) to = text.length;
    return [from, to];
  }

  const edit = (from, to, insert, selStart, selEnd = selStart) => ({ from, to, insert, selStart, selEnd });

  /** Tab / Shift+Tab：有跨行選取時整段縮排或取消縮排；否則在游標插入縮排 */
  function indent(text, s, e, unit, outdent) {
    const multi = text.slice(s, e).includes('\n');
    if (!multi && !outdent) {
      if (unit === '\t') return edit(s, e, '\t', s + 1);
      const col = s - (text.lastIndexOf('\n', s - 1) + 1);
      const n = unit.length - (col % unit.length);
      return edit(s, e, ' '.repeat(n), s + n);
    }
    const [from, to] = lineRange(text, s, e);
    const lines = text.slice(from, to).split('\n');
    let firstDelta = 0;
    const out = lines.map((l, i) => {
      if (!outdent) { if (i === 0) firstDelta = unit.length; return l ? unit + l : l; }
      const m = l.match(unit === '\t' ? /^(\t| {1,4})/ : new RegExp(`^( {1,${unit.length}}|\\t)`));
      const cut = m ? m[0].length : 0;
      if (i === 0) firstDelta = -cut;
      return l.slice(cut);
    }).join('\n');
    if (out === text.slice(from, to)) return null;
    const lineStartOfS = text.lastIndexOf('\n', s - 1) + 1;
    const newS = multi ? from : Math.max(lineStartOfS, s + firstDelta);
    return edit(from, to, out, newS, multi ? from + out.length : Math.max(lineStartOfS, e + firstDelta));
  }

  /** Enter：延續上一行的縮排；行尾是 { ( [ : 時多縮一層 */
  function newline(text, s, e, unit) {
    const ls = text.lastIndexOf('\n', s - 1) + 1;
    const line = text.slice(ls, s);
    let ind = (line.match(/^[ \t]*/) || [''])[0];
    const prev = line.trimEnd();
    const next = text[e];
    if (/[{[(]$/.test(prev)) {
      const close = { '{': '}', '[': ']', '(': ')' }[prev.slice(-1)];
      if (next === close) {
        const ins = `\n${ind}${unit}\n${ind}`;
        return edit(s, e, ins, s + 1 + ind.length + unit.length);
      }
      ind += unit;
    } else if (/:$/.test(prev) && /^\s*(if|elif|else|for|while|def|class|try|except|finally|with|case|match)\b/.test(line)) {
      ind += unit;
    }
    return edit(s, e, `\n${ind}`, s + 1 + ind.length);
  }

  /** ⌘/：所有非空白行都已註解時取消註解，否則加上註解 */
  function toggleComment(text, s, e, token) {
    if (!token) return null;
    const [from, to] = lineRange(text, s, e);
    const lines = text.slice(from, to).split('\n');
    const t = token.trimEnd();
    const body = lines.filter((l) => l.trim());
    if (!body.length) return null;
    const commented = body.every((l) => l.trimStart().startsWith(t));
    const minInd = Math.min(...body.map((l) => l.match(/^[ \t]*/)[0].length));
    let delta0 = 0;
    const out = lines.map((l, i) => {
      if (!l.trim()) return l;
      if (commented) {
        const ind = l.match(/^[ \t]*/)[0].length;
        const rest = l.slice(ind + t.length);
        const cut = t.length + (rest.startsWith(' ') ? 1 : 0);
        if (i === 0) delta0 = -cut;
        return l.slice(0, ind) + l.slice(ind + cut);
      }
      if (i === 0) delta0 = token.length + (token.endsWith(' ') ? 0 : 1);
      return `${l.slice(0, minInd)}${token}${token.endsWith(' ') ? '' : ' '}${l.slice(minInd)}`;
    }).join('\n');
    const single = !text.slice(s, e).includes('\n');
    if (single) return edit(from, to, out, Math.max(from, s + delta0), Math.max(from, e + delta0));
    return edit(from, to, out, from, from + out.length);
  }

  /* ───────────── 差異比對 ───────────── */

  /** 文字 → 行陣列；結尾的換行不另算一行（與 git 相同） */
  function toLines(text) {
    if (!text) return [];
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /**
   * Myers O(ND) 差異：回傳 [{ t: '=', a, b } | { t: '-', a } | { t: '+', b }]（a / b 為行索引）。
   * 先去掉相同的開頭與結尾；差異超過 maxD 時，中間整段視為刪除後新增（避免大檔案耗盡記憶體）。
   */
  function diffLines(a, b, maxD = 2000) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const ops = [];
    for (let i = 0; i < s; i++) ops.push({ t: '=', a: i, b: i });
    for (const op of myers(a.slice(s, ea), b.slice(s, eb), maxD)) {
      if (op.t === '=') ops.push({ t: '=', a: op.a + s, b: op.b + s });
      else if (op.t === '-') ops.push({ t: '-', a: op.a + s });
      else ops.push({ t: '+', b: op.b + s });
    }
    for (let i = 0; i < a.length - ea; i++) ops.push({ t: '=', a: ea + i, b: eb + i });
    return ops;
  }

  function myers(A, B, maxD) {
    const N = A.length, M = B.length;
    const replaceAll = () => [...A.map((_, a) => ({ t: '-', a })), ...B.map((_, b) => ({ t: '+', b }))];
    if (!N || !M) return replaceAll();
    // 行轉成整數比較較快
    const ids = new Map();
    const id = (l) => { let v = ids.get(l); if (v === undefined) { v = ids.size; ids.set(l, v); } return v; };
    const a = Int32Array.from(A, id), b = Int32Array.from(B, id);
    const max = N + M;
    const V = new Int32Array(2 * max + 3);
    const off = max + 1;
    const trace = [];
    let D = -1;
    for (let d = 0; d <= Math.min(max, maxD); d++) {
      trace.push(V.slice(off - d - 1, off + d + 2)); // 這一步之前的狀態，k ∈ [-d-1, d+1]
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        V[off + k] = x;
        if (x >= N && y >= M) { D = d; break; }
      }
      if (D >= 0) break;
    }
    if (D < 0) return replaceAll();
    const ops = [];
    let x = N, y = M;
    for (let d = D; d > 0; d--) {
      const P = trace[d];
      const get = (k) => P[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
      const prevX = get(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; ops.push({ t: '=', a: x, b: y }); }
      if (x === prevX) { y--; ops.push({ t: '+', b: y }); } else { x--; ops.push({ t: '-', a: x }); }
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { x--; y--; ops.push({ t: '=', a: x, b: y }); }
    return ops.reverse();
  }

  /** 把連續的刪除與新增整理成一組（先刪後增） */
  function blocks(ops) {
    const out = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].t === '=') { out.push({ eq: ops[i] }); i++; continue; }
      const del = [], add = [];
      while (i < ops.length && ops[i].t !== '=') { (ops[i].t === '-' ? del : add).push(ops[i]); i++; }
      out.push({ del, add });
    }
    return out;
  }

  /** 並排比對的列：{ kind: 'eq'|'mod'|'del'|'add', a, b }（a / b 為行索引或 null） */
  function sideBySide(ops) {
    const rows = [];
    for (const blk of blocks(ops)) {
      if (blk.eq) { rows.push({ kind: 'eq', a: blk.eq.a, b: blk.eq.b }); continue; }
      const n = Math.max(blk.del.length, blk.add.length);
      for (let i = 0; i < n; i++) {
        const d = blk.del[i], p = blk.add[i];
        rows.push({ kind: d && p ? 'mod' : d ? 'del' : 'add', a: d ? d.a : null, b: p ? p.b : null });
      }
    }
    return rows;
  }

  /** 行內比對的列：{ kind: 'eq'|'del'|'add', a, b } */
  function unified(ops) {
    const rows = [];
    for (const blk of blocks(ops)) {
      if (blk.eq) { rows.push({ kind: 'eq', a: blk.eq.a, b: blk.eq.b }); continue; }
      for (const d of blk.del) rows.push({ kind: 'del', a: d.a, b: null });
      for (const p of blk.add) rows.push({ kind: 'add', a: null, b: p.b });
    }
    return rows;
  }

  /**
   * 摺疊沒有變更的長段落，前後各留 context 行：回傳列與 { kind: 'fold', start, count }（start 為原列索引）。
   * expanded 是已展開的 fold start 集合。
   */
  function fold(rows, context = 3, expanded = new Set()) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== 'eq') { out.push(rows[i]); i++; continue; }
      let j = i;
      while (j < rows.length && rows[j].kind === 'eq') j++;
      const head = i === 0 ? 0 : context;
      const tail = j === rows.length ? 0 : context;
      const hidden = j - i - head - tail;
      if (hidden > 1 && !expanded.has(i + head)) {
        for (let k = i; k < i + head; k++) out.push(rows[k]);
        out.push({ kind: 'fold', start: i + head, count: hidden });
        for (let k = j - tail; k < j; k++) out.push(rows[k]);
      } else {
        for (let k = i; k < j; k++) out.push(rows[k]);
      }
      i = j;
    }
    return out;
  }

  function diffStats(ops) {
    let added = 0, removed = 0;
    for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
    return { added, removed };
  }

  /** 每一段變更：{ aStart, aLen, bStart, bLen }（與 blocks 的分段相同，順序也相同） */
  function hunks(ops) {
    const out = [];
    let ai = 0, bi = 0, cur = null;
    for (const o of ops) {
      if (o.t === '=') { cur = null; ai = o.a + 1; bi = o.b + 1; continue; }
      if (!cur) { cur = { aStart: ai, aLen: 0, bStart: bi, bLen: 0 }; out.push(cur); }
      if (o.t === '-') { cur.aLen++; ai = o.a + 1; } else { cur.bLen++; bi = o.b + 1; }
    }
    return out;
  }

  /** 把右側（b）的一段變更改回左側（a）的內容，回傳新的 b 行陣列 */
  function revertHunk(a, b, h) {
    return [...b.slice(0, h.bStart), ...a.slice(h.aStart, h.aStart + h.aLen), ...b.slice(h.bStart + h.bLen)];
  }

  const sameHunk = (x, y) => !!x && !!y && x.aStart === y.aStart && x.aLen === y.aLen && x.bStart === y.bStart && x.bLen === y.bLen;

  /* ───────────── 跨檔案搜尋與取代 ───────────── */

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 搜尋條件 → RegExp（g、m 旗標；不分大小寫時加 i）。query 是空的回傳 null；規則運算式寫錯會丟出錯誤。
   * word：整個字相符（前後不能是英數字或底線）。
   */
  function searchRegex({ query, regex = false, caseSens = false, word = false } = {}) {
    if (!query) return null;
    let src = regex ? String(query) : escapeRe(query);
    if (word) src = `(?<![\\w])(?:${src})(?![\\w])`;
    return new RegExp(src, caseSens ? 'gm' : 'gim');
  }

  const PREVIEW_BEFORE = 50;
  const PREVIEW_AFTER = 120;

  /**
   * 在文字（換行已統一成 \n）中找出所有符合處：
   *   { line, col（從 1 起算）, start, end（字元位置）, text, before, after, cut（before 前面還有內容）, multi（跨行）, g?, ng? }
   * groups 為 true 時附上擷取群組（取代時展開 $1、$<name> 用）。最多 limit 筆，超過時 truncated。
   */
  function findInText(text, re, { limit = 10000, groups = false } = {}) {
    const matches = [];
    if (!re) return { matches, truncated: false };
    re.lastIndex = 0;
    let line = 0, ls = 0, scan = 0, m, truncated = false;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (matches.length >= limit) { truncated = true; break; }
      for (let i = text.indexOf('\n', scan); i >= 0 && i < m.index; i = text.indexOf('\n', i + 1)) { line++; ls = i + 1; }
      scan = m.index;
      let le = text.indexOf('\n', m.index);
      if (le < 0) le = text.length;
      const end = m.index + m[0].length;
      const from = Math.max(ls, m.index - PREVIEW_BEFORE);
      const multi = end > le; // 跨行的符合只顯示第一行
      const hit = {
        line: line + 1, col: m.index - ls + 1, start: m.index, end, text: m[0],
        before: text.slice(from, m.index), cut: from > ls,
        after: multi ? '' : text.slice(end, Math.min(le, end + PREVIEW_AFTER)),
        multi,
      };
      if (groups) {
        hit.g = m.slice(1).map((x) => (x === undefined ? null : x));
        if (m.groups) hit.ng = { ...m.groups };
      }
      matches.push(hit);
    }
    return { matches, truncated };
  }

  /**
   * 取代字串：一般模式照原樣；規則運算式模式支援 $1…$99、$<name>、$&（或 $0）、$$，以及 \n、\t、\\。
   */
  function expandReplacement(rep, match, regex) {
    rep = String(rep);
    if (!regex) return rep;
    const g = match.g || [];
    let out = '';
    for (let i = 0; i < rep.length; i++) {
      const c = rep[i];
      const n = rep[i + 1];
      if (c === '\\' && n !== undefined) {
        if (n === 'n') { out += '\n'; i++; continue; }
        if (n === 't') { out += '\t'; i++; continue; }
        if (n === '\\') { out += '\\'; i++; continue; }
      } else if (c === '$' && n !== undefined) {
        if (n === '$') { out += '$'; i++; continue; }
        if (n === '&') { out += match.text; i++; continue; }
        if (n === '<' && match.ng) {
          const e = rep.indexOf('>', i + 2);
          if (e > 0) { const v = match.ng[rep.slice(i + 2, e)]; out += v == null ? '' : v; i = e; continue; }
        }
        if (n >= '0' && n <= '9') {
          const two = rep.slice(i + 1, i + 3);
          if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= g.length) { out += g[Number(two) - 1] ?? ''; i += 2; continue; }
          const k = Number(n);
          if (k === 0) { out += match.text; i++; continue; }
          if (k <= g.length) { out += g[k - 1] ?? ''; i++; continue; }
        }
      }
      out += c;
    }
    return out;
  }

  /**
   * 套用取代：reps 為 [{ start, end, text, replacement }]。
   * 每一處的原文都必須和 text 相同、彼此不能重疊，否則回傳 null（檔案在搜尋之後被改過）。
   */
  function applyReplacements(text, reps) {
    const list = [...reps].sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const r of list) {
      if (r.start < pos || r.end < r.start || text.slice(r.start, r.end) !== r.text) return null;
      out += text.slice(pos, r.start) + r.replacement;
      pos = r.end;
    }
    return out + text.slice(pos);
  }

  /** 逗號分隔的清單；大括號裡的逗號不算（*.{js,ts}） */
  function splitList(spec) {
    const out = [];
    let cur = '', depth = 0;
    for (const ch of String(spec || '')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 檔案篩選樣式 → RegExp（比對專案相對路徑，分隔字元為 /）：
   *   沒有 / 的樣式比對任何一層名稱：*.js、test、*.min.*
   *   有 / 的樣式從專案根目錄比對：src/、src/**\/*.ts、docs/a.md
   *   支援 *、**、?、{a,b}；比對到資料夾時，裡面的檔案都算
   */
  function globRegex(pattern) {
    let s = String(pattern).trim().replace(/\\/g, '/');
    if (s.startsWith('./')) s = s.slice(2);
    const anchored = s.replace(/\/+$/, '').includes('/') || s.startsWith('/');
    s = s.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!s) return null;
    let re = '';
    let brace = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '*') {
        if (s[i + 1] === '*') {
          if (s[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if (c === '{') { re += '(?:'; brace++; } else if (c === '}' && brace) { re += ')'; brace--; } else if (c === ',' && brace) re += '|';
      else re += escapeRe(c);
    }
    re += ')'.repeat(brace);
    return new RegExp(anchored ? `^${re}(?:/.*)?$` : `(?:^|/)${re}(?:/|$)`, 'i');
  }

  /** 包含／排除樣式 → (rel) => 是否要搜尋 */
  function pathFilter(include, exclude) {
    const inc = splitList(include).map(globRegex).filter(Boolean);
    const exc = splitList(exclude).map(globRegex).filter(Boolean);
    return (rel) => (!inc.length || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
  }

  /* ───────────── 符號（跳到定義） ───────────── */

  /**
   * 不分析型別，只用各語言的定義寫法（function、class、def、方法簽章…）找出「名稱在哪裡被定義」。
   * 同名的定義可能有很多個，由 rankDefinitions 依 import、同檔案、同資料夾、同語言排序。
   */
  const ID = '[A-Za-z_$][\\w$]*';
  const N = `(${ID})`;
  const JMODS = '(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|virtual|override|async|sealed|partial|extern|unsafe|new|default|strictfp|transient|volatile|readonly|const|open|inline|suspend|operator|infix|tailrec|data|inner|lateinit|implicit|lazy)\\s+)';
  const JTYPE = '([\\w$.]+(?:<[^;(){}=]*?>)?(?:\\[\\])*\\??)';
  const NOT_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'new', 'throw', 'typeof', 'sizeof', 'using', 'lock', 'with', 'await', 'yield', 'delete', 'in', 'of', 'super', 'this', 'foreach', 'elseif', 'elif', 'until', 'unless']);
  const NOT_TYPE = new Set(['return', 'new', 'else', 'throw', 'await', 'case', 'goto', 'yield', 'if', 'for', 'while', 'switch', 'catch', 'do', 'using', 'lock', 'delete', 'typeof', 'sizeof', 'in', 'of', 'is', 'as', 'echo', 'print', 'not', 'and', 'or', 'instanceof', 'import', 'package', 'export', 'from', 'assert', 'raise', 'with', 'when', 'match', 'var', 'val', 'let', 'const']);

  const MODIFIER = /^(?:public|private|protected|internal)$/;
  const rule = (src, kind, opts = {}) => ({ re: new RegExp(src, opts.ci ? 'gimd' : 'gmd'), kind, type: opts.type });

  const RULES_JS = [
    rule(`^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${N}`, '函式'),
    rule(`\\bclass\\s+${N}`, '類別'),
    rule(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${N}\\s*(?::[^=\\n]+)?=`, '變數'),
    rule(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:interface|type|enum|namespace)\\s+${N}`, '型別'),
    rule(`^[ \\t]*(?:(?:public|private|protected|static|async|get|set|readonly|override|abstract|declare)\\s+)*\\*?\\s*#?${N}\\s*(?:<[^>()\\n]*>)?\\s*\\([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*\\)\\s*(?::\\s*[^{;=\\n]+)?\\{`, '方法'),
    rule(`^[ \\t]*(?:(?:public|private|protected|static|readonly|override|declare)\\s+)*#?${N}\\s*[?!]?\\s*(?::[^=;\\n]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)\\n]*\\)\\s*(?::[^=\\n]+)?=>|${ID}\\s*=>)`, '方法'),
    rule(`^[ \\t]*${N}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)\\n]*\\)\\s*=>)`, '方法'),
    rule(`\\b(?:module\\.)?exports\\.${N}\\s*=(?!=)`, '匯出'),
  ];

  const RULES_JVM = [
    rule(`\\b(?:class|interface|enum|record|struct|object|trait|@interface)\\s+${N}`, '類別'),
    rule(`^[ \\t]*${JMODS}*(?:<[^>\\n]*>\\s+)?${JTYPE}\\s+${N}\\s*\\(`, '方法', { type: 1 }),
    rule(`^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?\\s+)*(?:public|private|protected)\\s+${N}\\s*\\(`, '建構子'),
    rule(`^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?\\s+)*${JMODS}+${JTYPE}\\s+${N}\\s*(?:[=;,]|\\{|=>|$)`, '欄位', { type: 1 }),
    rule(`\\bfun\\s+(?:<[^>\\n]*>\\s*)?(?:${ID}\\.)*${N}\\s*[(<]`, '函式'),
    rule(`^[ \\t]*${JMODS}*(?:val|var)\\s+${N}\\b`, '屬性'),
    rule(`\\bdef\\s+${N}`, '方法'),
    rule(`\\b(?:namespace|delegate\\s+[\\w<>.]+)\\s+${N}`, '型別'),
  ];

  const RULES_C = [
    rule(`^(?:[\\w$:<>,]+[ \\t*&]+)+(?:${ID}::)*~?${N}\\s*\\([^;\\n]*$`, '函式', { type: 'line' }),
    rule(`^[ \\t]*#[ \\t]*define\\s+${N}`, '巨集'),
    rule(`\\b(?:struct|class|union|enum(?:\\s+class)?|namespace)\\s+${N}\\b(?!\\s*;)`, '型別'),
    rule(`\\btypedef\\b[^;{]*?\\b${N}\\s*;`, '型別'),
    rule(`@(?:interface|implementation|protocol)\\s+${N}`, '類別'),
    rule(`^[-+]\\s*\\([^)\\n]*\\)\\s*${N}`, '方法'),
  ];

  const RULES = {
    js: RULES_JS,
    jvm: RULES_JVM,
    cs: RULES_JVM,
    dart: [...RULES_JVM, rule(`\\b(?:mixin|extension|typedef)\\s+${N}`, '型別')],
    c: RULES_C,
    py: [
      rule(`^[ \\t]*(?:async\\s+)?def\\s+${N}`, '函式'),
      rule(`^[ \\t]*class\\s+${N}`, '類別'),
      rule(`^${N}\\s*(?::[^=\\n]+)?=(?!=)`, '變數'),
      rule(`\\bself\\.${N}\\s*(?::[^=\\n]+)?=(?!=)`, '屬性'),
    ],
    go: [
      rule(`^func\\s+(?:\\([^)\\n]*\\)\\s*)?${N}`, '函式'),
      rule(`^[ \\t]*type\\s+${N}`, '型別'),
      rule(`^\\t${N}\\s+(?:struct|interface)\\b`, '型別'),
      rule(`^(?:var|const)\\s+${N}`, '變數'),
    ],
    rs: [
      rule(`\\bfn\\s+${N}`, '函式'),
      rule(`\\b(?:struct|enum|trait|type|mod|union)\\s+${N}`, '型別'),
      rule(`\\b(?:const|static)\\s+(?:mut\\s+)?${N}\\s*:`, '常數'),
      rule(`\\bmacro_rules!\\s*${N}`, '巨集'),
    ],
    php: [
      rule('\\bfunction\\s+&?([A-Za-z_]\\w*)', '函式'),
      rule('\\b(?:class|interface|trait|enum)\\s+([A-Za-z_]\\w*)', '類別'),
      rule('\\b(?:public|private|protected|var)\\s+(?:static\\s+)?(?:readonly\\s+)?(?:\\??[\\w\\\\]+\\s+)?\\$([A-Za-z_]\\w*)', '屬性'),
      rule('\\bconst\\s+([A-Za-z_]\\w*)\\s*=', '常數'),
      rule('\\bdefine\\(\\s*[\'"]([A-Za-z_]\\w*)[\'"]', '常數'),
    ],
    rb: [
      rule('\\bdef\\s+(?:self\\.)?([A-Za-z_]\\w*[?!=]?)', '方法'),
      rule('\\b(?:class|module)\\s+(?:\\w+::)*([A-Z]\\w*)', '類別'),
    ],
    sql: [
      rule('\\b(?:procedure|function|package(?:\\s+body)?|view|table|trigger|type(?:\\s+body)?|sequence|synonym|materialized\\s+view)\\s+(?:(?:"[^"\\n]+"|\\w+)\\.)?"?([A-Za-z_][\\w$#]*)"?', '物件', { ci: true }),
    ],
    sh: [
      rule('^[ \\t]*(?:function\\s+)?([A-Za-z_][\\w-]*)\\s*\\(\\s*\\)', '函式'),
      rule('^[ \\t]*function\\s+([A-Za-z_][\\w-]*)', '函式'),
      rule('^[ \\t]*(?:export\\s+|local\\s+|readonly\\s+|declare\\s+(?:-\\w+\\s+)?)?([A-Za-z_]\\w*)=', '變數'),
    ],
    lua: [
      rule(`\\bfunction\\s+(?:[\\w.]+[.:])?${N}`, '函式'),
      rule(`^[ \\t]*local\\s+${N}\\s*=`, '變數'),
    ],
    swift: [
      rule(`\\bfunc\\s+${N}`, '函式'),
      rule(`\\b(?:class|struct|enum|protocol|extension|actor|typealias)\\s+${N}`, '型別'),
      rule(`^[ \\t]*(?:(?:public|private|fileprivate|internal|open|static|final|lazy|weak|override)\\s+)*(?:let|var)\\s+${N}`, '屬性'),
    ],
    perl: [rule(`\\bsub\\s+${N}`, '函式'), rule('\\bpackage\\s+([\\w:]+)', '套件')],
    ps: [rule('\\bfunction\\s+([\\w-]+)', '函式', { ci: true }), rule(`\\bclass\\s+${N}`, '類別', { ci: true })],
    vb: [rule(`\\b(?:Sub|Function|Property|Class|Module|Structure|Interface|Enum)\\s+${N}`, '定義', { ci: true })],
  };

  /** 語言 → 語言群組（同一群組的檔案可以互相參照） */
  const FAMILY = {
    javascript: 'js', typescript: 'js', java: 'jvm', kotlin: 'jvm', scala: 'jvm', groovy: 'jvm', gradle: 'jvm',
    csharp: 'cs', dart: 'dart', c: 'c', cpp: 'c', objectivec: 'c', python: 'py', go: 'go', rust: 'rs', php: 'php',
    ruby: 'rb', sql: 'sql', bash: 'sh', lua: 'lua', swift: 'swift', perl: 'perl', powershell: 'ps', vbnet: 'vb', vbscript: 'vb',
  };
  const symbolFamily = (lang) => FAMILY[lang] || null;
  /** 名稱不分大小寫的語言 */
  const symbolCaseInsensitive = (lang) => ['sql', 'vb', 'ps'].includes(FAMILY[lang]);

  /** 每行開頭的位置（行號查詢用） */
  function lineStarts(text) {
    const out = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1);
    return out;
  }
  function lineOf(starts, pos) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /** 第一個型別字是不是關鍵字（return foo(…)、new Foo(…) 不是定義） */
  function badType(type) {
    const first = String(type || '').trim().split(/[\s.<[]/)[0];
    return NOT_TYPE.has(first);
  }

  /**
   * 文字中的定義：[{ name, kind, line, col（從 1 起算）, text（那一行，去掉前後空白，最多 160 字） }]
   * 不支援的語言回傳空陣列。
   */
  function symbolsIn(text, lang) {
    const rules = RULES[FAMILY[lang]];
    if (!rules || !text) return [];
    const starts = lineStarts(text);
    const seen = new Set();
    const out = [];
    for (const r of rules) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(text))) {
        if (m[0] === '') { r.re.lastIndex++; continue; }
        const gi = m.length - 1; // 名稱一律是最後一個群組
        const name = m[gi];
        if (!name || !m.indices[gi]) continue;
        if (NOT_NAME.has(name)) continue;
        if (r.type === 1 && badType(m[1])) continue;
        const kind = r.type === 1 && MODIFIER.test(m[1]) ? '建構子' : r.kind; // public Foo(…)
        if (r.type === 'line' && badType(m[0])) continue;
        const pos = m.indices[gi][0];
        const ln = lineOf(starts, pos);
        const key = `${ln}:${pos}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const le = text.indexOf('\n', starts[ln]);
        const line = text.slice(starts[ln], le < 0 ? text.length : le).trim();
        out.push({ name, kind, line: ln + 1, col: pos - starts[ln] + 1, text: line.length > 160 ? `${line.slice(0, 160)}…` : line });
      }
    }
    return out.sort((a, b) => a.line - b.line || a.col - b.col);
  }

  /** 游標所在的名稱：{ name, start, end }；不在名稱上時回傳 null */
  function wordAt(text, pos, lang) {
    const fam = FAMILY[lang];
    const ch = fam === 'sh' || fam === 'ps' ? /[\w-]/ : fam === 'php' ? /\w/ : /[\w$]/;
    let s = pos, e = pos;
    while (s > 0 && ch.test(text[s - 1])) s--;
    while (e < text.length && ch.test(text[e])) e++;
    if (fam === 'rb' && (text[e] === '?' || text[e] === '!')) e++;
    if (s === e) return null;
    const name = text.slice(s, e);
    if (/^\d/.test(name)) return null;
    return { name, start: s, end: e };
  }

  /** 正規化相對路徑（a/./b/../c → a/c） */
  function joinPath(dir, rel) {
    const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    return out.join('/');
  }

  /**
   * 從目前檔案的 import／require 猜名稱來自哪個檔案：回傳路徑（不含副檔名）陣列。
   *   JS／TS：import { name } from './x'、const { name } = require('./x')（只處理相對路徑）
   *   Python：from a.b import name、from .x import name
   *   Java 類：import a.b.Name;
   */
  function importHints(text, name, lang, fileRel) {
    const fam = FAMILY[lang];
    const dir = fileRel && fileRel.includes('/') ? fileRel.slice(0, fileRel.lastIndexOf('/')) : '';
    const has = (s) => new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(s);
    const out = [];
    let m;
    if (fam === 'js') {
      const re = /\bimport\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+([^=;]+?)=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((m = re.exec(text))) {
        const names = m[1] || m[3];
        const spec = m[2] || m[4];
        if (spec.startsWith('.') && has(names)) out.push(joinPath(dir, spec).replace(/\.(m?[jt]sx?|cjs|mjs)$/, ''));
      }
    } else if (fam === 'py') {
      const re = /^[ \t]*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)/gm;
      while ((m = re.exec(text))) {
        if (!has(m[3])) continue;
        const mod = m[2].split('.').filter(Boolean).join('/');
        if (m[1]) {
          let base = dir;
          for (let i = 1; i < m[1].length; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
          out.push(joinPath(base, mod || '__init__'));
        } else out.push(mod);
      }
    } else if (fam === 'jvm' || fam === 'cs' || fam === 'dart') {
      const re = /^[ \t]*import\s+(?:static\s+)?([\w.]+)\.(\w+)\s*;?/gm;
      while ((m = re.exec(text))) {
        if (m[2] === name) out.push(m[1].split('.').concat(name).join('/'));
        else if (m[1].split('.').pop() === name) out.push(m[1].split('.').join('/')); // import static a.b.Cls.member
      }
    }
    return out;
  }

  const stripExt = (rel) => rel.replace(/\.[^./]+$/, '');

  /**
   * 排序候選的定義（items: [{ rel, line, col, family }]），回傳 [{ ...item, score }]，score 越小越可能：
   *   0 來自 import 的檔案　1 同一個檔案　2 同語言、同資料夾　3 同語言　4 其他語言
   * 游標正好在定義本身時（self）排除那一筆。
   */
  function rankDefinitions(items, { rel, family, hints = [], self = null }) {
    const dir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const hinted = (r) => {
      const p = stripExt(r);
      return hints.some((h) => p === h || p.endsWith(`/${h}`) || p === `${h}/index` || p === `${h}/__init__` || p.endsWith(`/${h}/index`));
    };
    return items
      .filter((it) => !(self && it.rel === self.rel && it.line === self.line && it.col <= self.col && self.col <= it.col + it.name.length))
      .map((it) => {
        const itDir = it.rel.includes('/') ? it.rel.slice(0, it.rel.lastIndexOf('/')) : '';
        let score = 4;
        if (hints.length && hinted(it.rel)) score = 0;
        else if (it.rel === rel) score = 1;
        else if (family && it.family === family && itDir === dir) score = 2;
        else if (family && it.family === family) score = 3;
        return { ...it, score };
      })
      .sort((a, b) => a.score - b.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || a.line - b.line);
  }

  /* ───────────── 快捷鍵 ───────────── */

  /**
   * 組合鍵的字串格式：修飾鍵依 Ctrl、Alt、Shift、Meta 的順序，加上按鍵，例如 'Meta+Shift+F'、'Ctrl+-'、'F12'。
   * 按鍵依實體位置（KeyboardEvent.code）判斷，不受輸入法與 Shift 影響（Shift+- 仍是 '-'）。
   */
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const CODE_KEY = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backquote: '`', IntlBackslash: '\\', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter',
    Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
  };
  const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right)?$/;

  /** KeyboardEvent（或同樣欄位的物件）→ 組合鍵字串；只按修飾鍵或認不出的鍵時回傳 null */
  function comboFromEvent(e) {
    const code = e.code || '';
    if (!code || MODIFIER_CODES.test(code)) return null;
    let key = CODE_KEY[code];
    if (!key) {
      let m;
      if ((m = code.match(/^Key([A-Z])$/))) key = m[1];
      else if ((m = code.match(/^(?:Digit|Numpad)(\d)$/))) key = m[1];
      else if (/^F\d{1,2}$/.test(code)) key = code;
      else return null;
    }
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    return [...mods, key].join('+');
  }

  /** 整理成標準順序；'Mod' 代表 macOS 的 Meta、其他平台的 Ctrl */
  function normalizeCombo(combo, mac) {
    const parts = String(combo || '').split('+');
    // 按鍵本身是 '+' 時（例如 'Ctrl++'）
    let key = parts.pop();
    if (key === '' && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }
    const mods = new Set(parts.map((p) => (p === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : p === 'Cmd' ? 'Meta' : p === 'Control' ? 'Ctrl' : p === 'Option' ? 'Alt' : p)));
    return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
  }

  const splitCombo = (combo) => {
    const parts = combo.split('+');
    let key = parts.pop();
    if (key === '' && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }
    return { mods: parts, key };
  };

  const MAC_MOD = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
  const MAC_KEY = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥', Space: '空白鍵', PageUp: 'PgUp', PageDown: 'PgDn' };
  const WIN_KEY = { Left: '←', Right: '→', Up: '↑', Down: '↓', Escape: 'Esc', Space: '空白鍵', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del' };

  /** 顯示用：macOS ⌃⌥⇧⌘F，其他平台 Ctrl+Shift+F */
  function comboLabel(combo, mac) {
    if (!combo) return '';
    const { mods, key } = splitCombo(combo);
    if (mac) return mods.map((m) => MAC_MOD[m] || m).join('') + (MAC_KEY[key] || key);
    return [...mods, WIN_KEY[key] || key].join('+');
  }

  /**
   * ToolDock 視窗選單與系統使用的組合鍵：按下時選單會先處理，擴充畫面收不到。
   * 對照 ToolDock 的 main.js buildMenu（檔案、編輯、檢視、視窗選單）。
   */
  const RESERVED_MAC = {
    'Meta+W': '關閉分頁', 'Shift+Meta+W': '關閉視窗', 'Meta+Q': '結束 ToolDock', 'Meta+H': '隱藏 ToolDock', 'Alt+Meta+H': '隱藏其他應用程式',
    'Meta+M': '縮到最小', 'Meta+Z': '還原', 'Shift+Meta+Z': '重做', 'Meta+X': '剪下', 'Meta+C': '拷貝', 'Meta+V': '貼上', 'Meta+A': '全選',
    'Shift+Meta+P': '命令面板', 'Shift+Meta+X': '擴充管理', 'Shift+Meta+S': '擴充商店', 'Shift+Meta+L': '生命週期', 'Shift+Meta+U': '輸出面板',
    'Meta+R': '重新載入', 'Alt+Meta+I': '開發者工具', 'Meta+0': '實際大小', 'Meta+=': '放大', 'Shift+Meta+=': '放大', 'Meta+-': '縮小', 'Ctrl+Meta+F': '全螢幕',
  };
  const RESERVED_WIN = {
    'Ctrl+W': '關閉分頁', 'Ctrl+Z': '還原', 'Ctrl+Y': '重做', 'Ctrl+Shift+Z': '重做', 'Ctrl+X': '剪下', 'Ctrl+C': '複製', 'Ctrl+V': '貼上', 'Ctrl+A': '全選',
    'Ctrl+Shift+P': '命令面板', 'Ctrl+Shift+X': '擴充管理', 'Ctrl+Shift+S': '擴充商店', 'Ctrl+Shift+L': '生命週期', 'Ctrl+Shift+U': '輸出面板',
    'Ctrl+R': '重新載入', 'Ctrl+Shift+I': '開發者工具', 'Ctrl+0': '實際大小', 'Ctrl+=': '放大', 'Ctrl+Shift+=': '放大', 'Ctrl+-': '縮小', F11: '全螢幕', 'Alt+F4': '結束',
  };
  const reservedBy = (combo, mac) => (mac ? RESERVED_MAC : RESERVED_WIN)[combo] || null;

  /**
   * 檢查能不能當快捷鍵：回傳 null 表示可以，否則回傳原因。
   * 沒有修飾鍵（或只有 Shift）的一般按鍵會擋住打字，只有 F1–F12 可以單獨使用。
   */
  function comboProblem(combo, mac) {
    if (!combo) return '請按下組合鍵';
    const { mods, key } = splitCombo(combo);
    const fkey = /^F\d{1,2}$/.test(key);
    if (!fkey && !mods.some((m) => m !== 'Shift')) return `單獨的按鍵或只加 ${mac ? '⇧' : 'Shift'} 會影響打字，請加上 ${mac ? '⌘、⌃ 或 ⌥' : 'Ctrl 或 Alt'}，或使用 F1–F12`;
    if (['Tab', 'Escape'].includes(key) && !mods.some((m) => m !== 'Shift')) return 'Tab 與 Esc 是編輯器固定使用的按鍵';
    const r = reservedBy(combo, mac);
    if (r) return `這組按鍵是 ToolDock 選單的「${r}」，按下時選單會先處理，在這裡不會生效`;
    return null;
  }

  /**
   * 合併預設與使用者的設定：commands = [{ id, mac: [...], win: [...] }]，overrides = { id: [組合鍵…] }（空陣列表示不設定）。
   * 回傳 { keys: Map<id, [組合鍵]>, index: Map<組合鍵, id>, conflicts: [[組合鍵, id, id]] }；
   * 同一組按鍵被兩個功能使用時，使用者設定的優先，否則先列的優先。
   */
  function resolveKeymap(commands, overrides, mac) {
    const keys = new Map();
    const index = new Map();
    const conflicts = [];
    const custom = new Set();
    for (const c of commands) {
      const own = overrides && Object.prototype.hasOwnProperty.call(overrides, c.id) && Array.isArray(overrides[c.id]);
      if (own) custom.add(c.id);
      const list = (own ? overrides[c.id] : (mac ? c.mac : c.win) || []).map((k) => normalizeCombo(k, mac));
      keys.set(c.id, [...new Set(list)]);
    }
    const order = [...commands.filter((c) => custom.has(c.id)), ...commands.filter((c) => !custom.has(c.id))];
    for (const c of order) {
      for (const k of keys.get(c.id)) {
        if (index.has(k)) { conflicts.push([k, index.get(k), c.id]); continue; }
        index.set(k, c.id);
      }
    }
    for (const c of commands) keys.set(c.id, keys.get(c.id).filter((k) => index.get(k) === c.id));
    return { keys, index, conflicts, custom };
  }

  /** 和預設相同的設定不必保存 */
  function sameKeys(a, b) {
    return a.length === b.length && a.every((k, i) => k === b[i]);
  }

  /* ───────────── 多游標與列選取 ─────────────
   * 選取以 { a, h, p?, col? } 表示：a 是錨點、h 是游標所在（head），p 為 true 的是主要游標（textarea 原生的選取），
   * col 是上下移動時要回到的欄位。所有函式都不改動傳入的陣列，回傳新的選取。
   */

  const selFrom = (s) => Math.min(s.a, s.h);
  const selTo = (s) => Math.max(s.a, s.h);

  /** 依位置排序，合併重疊的選取（以及落在同一點的游標）；剛好保留一個主要游標 */
  function normalizeSels(sels) {
    const list = sels.map((s) => ({ ...s })).sort((x, y) => selFrom(x) - selFrom(y) || selTo(x) - selTo(y));
    const out = [];
    for (const s of list) {
      const prev = out[out.length - 1];
      const overlap = prev && (selFrom(s) < selTo(prev) || (selFrom(s) === selTo(prev) && (s.a === s.h || prev.a === prev.h)));
      if (!overlap) { out.push(s); continue; }
      const from = selFrom(prev);
      const to = Math.max(selTo(prev), selTo(s));
      const back = prev.h < prev.a; // 保留原本的方向
      out[out.length - 1] = { a: back ? to : from, h: back ? from : to, ...(prev.p || s.p ? { p: true } : {}) };
    }
    let seen = false;
    for (const s of out) { if (s.p && seen) delete s.p; else if (s.p) seen = true; }
    if (out.length && !seen) out[out.length - 1].p = true;
    return out;
  }

  const primaryOf = (sels) => sels.find((s) => s.p) || sels[sels.length - 1];

  /**
   * 對每個選取套用一段編輯：fn(text, from, to, i, sel) 回傳 { from, to, insert, a?, h? }（a、h 是新游標相對於 from 的位移，
   * 省略時游標放在插入文字的後面）或 null（不改這個選取）。編輯範圍和前一個重疊時略過（例如同一行的兩個游標都要取消縮排）。
   * 回傳 { from, to, insert, sels, text }：把原文的 [from, to) 換成 insert 就是結果 text（只要一次 insertText，⌘Z 一次復原）。
   */
  function editSels(text, sels, fn) {
    const list = normalizeSels(sels);
    const parts = [];
    const out = [];
    let last = 0;
    let delta = 0;
    let lo = Infinity;
    let hi = -1;
    list.forEach((s, i) => {
      const r = fn(text, selFrom(s), selTo(s), i, s);
      if (!r || r.from < last) { out.push({ a: s.a + delta, h: s.h + delta, ...(s.p ? { p: true } : {}) }); return; }
      parts.push(text.slice(last, r.from), r.insert);
      const base = r.from + delta;
      const ca = r.a !== undefined ? r.a : r.insert.length;
      const ch = r.h !== undefined ? r.h : ca;
      out.push({ a: base + ca, h: base + ch, ...(s.p ? { p: true } : {}) });
      delta += r.insert.length - (r.to - r.from);
      last = r.to;
      lo = Math.min(lo, r.from);
      hi = Math.max(hi, r.to);
    });
    if (hi < 0) return null;
    parts.push(text.slice(last));
    const next = parts.join('');
    return { from: lo, to: hi, insert: next.slice(lo, hi + delta), sels: normalizeSels(out), text: next };
  }

  /** 每個選取換成 insert；insert 是陣列時第 i 個選取用第 i 個字串（貼上與選取數量相同的多行文字） */
  function insertAtSels(text, sels, insert) {
    return editSels(text, sels, (t, from, to, i) => ({ from, to, insert: Array.isArray(insert) ? (insert[i] === undefined ? '' : insert[i]) : insert }));
  }

  /** 往前（Backspace）或往後（Delete）刪除；word 為 true 時刪到字的邊界 */
  function deleteAtSels(text, sels, forward, word) {
    return editSels(text, sels, (t, from, to) => {
      if (from < to) return { from, to, insert: '' };
      if (forward) {
        if (from >= t.length) return null;
        const end = word ? wordBoundary(t, from, 1) : from + charLen(t, from, 1);
        return { from, to: end, insert: '' };
      }
      if (from <= 0) return null;
      const start = word ? wordBoundary(t, from, -1) : from - charLen(t, from, -1);
      return { from: start, to: from, insert: '' };
    });
  }

  /** Enter：每個游標都延續所在行的縮排 */
  function newlineAtSels(text, sels, unit) {
    return editSels(text, sels, (t, from, to) => {
      const e = newline(t, from, to, unit);
      return { from: e.from, to: e.to, insert: e.insert, a: e.selStart - e.from };
    });
  }

  /** Tab／Shift+Tab：同一行有好幾個游標時只縮排一次 */
  function indentSels(text, sels, unit, outdent) {
    return editSels(text, sels, (t, from, to) => {
      const e = indent(t, from, to, unit, outdent);
      if (!e) return null;
      return { from: e.from, to: e.to, insert: e.insert, a: e.selStart - e.from, h: e.selEnd - e.from };
    });
  }

  /** 從 pos 往 dir（±1）跨過一個字元的長度（surrogate pair 算一個字） */
  function charLen(text, pos, dir) {
    if (dir < 0) return pos >= 2 && /[\uDC00-\uDFFF]/.test(text[pos - 1]) && /[\uD800-\uDBFF]/.test(text[pos - 2]) ? 2 : 1;
    return /[\uD800-\uDBFF]/.test(text[pos] || '') && /[\uDC00-\uDFFF]/.test(text[pos + 1] || '') ? 2 : 1;
  }

  const WORD_CH = /[\p{L}\p{N}_$]/u;
  /** ⌥←／⌥→（Windows 是 Ctrl）：先跳過空白，再跳過同一類的字元；在行首／行尾時跨過換行 */
  function wordBoundary(text, pos, dir) {
    let p = pos;
    const at = (i) => text[dir < 0 ? i - 1 : i];
    const inRange = (i) => (dir < 0 ? i > 0 : i < text.length);
    while (inRange(p) && /[ \t]/.test(at(p))) p += dir;
    if (inRange(p) && at(p) === '\n') return p === pos ? p + dir : p;
    if (!inRange(p)) return p;
    const word = WORD_CH.test(at(p));
    while (inRange(p) && at(p) !== '\n' && !/[ \t]/.test(at(p)) && WORD_CH.test(at(p)) === word) p += dir;
    return p;
  }

  const lineStartAt = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
  const lineEndAt = (text, pos) => { const n = text.indexOf('\n', pos); return n < 0 ? text.length : n; };

  /** 顯示欄位：Tab 跳到下一個定位點，全形字算兩欄 */
  const WIDE = /^(?:[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\uD840-\uD87F][\uDC00-\uDFFF])/;
  function visualCol(line, off, tabSize = 4) {
    let col = 0;
    for (let i = 0; i < off && i < line.length; i++) {
      const ch = line[i];
      if (ch === '\t') col += tabSize - (col % tabSize);
      else if (/[\uDC00-\uDFFF]/.test(ch) && i > 0 && /[\uD800-\uDBFF]/.test(line[i - 1])) continue;
      else col += WIDE.test(ch + (line[i + 1] || '')) ? 2 : 1;
    }
    return col;
  }

  /** 顯示欄位 col 對應的字元位置（取最近的字元邊界）；past 表示 col 超出行尾 */
  function offsetAtCol(line, col, tabSize = 4) {
    let c = 0;
    for (let i = 0; i < line.length; i++) {
      const next = visualCol(line, i + 1, tabSize);
      const w = next - c;
      if (w === 0) continue;
      if (c + w / 2 > col) return { off: i, past: false };
      c = next;
    }
    return { off: line.length, past: col > c };
  }

  /** 預設的欄位度量（顯示欄位）；畫面改用像素，讓全形字、比例字型也對齊 */
  const colMetrics = (tabSize = 4) => ({ colOf: (line, off) => visualCol(line, off, tabSize), offAt: (line, col) => offsetAtCol(line, col, tabSize) });

  /** 第 n 行（從 0 起算）的 [開頭, 結尾) */
  function lineBounds(text, n) {
    const s = lineStart(text, n + 1);
    return [s, lineEndAt(text, s)];
  }

  /** pos 在第幾行（從 0 起算） */
  const lineIndexAt = (text, pos) => { let n = 0; for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++; return n; };

  /**
   * 列選取（矩形）：從 (aLine, aCol) 到 (hLine, hCol)，每一行一個選取。col 的單位由 metrics 決定。
   * 有寬度的矩形略過太短的行（行尾在矩形左邊）；寬度為 0 時每一行都放游標（行太短就放在行尾），方便在每行同一欄插入文字。
   * 主要游標在 hLine。
   */
  function columnSels(text, aLine, aCol, hLine, hCol, metrics = colMetrics()) {
    const total = (text.match(/\n/g) || []).length + 1;
    const clampLine = (n) => Math.max(0, Math.min(total - 1, n));
    aLine = clampLine(aLine);
    hLine = clampLine(hLine);
    const minCol = Math.min(aCol, hCol);
    const sels = [];
    const step = hLine >= aLine ? 1 : -1;
    for (let n = aLine; ; n += step) {
      const [s, e] = lineBounds(text, n);
      const line = text.slice(s, e);
      const short = aCol !== hCol && metrics.colOf(line, line.length) <= minCol;
      if (!short || n === hLine) {
        sels.push({ a: s + metrics.offAt(line, aCol).off, h: s + metrics.offAt(line, hCol).off, ...(n === hLine ? { p: true } : {}) });
      }
      if (n === hLine) break;
    }
    return normalizeSels(sels);
  }

  /**
   * 移動所有游標：key 是 Left／Right／Up／Down／Home／End，extend 為 true 時延伸選取，word 為 true 時以字為單位。
   * 上下移動保留目標欄位（sel.col，單位由 metrics 決定）。
   */
  function moveSels(text, sels, key, { extend = false, word = false, metrics = colMetrics() } = {}) {
    const out = sels.map((s) => {
      const empty = s.a === s.h;
      let h = s.h;
      let col;
      if (!extend && !empty && !word && (key === 'Left' || key === 'Right')) {
        h = key === 'Left' ? selFrom(s) : selTo(s);
      } else if (key === 'Left') h = word ? wordBoundary(text, s.h, -1) : Math.max(0, s.h - charLen(text, s.h, -1));
      else if (key === 'Right') h = word ? wordBoundary(text, s.h, 1) : Math.min(text.length, s.h + charLen(text, s.h, 1));
      else if (key === 'Home') {
        const ls = lineStartAt(text, s.h);
        const first = ls + (text.slice(ls, lineEndAt(text, s.h)).match(/^[ \t]*/) || [''])[0].length;
        h = s.h === first ? ls : first;
      } else if (key === 'End') h = lineEndAt(text, s.h);
      else if (key === 'Up' || key === 'Down') {
        const ls = lineStartAt(text, s.h);
        const goal = s.col !== undefined ? s.col : metrics.colOf(text.slice(ls, s.h), s.h - ls);
        col = goal;
        if (key === 'Up') {
          if (ls === 0) h = 0;
          else { const ps = lineStartAt(text, ls - 1); h = ps + metrics.offAt(text.slice(ps, ls - 1), goal).off; }
        } else {
          const le = lineEndAt(text, s.h);
          if (le >= text.length) h = text.length;
          else { const ns = le + 1; h = ns + metrics.offAt(text.slice(ns, lineEndAt(text, ns)), goal).off; }
        }
      }
      return { a: extend ? s.a : h, h, ...(s.p ? { p: true } : {}), ...(col !== undefined ? { col } : {}) };
    });
    // 合併時會丟掉 col：只有沒合併的選取保留
    const merged = normalizeSels(out);
    return merged.map((m) => { const o = out.find((x) => x.a === m.a && x.h === m.h && x.col !== undefined); return o ? { ...m, col: o.col } : m; });
  }

  /** ⌥⌘↑／⌥⌘↓：在最上面（或最下面）的游標的上一行（下一行）同一欄加一個游標，成為主要游標；已到頭時回傳 null */
  function addCaretVertical(text, sels, dir, metrics = colMetrics()) {
    const list = normalizeSels(sels);
    const edge = dir < 0 ? list[0] : list[list.length - 1];
    const src = sels.find((s) => s.a === edge.a && s.h === edge.h && s.col !== undefined);
    const ls = lineStartAt(text, edge.h);
    const col = src ? src.col : metrics.colOf(text.slice(ls, edge.h), edge.h - ls);
    let pos;
    if (dir < 0) {
      if (ls === 0) return null;
      const ps = lineStartAt(text, ls - 1);
      pos = ps + metrics.offAt(text.slice(ps, ls - 1), col).off;
    } else {
      const le = lineEndAt(text, edge.h);
      if (le >= text.length) return null;
      const ns = le + 1;
      pos = ns + metrics.offAt(text.slice(ns, lineEndAt(text, ns)), col).off;
    }
    const out = normalizeSels([...list.map(({ p: _p, ...s }) => s), { a: pos, h: pos, p: true }]);
    return out.map((s) => (s.a === pos && s.h === pos ? { ...s, col } : s));
  }

  const isWordAt = (text, from, to) => !(from > 0 && WORD_CH.test(text[from - 1])) && !(to < text.length && WORD_CH.test(text[to]));

  /**
   * ⌘D：主要游標沒有選取時選取游標所在的字（之後只找整個字相符的）；已有選取時再選下一個相同的文字（到結尾會從頭找）。
   * wordAt(text, pos) 回傳 { start, end } 或 null。回傳 { sels, word }，找不到更多時回傳 null。
   */
  function nextOccurrence(text, sels, { word = false, wordAt: wa } = {}) {
    const list = normalizeSels(sels);
    const p = primaryOf(list);
    if (p.a === p.h) {
      if (list.length > 1) return null;
      const w = wa ? wa(text, p.h) : null;
      if (!w) return null;
      return { sels: [{ a: w.start, h: w.end, p: true }], word: true };
    }
    const needle = text.slice(selFrom(p), selTo(p));
    const taken = (i) => list.some((s) => selFrom(s) < i + needle.length && selTo(s) > i);
    const ok = (i) => !taken(i) && (!word || isWordAt(text, i, i + needle.length));
    let found = -1;
    for (let i = text.indexOf(needle, selTo(p)); i >= 0; i = text.indexOf(needle, i + 1)) if (ok(i)) { found = i; break; }
    if (found < 0) for (let i = text.indexOf(needle); i >= 0 && i < selFrom(p); i = text.indexOf(needle, i + 1)) if (ok(i)) { found = i; break; }
    if (found < 0) return null;
    return { sels: normalizeSels([...list.map(({ p: _p, ...s }) => s), { a: found, h: found + needle.length, p: true }]), word };
  }

  /** ⇧⌘L：選取所有和主要選取相同的文字（或游標所在的字，整個字相符）；最多 limit 個 */
  function allOccurrences(text, sels, { word = false, wordAt: wa, limit = 10000 } = {}) {
    const list = normalizeSels(sels);
    const p = primaryOf(list);
    let from = selFrom(p);
    let to = selTo(p);
    if (from === to) {
      const w = wa ? wa(text, p.h) : null;
      if (!w) return null;
      from = w.start; to = w.end; word = true;
    }
    const needle = text.slice(from, to);
    const out = [];
    for (let i = text.indexOf(needle); i >= 0 && out.length < limit; i = text.indexOf(needle, i + needle.length)) {
      if (!word || isWordAt(text, i, i + needle.length)) out.push({ a: i, h: i + needle.length, ...(i === from ? { p: true } : {}) });
    }
    return out.length ? normalizeSels(out) : null;
  }

  /** 每個選取的文字（依位置排序） */
  const selectedTexts = (text, sels) => normalizeSels(sels).map((s) => text.slice(selFrom(s), selTo(s)));

  /** 插入數字序列：第 i 個游標（依位置排序）插入 start + i * step，pad 為補零後的最小位數 */
  function sequenceAtSels(text, sels, { start = 1, step = 1, pad = 0 } = {}) {
    const nums = normalizeSels(sels).map((_, i) => {
      const n = start + i * step;
      const s = String(Math.abs(n)).padStart(pad, '0');
      return n < 0 ? `-${s}` : s;
    });
    return insertAtSels(text, sels, nums);
  }

  /* ───────────── 分享：CSV／JSON 轉成表格 ───────────── */

  /** 猜分隔字元：第一行（引號外）出現最多的 , \t ; | */
  function guessDelimiter(text) {
    const nl = text.indexOf('\n');
    const head = text.slice(0, nl < 0 ? text.length : nl).replace(/"[^"]*"/g, '');
    let best = ',';
    let max = 0;
    for (const d of [',', '\t', ';', '|']) {
      const n = head.split(d).length - 1;
      if (n > max) { max = n; best = d; }
    }
    return best;
  }

  /** RFC 4180 CSV：支援引號、引號內換行、"" 跳脫、CRLF、BOM；略過結尾的空行 */
  function parseCsv(text, delimiter) {
    const src = String(text).replace(/^﻿/, '');
    const d = delimiter || guessDelimiter(src);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === '') { quoted = true; i++; continue; }
      if (ch === d) { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
        i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return { rows, delimiter: d };
  }

  /** 欄位名稱：空白時用「欄位 N」，重複時加上序號 */
  function uniqueNames(names) {
    const used = new Set();
    return names.map((raw, i) => {
      const base = String(raw == null ? '' : raw).trim() || `欄位 ${i + 1}`;
      let n = base;
      for (let k = 2; used.has(n); k++) n = `${base} (${k})`;
      used.add(n);
      return n;
    });
  }

  /** CSV → tooldock.table 的 payload（第一列是標題；值一律是字串，不猜型別，避免 00123、金額失真） */
  function csvToTable(text, delimiter) {
    const { rows } = parseCsv(text, delimiter);
    if (!rows.length) throw new Error('CSV 沒有內容');
    const width = Math.max(...rows.map((r) => r.length));
    const names = uniqueNames(Array.from({ length: width }, (_, i) => rows[0][i]));
    return {
      columns: names.map((name) => ({ name, type: 'string' })),
      rows: rows.slice(1).map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined ? null : r[i]))),
    };
  }

  const jsonCell = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v) ? { type: 'bigint', value: String(v) } : v;
    return { type: 'json', value: v };
  };

  /**
   * JSON → tooldock.table 的 payload；不是表格的形狀時回傳 null。
   * 接受：物件陣列（欄位是所有鍵的聯集，依出現順序）、第一列是標題的二維陣列、或只有一個陣列屬性的物件（例如 { data: [...] }）。
   */
  function jsonToTable(value) {
    let v = value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const arrays = Object.values(v).filter(Array.isArray);
      if (arrays.length !== 1) return null;
      v = arrays[0];
    }
    if (!Array.isArray(v) || !v.length) return null;
    if (v.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      const keys = [];
      const seen = new Set();
      for (const r of v) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
      if (!keys.length) return null;
      return { columns: uniqueNames(keys).map((name) => ({ name })), rows: v.map((r) => keys.map((k) => jsonCell(r[k]))) };
    }
    if (v.every(Array.isArray) && v[0].length && v[0].every((c) => typeof c === 'string' || typeof c === 'number')) {
      const width = Math.max(...v.map((r) => r.length));
      const names = uniqueNames(Array.from({ length: width }, (_, i) => v[0][i]));
      return { columns: names.map((name) => ({ name })), rows: v.slice(1).map((r) => Array.from({ length: width }, (_, i) => jsonCell(r[i]))) };
    }
    return null;
  }

  /** 檔案可以怎麼分享：回傳 [{ kind: 'table' | 'text', mime? }]，第一個是建議的方式；不支援的副檔名回傳 [] */
  function shareKinds(filename) {
    const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
    if (ext === 'md' || ext === 'markdown') return [{ kind: 'text', mime: 'text/markdown' }];
    if (ext === 'csv') return [{ kind: 'table' }, { kind: 'text', mime: 'text/csv' }];
    if (ext === 'tsv') return [{ kind: 'table' }, { kind: 'text', mime: 'text/tab-separated-values' }];
    if (ext === 'json') return [{ kind: 'table' }, { kind: 'text', mime: 'application/json' }];
    return [];
  }

  return {
    LANGS, LANG_NAME, langFor, lineComment, escapeHtml, splitHtmlLines, cursorInfo, lineStart, lineRange,
    indent, newline, toggleComment, toLines, diffLines, sideBySide, unified, fold, diffStats,
    hunks, revertHunk, sameHunk,
    searchRegex, findInText, expandReplacement, applyReplacements, splitList, globRegex, pathFilter,
    symbolsIn, symbolFamily, symbolCaseInsensitive, wordAt, importHints, rankDefinitions, joinPath,
    comboFromEvent, normalizeCombo, comboLabel, comboProblem, reservedBy, resolveKeymap, sameKeys,
    selFrom, selTo, normalizeSels, primaryOf, editSels, insertAtSels, deleteAtSels, newlineAtSels, indentSels,
    wordBoundary, visualCol, offsetAtCol, colMetrics, lineBounds, lineIndexAt, columnSels, moveSels, addCaretVertical,
    nextOccurrence, allOccurrences, selectedTexts, sequenceAtSels,
    guessDelimiter, parseCsv, csvToTable, jsonToTable, shareKinds,
  };
}));
