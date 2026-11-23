'use strict';
/**
 * Java .class 檔解析（不需要 Java）：讀出類別、欄位、方法的宣告，輸出成 Java 語法的大綱。
 * 只有宣告，沒有方法內容；有 Java 時改用 CFR 反編譯（decompile.js）。
 * 格式：JVM 規格第 4 章 The class File Format。
 */

const ACC = {
  PUBLIC: 0x0001, PRIVATE: 0x0002, PROTECTED: 0x0004, STATIC: 0x0008, FINAL: 0x0010, SYNCHRONIZED: 0x0020,
  VOLATILE: 0x0040, BRIDGE: 0x0040, TRANSIENT: 0x0080, VARARGS: 0x0080, NATIVE: 0x0100, INTERFACE: 0x0200,
  ABSTRACT: 0x0400, STRICT: 0x0800, SYNTHETIC: 0x1000, ANNOTATION: 0x2000, ENUM: 0x4000, MODULE: 0x8000,
};

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  need(n) { if (this.p + n > this.b.length) throw new Error('class 檔不完整'); }
  u1() { this.need(1); return this.b[this.p++]; }
  u2() { this.need(2); const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  u4() { this.need(4); const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
}

/** class 檔的「修改過的 UTF-8」（\0 以兩個位元組表示、補充字元以兩組代理字元表示） */
function mutf8(buf) {
  let out = '';
  for (let i = 0; i < buf.length;) {
    const a = buf[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else { const b = buf[i++]; const c = buf[i++]; out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f)); }
  }
  return out;
}

function parse(buf) {
  const r = new Reader(buf);
  if (r.u4() !== 0xcafebabe) throw new Error('不是 Java class 檔');
  const minor = r.u2();
  const major = r.u2();
  const count = r.u2();
  const cp = new Array(count);
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1: cp[i] = { tag, s: mutf8(r.bytes(r.u2())) }; break;
      case 3: cp[i] = { tag, v: r.b.readInt32BE((r.need(4), r.p)) }; r.p += 4; break;
      case 4: cp[i] = { tag, v: r.b.readFloatBE((r.need(4), r.p)) }; r.p += 4; break;
      case 5: cp[i] = { tag, v: r.b.readBigInt64BE((r.need(8), r.p)) }; r.p += 8; i++; break;
      case 6: cp[i] = { tag, v: r.b.readDoubleBE((r.need(8), r.p)) }; r.p += 8; i++; break;
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, a: r.u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: r.u2(), b: r.u2() }; break;
      case 15: cp[i] = { tag, a: r.u1(), b: r.u2() }; break;
      default: throw new Error(`無法辨識的常數池項目（tag ${tag}）`);
    }
  }
  const utf = (i) => (cp[i] && cp[i].tag === 1 ? cp[i].s : '');
  const cls = (i) => (cp[i] && cp[i].tag === 7 ? utf(cp[i].a) : '');
  const attrs = () => {
    const n = r.u2();
    const out = {};
    for (let k = 0; k < n; k++) {
      const name = utf(r.u2());
      const len = r.u4();
      out[name] = r.bytes(len);
    }
    return out;
  };
  const access = r.u2();
  const thisClass = cls(r.u2());
  const superIdx = r.u2();
  const superClass = superIdx ? cls(superIdx) : '';
  const interfaces = [];
  for (let n = r.u2(), k = 0; k < n; k++) interfaces.push(cls(r.u2()));
  const members = () => {
    const out = [];
    for (let n = r.u2(), k = 0; k < n; k++) {
      const m = { access: r.u2(), name: utf(r.u2()), desc: utf(r.u2()) };
      m.attrs = attrs();
      out.push(m);
    }
    return out;
  };
  const fields = members();
  const methods = members();
  const classAttrs = attrs();
  return { minor, major, cp, utf, cls, access, thisClass, superClass, interfaces, fields, methods, attrs: classAttrs };
}

/* ───────────── 型別描述 → Java 寫法 ───────────── */

