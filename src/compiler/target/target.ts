/**
 * NOVA Target Abstraction.
 *
 * A Target describes the compilation target: architecture, OS, object format,
 * pointer width, endianness, and the associated ABI + data layout rules.
 *
 * This is the boundary between MIR (backend-agnostic) and LLVM/native codegen.
 *
 * The first supported target is:
 *   x86_64-pc-windows-msvc
 *
 * Architecture supports adding:
 *   - Linux x86_64
 *   - Linux ARM64
 *   - macOS ARM64
 *   - Windows ARM64
 */

export type Architecture = 'x86_64' | 'aarch64';
export type OperatingSystem = 'windows' | 'linux' | 'macos';
export type ObjectFormat = 'coff' | 'elf' | 'macho';
export type Endianness = 'little' | 'big';
import { detectNativeToolchain } from './toolchain.ts';

/**
 * Calling convention enum — backend-independent.
 * 'system' means the platform's native C calling convention.
 */
export type CallingConvention = 'system' | 'c' | 'stdcall' | 'win64';

/**
 * A compilation target.
 */
export interface TargetSpec {
  /** LLVM-style target triple, e.g. "x86_64-pc-windows-msvc" */
  triple: string;
  architecture: Architecture;
  operatingSystem: OperatingSystem;
  objectFormat: ObjectFormat;
  pointerWidth: 32 | 64;
  endianness: Endianness;
  callingConvention: CallingConvention;
  /** LLVM data layout string (used when emitting LLVM IR) */
  dataLayout: string;
  /** Alignment of the stack (ABI-defined) */
  stackAlignment: number;
  /** Maximum natural alignment of any type */
  maxAlignment: number;
}

/** Predefined Windows x64 target. */
export const WINDOWS_X64: TargetSpec = {
  triple: 'x86_64-pc-windows-msvc',
  architecture: 'x86_64',
  operatingSystem: 'windows',
  objectFormat: 'coff',
  pointerWidth: 64,
  endianness: 'little',
  callingConvention: 'win64',
  dataLayout: 'e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S32',
  stackAlignment: 16, // Windows x64 ABI stack alignment
  maxAlignment: 16, // 16-byte alignment for SIMD
};

/** Predefined Linux x64 target (for future use). */
export const LINUX_X64: TargetSpec = {
  triple: 'x86_64-unknown-linux-gnu',
  architecture: 'x86_64',
  operatingSystem: 'linux',
  objectFormat: 'elf',
  pointerWidth: 64,
  endianness: 'little',
  callingConvention: 'c',
  dataLayout: 'e-m:e-p270:32:64-n8:16:32:64-i64:32:64-i128:64-i64:64-i128:128',
  stackAlignment: 16,
  maxAlignment: 16,
};

/** Predefined macOS ARM64 target (for future use). */
export const MACOS_ARM64: TargetSpec = {
  triple: 'aarch64-apple-darwin',
  architecture: 'aarch64',
  operatingSystem: 'macos',
  objectFormat: 'macho',
  pointerWidth: 64,
  endianness: 'little',
  callingConvention: 'c',
  dataLayout: 'e-m:o-i64:64-i128:128-16:64-n8:16:32:64',
  stackAlignment: 16384,
  maxAlignment: 16,
};

/**
 * All supported targets.
 */
export const TARGETS: Record<string, TargetSpec> = {
  'x86_64-pc-windows-msvc': WINDOWS_X64,
  'x86_64-unknown-linux-gnu': LINUX_X64,
  'aarch64-apple-darwin': MACOS_ARM64,
};

/**
 * Default target — Windows x64 (first supported native target).
 */
export function defaultTarget(): TargetSpec {
  return WINDOWS_X64;
}

/**
 * Look up a target by triple.
 * @throws if the target triple is unknown.
 */
export function lookupTarget(triple: string): TargetSpec {
  const t = TARGETS[triple];
  if (!t) throw new Error(`Unknown target triple: ${triple}`);
  return t;
}

/**
 * Check if a native toolchain is available for the given target.
 * Returns a diagnostic message if not.
 */
export interface ToolchainStatus {
  available: boolean;
  message: string;
  detected: {
    llvm: boolean;
    llvmCompiler: boolean;
    llvmVerifier: boolean;
    llvmLinker: boolean;
    msvc: boolean;
    windowsSdk: boolean;
    windowsSdkLibraries: boolean;
    crt: boolean;
  };
  /** Paths to discovered tools (empty fields if not found). */
  tools: {
    llvm?: string;
    llvmAs?: string;
    llc?: string;
    clang?: string;
    lld?: string;
    lldLink?: string;
    msvcLink?: string;
    msvcCl?: string;
    msvcLibDir?: string;
    sdkLibDir?: string;
  };
}

/**
 * Check if the native toolchain is available for the given target.
 *
 * Performs a real environment probe (LLVM + linker + Windows SDK) via
 * `detectNativeToolchain`. Never downloads or installs anything — when parts
 * are missing, `available` is false and `message` lists what needs manual
 * installation.
 */
export function checkToolchain(target: TargetSpec): ToolchainStatus {
  const sdk = detectNativeToolchain();
  const tools: ToolchainStatus['tools'] = {
    llvm: sdk.llvm,
    llvmAs: sdk.llvmAs,
    llc: sdk.llc,
    clang: sdk.clang,
    lld: sdk.lld,
    lldLink: sdk.lldLink,
    msvcLink: sdk.msvcLink,
    msvcCl: sdk.msvcCl,
    msvcLibDir: sdk.msvcLibDir,
    sdkLibDir: sdk.sdkLibDir,
  };
  const windows = target.operatingSystem === 'windows';
  return {
    available: windows ? sdk.available : false,
    message: windows ? sdk.message : `native target '${target.triple}' is not implemented yet`,
    detected: {
      llvm: sdk.llvm !== undefined,
      llvmCompiler: sdk.llc !== undefined || sdk.clang !== undefined,
      llvmVerifier: sdk.llvmAs !== undefined || sdk.llc !== undefined,
      llvmLinker: sdk.lld !== undefined || sdk.lldLink !== undefined,
      msvc: sdk.msvcCl !== undefined || sdk.msvcLink !== undefined,
      windowsSdk: sdk.sdkRoot !== undefined,
      windowsSdkLibraries: sdk.sdkHasKernel32 && sdk.sdkHasUcrt,
      crt: sdk.sdkHasUcrt && sdk.sdkHasVcruntime,
    },
    tools,
  };
}