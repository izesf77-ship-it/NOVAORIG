/**
 * LLVM backend orchestrator (M5).
 *
 * Pipeline: MIR → LLVM IR (.ll) → object (.obj) via `llc` → PE executable
 * (.exe) via `lld-link` (Windows x64). Each stage is a separate, testable
 * function; the caller can stop the pipeline at any stage with `emit`:
 *
 *   `nova build app.nova --native --emit=llvm`  → dist/app.ll
 *   `nova build app.nova --native --emit=obj`   → dist/app.obj
 *   `nova build app.nova --native --emit=exe`   → dist/app.exe
 *
 * When a required tool is missing this reports a structured NOVA1001 error
 * (never a fake result). When LLVM fails on the generated IR it reports
 * NOVA2001 with the tool output.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MirModule } from '../mir/mir.ts';
import type { SymbolTables } from './backend.ts';
import type { TargetSpec } from '../target/target.ts';
import { WINDOWS_X64 } from '../target/target.ts';
import { detectNativeToolchain } from '../target/toolchain.ts';
import type { NativeToolchain } from '../target/toolchain.ts';
import { checkToolchain } from '../target/target.ts';
import { mirToLlvm } from './llvm/llvm_codegen.ts';
import { NovaNativeError } from './native_error.ts';

export interface NativeBuildOptions {
  /** `--release`: llc -O2; otherwise -O0. */
  release: boolean;
  /** Stop the pipeline at this stage. */
  emit: 'llvm' | 'obj' | 'exe';
  target?: TargetSpec;
}

export interface NativeBuildResult {
  llPath: string;
  objPath?: string;
  exePath?: string;
  entry: string | null;
}

/** MIR → LLVM IR text (callable without any toolchain). */
export function lowerMirToLlvm(mir: MirModule, symbols: SymbolTables, target: TargetSpec = WINDOWS_X64): { text: string; entry: string | null } {
  const { module, entry } = mirToLlvm(mir, symbols, { target });
  return { text: module.emit(), entry };
}

function requireToolchain(stage: 'object' | 'link', target: TargetSpec): NativeToolchain {
  const tc = detectNativeToolchain();
  const missing: string[] = [];
  if (!tc.llc && !tc.clang) missing.push('LLVM object backend (llc or clang)');
  if (!tc.llvmAs && !tc.llc && !tc.clang) missing.push('LLVM verifier (llvm-as, llc, or clang)');
  if (stage === 'link' && !tc.linker) missing.push('lld-link or MSVC link.exe');
  if (stage === 'link' && !tc.sdkLibDir) missing.push('Windows SDK kernel32.lib');
  if (missing.length > 0) {
    const status = checkToolchain(target);
    throw new NovaNativeError(
      'NOVA1001',
      `Target: ${target.triple}\n\nMissing:\n  - ${missing.join('\n  - ')}\n\nDetected:\n  - LLVM: ${status.detected.llvm ? 'YES' : 'NO'}\n  - LLVM compiler: ${status.detected.llvmCompiler ? 'YES' : 'NO'}\n  - LLVM verifier: ${status.detected.llvmVerifier ? 'YES' : 'NO'}\n  - LLVM linker: ${status.detected.llvmLinker ? 'YES' : 'NO'}\n  - MSVC: ${status.detected.msvc ? 'YES' : 'NO'}\n  - Windows SDK: ${status.detected.windowsSdk ? 'YES' : 'NO'}\n\nNative compilation cannot continue.`,
    );
  }
  return tc;
}

function run(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
      status: err.status ?? 1,
    };
  }
}

function removeIfExists(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort cleanup */ }
}

/** Validate LLVM IR with llvm-as, llc, or clang during object emission. */
export function validateLlvm(llPath: string, target: TargetSpec, tc: NativeToolchain): void {
  const verifier = tc.llvmAs ?? tc.llc;
  if (!verifier) {
    if (tc.clang) return;
    throw new NovaNativeError('NOVA1001', `Target: ${target.triple}\n\nMissing:\n  - LLVM verifier (llvm-as, llc, or clang)\n\nLLVM IR was emitted but not validated.`);
  }
  const base = `${llPath}.verify-${process.pid}`;
  const args = tc.llvmAs
    ? ['-o', `${base}.bc`, llPath]
    : ['-mtriple=' + target.triple, '-filetype=null', '-o', `${base}.null`, llPath];
  const res = run(verifier, args, path.dirname(llPath));
  removeIfExists(`${base}.bc`);
  removeIfExists(`${base}.null`);
  if (res.status !== 0) {
    throw new NovaNativeError('NOVA2001', `LLVM verifier rejected the generated IR.\n\n${res.stderr.trim() || res.stdout.trim() || '(no diagnostic from LLVM)'}`);
  }
}

/** Write the LLVM IR text to `dist/<name>.ll` and return its path. */
function writeLl(fileBase: string, text: string): string {
  const dir = path.dirname(fileBase);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const llPath = `${fileBase}.ll`;
  fs.writeFileSync(llPath, text, 'utf8');
  return llPath;
}

