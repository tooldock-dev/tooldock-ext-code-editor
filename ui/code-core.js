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

  return {
    LANGS, LANG_NAME, langFor, lineComment, escapeHtml, splitHtmlLines, cursorInfo, lineStart, lineRange,
    indent, newline, toggleComment, toLines, diffLines, sideBySide, unified, fold, diffStats,
  };
}));
