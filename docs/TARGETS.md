# NOVA Target Support

**Last updated:** 2026-09-06
**Status:** M5 subphase — target abstraction feeds LLVM lowering; PE execution remains environment-dependent

---

## 1. Overview

NOVA targets multiple platform combinations. The target abstraction is in
`src/compiler/target/` and defines the triple, architecture, OS, object format,
pointer width, endianness, and calling convention.

## 2. Supported Targets

### Primary: Windows x64

```
Triple: x86_64-pc-windows-msvc
Architecture: x86_64
OS: windows
Object format: COFF
Pointer width: 64-bit
Endianness: little
Calling convention: Windows x64
Stack alignment: 16-byte
```

This is the only fully specified target. Native code generation will target
this first.

### Planned (not yet implemented)

| Triple | Architecture | OS | Object |
|--------|-------------|-----|--------|
| `x86_64-unknown-linux-gnu` | x86_64 | linux | ELF |
| `aarch64-apple-darwin` | aarch64 | macos | Mach-O |
| `aarch64-pc-windows-msvc` | aarch64 | windows | COFF |

## 3. Target Abstraction

Defined in `src/compiler/target/target.ts`:

```typescript
export interface TargetSpec {
  triple: string;
  architecture: Architecture;
  operatingSystem: OperatingSystem;
  objectFormat: ObjectFormat;
  pointerWidth: 32 | 64;
  endianness: Endianness;
  callingConvention: CallingConvention;
  dataLayout: string;
  stackAlignment: number;
  maxAlignment: number;
}
```

### Calling Conventions

| Convention | Platforms | Description |
|-----------|-----------|-------------|
| `win64` | Windows x64 | Microsoft x64 ABI (4 int regs, 4 float regs) |
| `c` | Linux, macOS | System V AMD64 ABI (6 int regs, 8 float regs) |
| `system` | Cross-platform | Resolves to platform native convention |

## 4. Data Layout

The `dataLayout` field uses the LLVM data layout string format:

```
e-m:w-ll8-16-32-64-i64p64-32:32:32-i64p64-64:64:64-i64p64-128-i128-n8:16:32:64
```

Breakdown for Windows x64:
- `e` = little endian
- `m:w` = mangling for COFF/Windows
- `i64:64:64` = 64-bit integers with 64-bit alignment
- `n8:16:32:64` = supported native widths

## 5. Toolchain Detection

The `checkToolchain(target)` function reports independent categories:
- LLVM compiler tools (`llc` or `clang`)
- LLVM verifier (`llvm-as` or `llc` parser)
- LLVM linker (`lld`, `lld-link`)
- MSVC (`cl.exe`, `link.exe`)
- Windows SDK import libraries (`kernel32.lib`)

Returns a `ToolchainStatus` with `available`, categorized detection flags, and
discovered tool/library paths. On the current machine clang, lld-link, MSVC,
and the Windows SDK/CRT are detected; llc and llvm-as are optional and absent.

When the toolchain is missing, `nova build` reports a clear diagnostic:
```
NOVA1001 Native toolchain unavailable
Target: x86_64-pc-windows-msvc
Missing: llc, llvm-as (optional)
Detected: LLVM clang: YES, lld-link: YES, Windows SDK: YES, MSVC: YES

Native compilation cannot continue.
```

## 6. Adding a New Target

1. Add the target spec to `TARGETS` in `target.ts`.
2. Define ABI rules in `abi.ts` (if different from existing).
3. Define calling convention and data layout.
4. Add platform-specific runtime and linker integration.

## 7. Relationship to MIR

The target is **not** visible to MIR. MIR remains backend-agnostic. The target
abstraction is used **after** MIR, during the MIR → LLVM IR lowering step (M5).

This ensures:
- MIR is always portable across targets
- Only the final codegen step is target-specific
- Golden tests for MIR layout work on any platform