/** LLVM IR (.ll) → COFF object (.obj) with llc, or clang as a real fallback. */
export function emitObject(llPath: string, target: TargetSpec, opts: NativeBuildOptions, tc: NativeToolchain): string {
  const objPath = llPath.replace(/\.ll$/, '.obj');
  const tempPath = `${objPath}.tmp-${process.pid}`;
  removeIfExists(objPath);
  removeIfExists(tempPath);
  const opt = opts.release ? '-O2' : '-O0';
  const backend = tc.llc ?? tc.clang;
  if (!backend) throw new NovaNativeError('NOVA1001', `Target: ${target.triple}\n\nMissing:\n  - LLVM object backend (llc or clang)`);
  const isClang = tc.llc === undefined;
  const args = isClang
    ? ['-c', '-target', target.triple, opt, '-x', 'ir', '-o', tempPath, llPath]
    : [opt, '-mtriple=' + target.triple, '-filetype=obj', '-o', tempPath, llPath];
  const res = run(backend, args, path.dirname(llPath));
  const validCoff = fs.existsSync(tempPath) && isCoffObject(tempPath);
  if (res.status !== 0 || !validCoff) {
    removeIfExists(tempPath);
    removeIfExists(objPath);
    throw new NovaNativeError('NOVA2001', `${isClang ? 'clang' : 'llc'} failed on the generated LLVM IR.\n\n  $ ${path.basename(backend)} ${args.join(' ')}\n\n` + (res.stderr.trim() || res.stdout.trim() || '(no output)'));
  }
  fs.renameSync(tempPath, objPath);
  return objPath;
}

function isCoffObject(file: string): boolean {
  const header = fs.readFileSync(file).subarray(0, 2);
  return header.length === 2 && header[0] === 0x64 && header[1] === 0x86;
}

const WIN_SDK_DEFAULT_LIBS = ['kernel32.lib', 'shell32.lib', 'libcmt.lib'];

/** Object (.obj) → PE executable (.exe). */
export function linkExecutable(objPath: string, entry: string, target: TargetSpec, opts: NativeBuildOptions, tc: NativeToolchain): string {
  const exePath = objPath.replace(/\.obj$/, '.exe');
  const tempPath = `${exePath}.tmp-${process.pid}`;
  removeIfExists(exePath);
  removeIfExists(tempPath);
  const linker = tc.linker!;
  const libArgs: string[] = [];
  if (tc.sdkLibDir) {
    libArgs.push('/libpath:' + tc.sdkLibDir);
    if (tc.sdkUcrtLibDir) libArgs.push('/libpath:' + tc.sdkUcrtLibDir);
  }
  if (tc.msvcLibDir) {
    libArgs.push('/libpath:' + tc.msvcLibDir);
  }
  for (const lib of WIN_SDK_DEFAULT_LIBS) {
    libArgs.push(lib);
  }
  const args = ['/entry:' + entry, '/subsystem:console', '/nologo', '/out:' + tempPath, ...libArgs, objPath];
  const res = run(linker, args, path.dirname(objPath));
  const failed = res.status !== 0 || !isPeExecutable(tempPath);
  if (failed) {
    removeIfExists(tempPath);
    removeIfExists(exePath);
    throw new NovaNativeError('NOVA2001', `linker failed.\n\n  $ ${linker} ${args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ')}\n\n` + (res.stdout.trim() || res.stderr.trim() || '(no output)'));
  }
  fs.renameSync(tempPath, exePath);
  return exePath;
}

function isPeExecutable(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const header = fs.readFileSync(file).subarray(0, 2);
  return header.length === 2 && header[0] === 0x4d && header[1] === 0x5a;
}

/** Full native build: MIR → .ll → .obj → .exe (stops at `emit` stage). */
export function buildNative(mir: MirModule, symbols: SymbolTables, fileBase: string, opts: NativeBuildOptions): NativeBuildResult {
  // Tool subprocesses run with the artifact directory as CWD, so the base
  // path must be absolute for the generated paths to resolve consistently.
  const target = opts.target ?? WINDOWS_X64;
  const { text, entry } = lowerMirToLlvm(mir, symbols, target);
  const llPath = writeLl(path.resolve(fileBase), text);
  if (opts.emit === 'llvm') return { llPath, entry };

  const tc = requireToolchain('object', target);
  validateLlvm(llPath, target, tc);
  const objPath = emitObject(llPath, target, opts, tc);
  if (opts.emit === 'obj') return { llPath, objPath, entry };

  if (!entry) {
    throw new NovaNativeError('NOVA2001', `no 'main' function in this module — nothing to link`);
  }
  const linkTc = requireToolchain('link', target);
  const exePath = linkExecutable(objPath, entry.replace('@', ''), target, opts, linkTc);
  return { llPath, objPath, exePath, entry };
}