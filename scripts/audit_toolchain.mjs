// Toolchain audit for M5 — writes audit_result.txt (pure JS, no PowerShell quoting issues).
import * as fs from 'node:fs';
import * as path from 'node:path';

const lines = [];
const out = (s) => lines.push(s);

const PATH_TOOLS = ['llc', 'clang', 'clang-cl', 'llvm-as', 'opt', 'llvm-link', 'lld-link', 'ld.lld', 'llvm-objdump', 'llvm-readobj', 'gcc', 'ld'];

out('=== LLVM tools (PATH) ===');
for (const t of PATH_TOOLS) {
  try {
    const which = (() => {
      const sep = process.platform === 'win32' ? ';' : ':';
      const ext = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
      const paths = (process.env.PATH ?? '').split(sep);
      for (const p of paths) for (const e of ext) {
        const full = path.join(p, t + e);
        if (fs.existsSync(full)) return full;
      }
      return null;
    })();
    out(which ? `[FOUND] ${which}` : `[MISSING] ${t}`);
  } catch { out(`[MISSING] ${t}`); }
}

out('');
out('=== Standard install locations ===');
const candidateDirs = [
  'C:\\Program Files\\LLVM\\bin',
  'C:\\Program Files (x86)\\LLVM\\bin',
  'C:\\Users\\admin\\AppData\\Local\\Programs\\LLVM\\bin',
  'C:\\Users\\admin\\scoop\\apps\\llvm\\current\\bin',
];
for (const d of candidateDirs) {
  if (fs.existsSync(path.join(d, 'llc.exe'))) out(`[FOUND] ${d}\\llc.exe`);
  else out(`[MISSING] ${d}`);
}

out('');
out('=== MSVC / Visual Studio ===');
const vsRoots = [
  'C:\\Program Files (x86)\\Microsoft Visual Studio',
  'C:\\Program Files\\Microsoft Visual Studio',
];
const walk = (dir, depth, re, found) => {
  if (depth > 7) return;
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1, re, found);
    else if (re.test(e.toLowerCase())) found.push(p);
  }
};
for (const vr of vsRoots) {
  if (!fs.existsSync(vr)) { out(`[MISSING] ${vr}`); continue; }
  out(`[EXISTS] ${vr}`);
  const found = [];
  walk(vr, 0, /^(cl|link|lld-link)\.exe$/, found);
  for (const f of found) out(`[TOOL] ${f}`);
  if (found.length === 0) out(`[NOTE] no cl/link/lld-link under ${vr}`);
}

out('');
out('=== Windows SDK ===');
const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10';
if (fs.existsSync(sdkRoot)) {
  out(`[EXISTS] ${sdkRoot}`);
  try {
    for (const v of fs.readdirSync(path.join(sdkRoot, 'Include'))) out(`  SDK include version: ${v}`);
  } catch { out('  (no Include dir)'); }
  const found = [];
  walk(sdkRoot, 0, /^link\.exe$/, found);
  for (const f of found) out(`[TOOL] ${f}`);
} else {
  out('[MISSING] ' + sdkRoot);
}

out('');
out('=== MinGW / GCC fallback ===');
for (const d of ['C:\\msys64\\usr\\bin', 'C:\\mingw64\\bin', 'C:\\MinGW\\bin']) {
  if (fs.existsSync(path.join(d, 'gcc.exe'))) out(`[FOUND] ${d}\\gcc.exe`);
  else out(`[MISSING] ${d}`);
}

fs.writeFileSync('c:\\Users\\admin\\Desktop\\NOVA\\audit_result.txt', lines.join('\r\n'));
console.log(lines.join('\n'));