const PRIM = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' };

/** 內部名稱（java/util/Map$Entry）→ 顯示名稱：同套件與 java.lang 只留類別名稱，內部類別用 . */
function makeNamer(pkg) {
  return (internal) => {
    const i = internal.lastIndexOf('/');
    const p = i < 0 ? '' : internal.slice(0, i);
    const simple = internal.slice(i + 1).replace(/\$/g, '.');
    return p === pkg || p === 'java/lang' ? simple : `${p.replace(/\//g, '.')}.${simple}`;
  };
}

/** 讀一個欄位描述（I、[Ljava/lang/String;）；回傳 [型別, 下一個位置] */
function readType(d, i, name) {
  let dims = 0;
  while (d[i] === '[') { dims++; i++; }
  let t;
  if (d[i] === 'L') { const e = d.indexOf(';', i); t = name(d.slice(i + 1, e)); i = e + 1; } else { t = PRIM[d[i]] || '?'; i++; }
  return [t + '[]'.repeat(dims), i];
}

function methodTypes(desc, name) {
  const params = [];
  let i = 1;
  while (i < desc.length && desc[i] !== ')') { const [t, n] = readType(desc, i, name); params.push(t); i = n; }
  const [ret] = readType(desc, i + 1, name);
  return { params, ret };
}

/** 泛型簽章（Signature 屬性）→ 型別參數、參數、回傳型別；解析失敗時回傳 null */
function genericSig(sig, name) {
  if (!sig) return null;
  let i = 0;
  const typeArgs = () => {
    const out = [];
    i++; // <
    while (sig[i] !== '>') {
      if (sig[i] === '*') { out.push('?'); i++; } else if (sig[i] === '+') { i++; out.push(`? extends ${type()}`); } else if (sig[i] === '-') { i++; out.push(`? super ${type()}`); } else out.push(type());
    }
    i++;
    return `<${out.join(', ')}>`;
  };
  const classType = () => {
    i++; // L
    let s = '';
    let res = '';
    while (sig[i] !== ';') {
      if (sig[i] === '<') { res += name(s) + typeArgs(); s = ''; } else if (sig[i] === '.') { res += '.'; i++; } else s += sig[i++];
    }
    i++;
    if (s) res += res ? s : name(s);
    return res;
  };
  const type = () => {
    const c = sig[i];
    if (c === 'L') return classType();
    if (c === 'T') { const e = sig.indexOf(';', i); const v = sig.slice(i + 1, e); i = e + 1; return v; }
    if (c === '[') { i++; return `${type()}[]`; }
    i++;
    return PRIM[c] || '?';
  };
  const formals = () => {
    if (sig[i] !== '<') return '';
    i++;
    const out = [];
    while (sig[i] !== '>') {
      const e = sig.indexOf(':', i);
      const id = sig.slice(i, e);
      i = e;
      const bounds = [];
      while (sig[i] === ':') { i++; if (sig[i] !== ':' && sig[i] !== '>') { const b = type(); if (b !== 'Object') bounds.push(b); } }
      out.push(bounds.length ? `${id} extends ${bounds.join(' & ')}` : id);
    }
    i++;
    return `<${out.join(', ')}>`;
  };
  try {
    const tp = formals();
    if (sig[i] === '(') {
      i++;
      const params = [];
      while (sig[i] !== ')') params.push(type());
      i++;
      const ret = type();
      return { tp, params, ret };
    }
    const sup = type();
    const ifs = [];
    while (i < sig.length) ifs.push(type());
    return { tp, sup, ifs, field: sup };
  } catch {
    return null;
  }
}

