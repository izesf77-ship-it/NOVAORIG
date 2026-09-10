/**
 * Native toolchain detection (M5 Phase 1).
 *
 * Actually probes the environment (no assumptions): PATH, standard install
 * locations, Visual Studio, Windows SDK. Reports what exists and what is
 * missing so `nova build --native` can produce an actionable NOVA1001
 * diagnostic instead of a crash when a required tool is absent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface NativeToolchain {
  available: boolean;
  /** Human-readable summary of what is installed. */
  message: string;
  /** LLVM compiler tools. */
  llvm?: string;
  llvmAs?: string;
  llc?: string;
  clang?: string;
  lld?: string;
  /** Linker alternatives. `linker` is retained as the selected linker. */
  lldLink?: string;
  msvcLink?: string;
  msvcCl?: string;
  msvcLibDir?: string;
  linker?: string;
  /** Directory containing Windows SDK import libraries (kernel32.lib). */
  sdkLibDir?: string;
  sdkUcrtLibDir?: string;
  sdkHasKernel32: boolean;
  sdkHasUcrt: boolean;
  sdkHasVcruntime: boolean;
  sdkRoot?: string;
}

/** Bounded recursive search for `filename` under `root`. */
function findBounded(root: string, filename: string, maxDepth = 6): string | null {
  if (!fs.existsSync(root)) return null;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > maxDepth) return null;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    for (const e of entries) {
      const p = path.join(dir, e);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        const r = walk(p, depth + 1);
        if (r) return r;
      } else if (e.toLowerCase() === filename.toLowerCase() || e.toLowerCase() === filename.toLowerCase() + '.exe') {
        return p;
      }
    }
    return null;
  };
  return walk(root, 0);
}

/** Search $PATH for an executable name (case-insensitive on Windows). */
function findInPath(name: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(sep);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
      const p = path.join(d, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

const STANDARD_LLVM_BINS = [
  'C:\\Program Files\\LLVM\\bin',
  'C:\\Program Files (x86)\\LLVM\\bin',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs\\LLVM\\bin') : '',
  process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop\\apps\\llvm\\current\\bin') : '',
].filter((d) => d.length > 0);

const VS_ROOTS = [
  'C:\\Program Files (x86)\\Microsoft Visual Studio',
  'C:\\Program Files\\Microsoft Visual Studio',
];

const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';

/**
 * Probe the environment for the native toolchain of the target.
 * Deterministic; never mutates the filesystem; never downloads anything.
 */
export function detectNativeToolchain(): NativeToolchain {
  const missing: string[] = [];
  const findLlvmTool = (name: string): string | undefined => {
    let found = findInPath(name);
    if (!found) {
      for (const d of STANDARD_LLVM_BINS) {
        if (d && fs.existsSync(path.join(d, `${name}.exe`))) { found = path.join(d, `${name}.exe`); break; }
      }
    }
    return found ?? undefined;
  };
  const llvm = findLlvmTool('llvm-config') ?? findLlvmTool('llvm-as') ?? findLlvmTool('llc') ?? findLlvmTool('clang');
  const llvmAs = findLlvmTool('llvm-as');
  let llc = findLlvmTool('llc');
  const clang = findLlvmTool('clang');
  const lld = findLlvmTool('ld.lld') ?? findLlvmTool('lld');
  const lldLink = findLlvmTool('lld-link');
  if (!llc && !clang) missing.push('LLVM object backend (llc or clang) — install LLVM and add bin/ to PATH');

  let msvcLink = findInPath('link') ?? undefined;
  let msvcCl = findInPath('cl') ?? undefined;
  let msvcLibDir: string | undefined;
  let linker = lldLink ?? msvcLink;
  if (!linker && llc) {
    const sibling = path.join(path.dirname(llc), 'lld-link.exe');
    if (fs.existsSync(sibling)) linker = sibling;
  }
  for (const vr of VS_ROOTS) {
    const foundLink = msvcLink ? null : findBounded(vr, 'link.exe', 12);
    const foundCl = msvcCl ? null : findBounded(vr, 'cl.exe', 12);
    if (foundLink) { msvcLink ??= foundLink; linker ??= foundLink; }
    if (foundCl) msvcCl ??= foundCl;
    if (msvcCl && !msvcLibDir) {
      const msvcRoot = path.resolve(path.dirname(msvcCl), '..', '..', '..');
      const x64 = path.join(msvcRoot, 'lib', 'x64');
      const foundLib = fs.existsSync(path.join(x64, 'vcruntime.lib'))
        ? path.join(x64, 'vcruntime.lib')
        : findBounded(path.join(msvcRoot, 'lib'), 'vcruntime.lib', 4);
      if (foundLib) msvcLibDir = path.dirname(foundLib);
    }
    if (msvcLink && msvcCl && msvcLibDir) break;
  }
  if (!linker) missing.push('linker (lld-link or MSVC link.exe)');

  let sdkLibDir: string | undefined;
  let sdkUcrtLibDir: string | undefined;
  const sdkLib = path.join(SDK_ROOT, 'Lib');
  if (fs.existsSync(sdkLib)) {
    // Windows SDK uses separate um/<arch> and ucrt/<arch> library trees.
    for (const ver of fs.readdirSync(sdkLib)) {
      const versionRoot = path.join(sdkLib, ver);
      const um = path.join(versionRoot, 'um', 'x64');
      const ucrt = path.join(versionRoot, 'ucrt', 'x64');
      if (fs.existsSync(path.join(um, 'kernel32.lib')) || fs.existsSync(path.join(um, 'kernel32.Lib'))) sdkLibDir = um;
      if (fs.existsSync(path.join(ucrt, 'ucrt.lib'))) sdkUcrtLibDir = ucrt;
      if (sdkLibDir && sdkUcrtLibDir) break;
    }
  }
  const sdkHasKernel32 = sdkLibDir !== undefined;
  const sdkHasUcrt = sdkUcrtLibDir !== undefined;
  const sdkHasVcruntime = msvcLibDir !== undefined && fs.existsSync(path.join(msvcLibDir, 'vcruntime.lib'));
  if (!sdkHasKernel32) missing.push('Windows SDK import libraries (kernel32.lib)');

  const available = (llc !== undefined || clang !== undefined) && linker !== undefined && sdkLibDir !== undefined;
  const message = available
    ? 'Native toolchain found.'
    : 'Native toolchain not fully available:\n    - ' + missing.join('\n    - ');
  return {
    available,
    message,
    llvm,
    llvmAs,
    llc,
    clang,
    lld,
    lldLink,
    msvcLink,
    msvcCl,
    msvcLibDir,
    linker,
    sdkLibDir,
    sdkUcrtLibDir,
    sdkHasKernel32,
    sdkHasUcrt,
    sdkHasVcruntime,
    sdkRoot: fs.existsSync(SDK_ROOT) ? SDK_ROOT : undefined,
  };
}