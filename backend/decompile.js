'use strict';
/**
 * .class 反編譯：有 Java 時以附帶的 CFR（vendor/cfr-<版本>.jar，MIT 授權）反編譯成 Java 原始碼；
 * 找不到 Java 或反編譯失敗時，改用 classfile.js 顯示類別結構（只有宣告）。
 * 結果依檔案路徑、修改時間與大小快取。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const classfile = require('./classfile');

const CFR_VERSION = '0.152';
const CFR_JAR = path.join(__dirname, '..', 'vendor', `cfr-${CFR_VERSION}.jar`);
const MAX_CLASS = 20 * 1024 * 1024;
const CACHE = 50;

const cache = new Map(); // `${file}|${mtime}|${size}` → 結果
let javaFound; // undefined = 還沒找過；null = 找不到
let javaFoundFor;

function run(bin, args, { timeout = 30000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: '' } }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').trim(); reject(err); } else resolve({ stdout, stderr });
    });
  });
}

const exe = (dir) => path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

/**
 * 找 java：有設定就只用設定的路徑（java 或 JDK 資料夾）；沒有設定時依序找 JAVA_HOME → macOS 的 /usr/libexec/java_home → PATH 上的 java。
 * macOS 沒有安裝 JDK 時 /usr/bin/java 只會跳出安裝提示，所以 macOS 不直接用 PATH 上的 java。
 */
async function findJava(setting) {
  if (javaFound !== undefined && javaFoundFor === (setting || '')) return javaFound;
  const cands = [];
  if (setting) {
    cands.push(fs.existsSync(setting) && fs.statSync(setting).isDirectory() ? exe(setting) : setting);
  } else {
    if (process.env.JAVA_HOME) cands.push(exe(process.env.JAVA_HOME));
    if (process.platform === 'darwin') {
      try { cands.push(exe((await run('/usr/libexec/java_home', [], { timeout: 5000 })).stdout.trim())); } catch { /* 沒有 JDK */ }
    } else cands.push('java');
  }
  let found = null;
  for (const c of [...new Set(cands)]) {
    try {
      const r = await run(c, ['-version'], { timeout: 10000 });
      const v = (r.stderr || r.stdout).match(/version "([^"]+)"/);
      found = { bin: c, version: v ? v[1] : '' };
      break;
    } catch { /* 下一個 */ }
  }
  javaFound = found;
  javaFoundFor = setting || '';
  return found;
}

const hasCfr = () => fs.existsSync(CFR_JAR);

/** 同一個資料夾中屬於這個類別的內部類別（Outer$Inner.class），CFR 才能一起還原 */
function innerClasses(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.class');
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(`${base}$`) && n.endsWith('.class')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * 反編譯：回傳 { text, engine: 'cfr' | 'outline', note }
 * opts.javaPath：設定的 java 位置（空字串表示自動尋找）
 */
async function decompile(file, { javaPath = '' } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('檔案路徑不正確');
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('不是檔案');
  if (st.size > MAX_CLASS) throw new Error('class 檔太大');
  const key = `${file}|${st.mtimeMs}|${st.size}|${javaPath}`;
  if (cache.has(key)) return cache.get(key);
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0xcafebabe) throw new Error('不是 Java class 檔');

  let result = null;
  let why = '';
  const java = hasCfr() ? await findJava(javaPath) : null;
  if (!hasCfr()) why = '擴充缺少 CFR';
  else if (!java) why = javaPath ? `設定的 java 執行檔無法執行：${javaPath}` : '找不到 Java 執行環境（可在設定「java 執行檔」指定）';
  else {
    try {
      const args = ['-jar', CFR_JAR, file, ...innerClasses(file), '--silent', 'true', '--comments', 'false', '--outputencoding', 'UTF-8'];
      const r = await run(java.bin, args, { cwd: path.dirname(file) });
      const text = r.stdout.replace(/\r\n?/g, '\n').trim();
      if (!text) throw new Error(r.stderr || 'CFR 沒有輸出');
      result = { text: `${unescapeUnicode(text)}\n`, engine: 'cfr', note: `以 CFR ${CFR_VERSION} 反編譯（Java ${java.version}），唯讀` };
    } catch (err) {
      why = `CFR 反編譯失敗：${(err.stderr || err.message || '').split('\n')[0]}`;
    }
  }
  if (!result) {
    const o = classfile.outline(buf);
    result = { text: o.text, engine: 'outline', note: `${why}；只顯示類別結構，唯讀` };
  }
  cache.set(key, result);
  if (cache.size > CACHE) cache.delete(cache.keys().next().value);
  return result;
}

/**
 * CFR 把非 ASCII 字元寫成 \uXXXX：可顯示的字元換回原字（例如中文字串），
 * 前面是跳脫的反斜線（\\u…）與控制字元、代理字元則維持原樣。
 */
function unescapeUnicode(text) {
  return text.replace(/(\\+)u([0-9a-fA-F]{4})/g, (all, bs, hex) => {
    if (bs.length % 2 === 0) return all;
    const code = parseInt(hex, 16);
    if (code < 0xa0 || (code >= 0xd800 && code <= 0xdfff) || code === 0x2028 || code === 0x2029 || code === 0xfeff) return all;
    return bs.slice(1) + String.fromCharCode(code);
  });
}

const _reset = () => { cache.clear(); javaFound = undefined; };

module.exports = { decompile, findJava, hasCfr, unescapeUnicode, CFR_JAR, CFR_VERSION, _reset };