function mods(acc, kind) {
  const out = [];
  if (acc & ACC.PUBLIC) out.push('public');
  if (acc & ACC.PRIVATE) out.push('private');
  if (acc & ACC.PROTECTED) out.push('protected');
  if (acc & ACC.STATIC) out.push('static');
  if (kind !== 'class' && kind !== 'interface' && acc & ACC.FINAL) out.push('final');
  if (kind === 'class' && acc & ACC.FINAL) out.push('final');
  if (kind === 'method' && acc & ACC.SYNCHRONIZED) out.push('synchronized');
  if (kind === 'field' && acc & ACC.VOLATILE) out.push('volatile');
  if (kind === 'field' && acc & ACC.TRANSIENT) out.push('transient');
  if (kind === 'method' && acc & ACC.NATIVE) out.push('native');
  if ((kind === 'method' || kind === 'class') && acc & ACC.ABSTRACT) out.push('abstract');
  return out.join(' ');
}

function javaVersion(major) {
  if (major >= 49) return String(major - 44);
  return { 45: '1.1', 46: '1.2', 47: '1.3', 48: '1.4' }[major] || `?（${major}）`;
}

function literal(c) {
  if (!c) return null;
  if (c.tag === 3) return String(c.v);
  if (c.tag === 4) return Number.isFinite(c.v) ? `${c.v}F` : null;
  if (c.tag === 5) return `${c.v}L`;
  if (c.tag === 6) return Number.isFinite(c.v) ? String(c.v).includes('.') || /e/i.test(String(c.v)) ? String(c.v) : `${c.v}.0` : null;
  return null;
}

/** class 檔 → Java 語法的大綱文字 */
function outline(buf) {
  const c = parse(buf);
  const pkgIdx = c.thisClass.lastIndexOf('/');
  const pkg = pkgIdx < 0 ? '' : c.thisClass.slice(0, pkgIdx);
  const name = makeNamer(pkg);
  const u2 = (b, o) => b.readUInt16BE(o);
  const sigOf = (attrs) => (attrs.Signature ? c.utf(u2(attrs.Signature, 0)) : '');
  const isInterface = !!(c.access & ACC.INTERFACE);
  const isAnno = !!(c.access & ACC.ANNOTATION);
  const isEnum = !!(c.access & ACC.ENUM);
  const isRecord = !!c.attrs.Record;
  const simple = name(c.thisClass).split('.').pop();
  const lines = [];
  const src = c.attrs.SourceFile ? c.utf(u2(c.attrs.SourceFile, 0)) : '';
  lines.push(`/*\n * ${simple}.class 的結構（只有宣告，沒有方法內容）\n * 編譯版本：Java ${javaVersion(c.major)}（class ${c.major}.${c.minor}）${src ? `\n * 原始檔：${src}` : ''}\n */`);
  if (pkg) lines.push(`package ${pkg.replace(/\//g, '.')};`, '');

  const cs = genericSig(sigOf(c.attrs), name);
  const kw = isAnno ? '@interface' : isInterface ? 'interface' : isEnum ? 'enum' : isRecord ? 'record' : 'class';
  let head = [mods(c.access & ~(isInterface ? ACC.ABSTRACT : 0) & ~(isEnum ? ACC.FINAL : 0), isInterface ? 'interface' : 'class'), kw, simple + (cs ? cs.tp : '')].filter(Boolean).join(' ');
  const sup = cs ? cs.sup : c.superClass ? name(c.superClass) : '';
  const ifs = cs ? cs.ifs : c.interfaces.map(name);
  if (sup && sup !== 'Object' && !isEnum && !isRecord && !sup.startsWith('Enum<') && !isInterface) head += ` extends ${sup}`;
  const extIfs = ifs.filter((x) => !(isAnno && x === 'java.lang.annotation.Annotation') && x !== 'annotation.Annotation');
  if (extIfs.length) head += `${isInterface ? ' extends ' : ' implements '}${extIfs.join(', ')}`;
  lines.push(`${head} {`);

  const body = [];
  for (const f of c.fields) {
    if (f.access & ACC.SYNTHETIC) continue;
    const g = genericSig(sigOf(f.attrs), name);
    const [t] = readType(f.desc, 0, name);
    const type = g && g.field ? g.field : t;
    if (isEnum && f.access & ACC.ENUM) { body.push(`    ${f.name},`); continue; }
    const cv = f.attrs.ConstantValue ? c.cp[u2(f.attrs.ConstantValue, 0)] : null;
    let init = literal(cv);
    if (cv && cv.tag === 8) init = JSON.stringify(c.utf(cv.a));
    if (init !== null && type === 'boolean') init = init === '0' ? 'false' : 'true';
    if (init !== null && type === 'char' && cv && cv.tag === 3) init = JSON.stringify(String.fromCharCode(cv.v)).replace(/^"|"$/g, "'");
    const m = isInterface ? '' : mods(f.access, 'field');
    body.push(`    ${[m, type, f.name].filter(Boolean).join(' ')}${init !== null ? ` = ${init}` : ''};`);
  }
  const lastConst = body.map((l) => /^    \w+,$/.test(l)).lastIndexOf(true);
  if (isEnum && lastConst >= 0) body[lastConst] = body[lastConst].replace(/,$/, ';');
  if (body.length) body.push('');
  for (const m of c.methods) {
    if (m.access & (ACC.SYNTHETIC | ACC.BRIDGE)) continue;
    if (m.name === '<clinit>') continue;
    if (isEnum && ((m.name === 'values' && m.desc.startsWith('()[')) || (m.name === 'valueOf' && m.desc.startsWith('(Ljava/lang/String;)')))) continue;
    const plain = methodTypes(m.desc, name);
    const g = genericSig(sigOf(m.attrs), name);
    const params = [...(g && g.params.length === plain.params.length ? g.params : plain.params)];
    const ret = g ? g.ret : plain.ret;
    let names = [];
    if (m.attrs.MethodParameters) {
      const b = m.attrs.MethodParameters;
      const hidden = [];
      for (let k = 0; k < b[0]; k++) {
        names.push(c.utf(u2(b, 1 + k * 4)) || `arg${k}`);
        if (u2(b, 3 + k * 4) & 0x9000) hidden.push(k); // 編譯器加的參數（MANDATED、SYNTHETIC）
      }
      if (names.length === params.length && hidden.length) {
        for (const k of hidden.reverse()) { names.splice(k, 1); params.splice(k, 1); }
      }
    }
    if (names.length !== params.length) names = params.map((_, k) => `arg${k}`);
    if (m.access & ACC.VARARGS && params.length) params[params.length - 1] = params[params.length - 1].replace(/\[\]$/, '...');
    const args = params.map((t, k) => `${t} ${names[k]}`).join(', ');
    let throws = '';
    if (m.attrs.Exceptions) {
      const b = m.attrs.Exceptions;
      const n = u2(b, 0);
      const ex = [];
      for (let k = 0; k < n; k++) ex.push(name(c.cls(u2(b, 2 + k * 2))));
      if (ex.length) throws = ` throws ${ex.join(', ')}`;
    }
    let acc = m.access;
    if (isInterface) acc &= ~(ACC.PUBLIC | ACC.ABSTRACT);
    const mm = mods(acc, 'method');
    const def = isInterface && !(m.access & ACC.ABSTRACT) && !(m.access & ACC.STATIC) && !(m.access & ACC.PRIVATE) ? 'default ' : '';
    const tp = g && g.tp ? `${g.tp} ` : '';
    const sigText = m.name === '<init>' ? `${simple}(${args})` : `${tp}${ret} ${m.name}(${args})`;
    const hasBody = !(m.access & (ACC.ABSTRACT | ACC.NATIVE));
    body.push(`    ${[mm, def + sigText].filter(Boolean).join(' ')}${throws}${hasBody ? ' { /* 已編譯 */ }' : ';'}`);
  }
  while (body.length && !body[body.length - 1]) body.pop();
  lines.push(...body, '}', '');
  return { text: lines.join('\n'), className: c.thisClass.replace(/\//g, '.'), major: c.major };
}

module.exports = { parse, outline, javaVersion, genericSig, makeNamer };
