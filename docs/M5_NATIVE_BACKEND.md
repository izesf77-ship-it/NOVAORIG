# M5 Native Backend

## Pipeline

The native backend consumes verified MIR only:

```text
.nova -> AST -> HIR -> MIR -> Target ABI -> LLVM IR -> COFF object -> PE executable
```

`src/compiler/backend/llvm_backend.ts` keeps the stages separate:

- `lowerMirToLlvm` lowers MIR to real LLVM IR text.
- `emitObject` invokes `llc` when available, otherwise `clang -c -target` for an x86_64 Windows COFF object.
- `linkExecutable` invokes `lld-link` or MSVC `link.exe` for a PE executable.
- `buildNative` orchestrates the stages and can stop at `llvm`, `obj`, or `exe`.

Before object emission, `validateLlvm` invokes `llvm-as` when available, or the
LLVM parser through `llc -filetype=null`; when neither exists, clang validates
the IR as part of the real object compilation. Object output is written to a
temporary path, checked as an AMD64 COFF object, and atomically renamed. Link
output follows the same rule and must begin with the PE `MZ` signature.

The backend never reads AST nodes and never falls back to JavaScript, Node.js, or the NOVA interpreter.

## ABI and Runtime

The LLVM type mapping follows the M4 ABI:

- `Int` -> `i64`
- `Float` -> `double`
- `Bool` -> `i8`
- `String` and arrays -> `{ i8*, i64 }`
- `Void` -> `void`

The minimal runtime is emitted as native LLVM IR in `src/compiler/backend/llvm/llvm_runtime.ts`. It calls only Windows `kernel32` APIs (`WriteFile`, `GetStdHandle`, `HeapAlloc`, and `ExitProcess`) and is linked into the executable. It does not require a JavaScript runtime or the NOVA source file at execution time.

## Commands

```text
nova dump-llvm app.nova
nova build app.nova --native --emit=llvm
nova build app.nova --native --emit=obj
nova build app.nova --native --emit=exe
nova build app.nova --native --release
```

`--release` selects `-O2` for either `llc` or clang. The output is deterministic where the toolchain permits it.

## Status

Implemented: MIR to LLVM IR, target-driven triple/data layout, LLVM/clang
validation, real COFF object generation, ABI lowering for the current M4
representations, safe object emission, PE linking, PE validation, and native
hello execution.

Environment-dependent: LLVM installation and the choice of `llc` versus clang;
the tested machine uses clang plus `lld-link` and Windows SDK libraries.

Verified in this environment: a real PE32+ AMD64 executable and native execution.

## Toolchain policy

Toolchain detection is read-only. NOVA probes `llc`, LLVM/linker locations, Visual Studio linker locations, and Windows SDK import libraries. It does not download or install system components.

When neither `llc` nor clang, a linker, or the SDK libraries are unavailable, object and executable builds fail with `NOVA1001 Native toolchain unavailable`. No placeholder `.obj` or `.exe` is written. LLVM lowering remains available through `dump-llvm` and `--emit=llvm`.

On the current development machine, clang, `lld-link`, MSVC `cl.exe`/`link.exe`, the Windows SDK, `kernel32.lib`, `ucrt.lib`, and `vcruntime.lib` are present. `llc` and `llvm-as` are absent, so clang is selected as the real LLVM-IR object backend.

## Current limitations

The current native lowering coverage is tracked by `tests/llvm/llvm.test.ts`:

- Implemented: Int, Float, Bool, Void, arithmetic, comparisons, local SSA bindings, calls, recursion, if/else, while, for, break, continue, return, struct construction/field reads, unit enums, Option, strings, arrays, and closure-converted calls.
- Explicit gaps: input, process/time/environment/args APIs, filesystem APIs, map operations, struct field mutation, differing-payload `Result` unions, and parts of the higher-level standard library. Signed Int, Bool, and fixed-six-decimal Float `print`/`println` are implemented through the native LLVM runtime. Unsupported features fail with `NOVA2001`; they never emit placeholder instructions.
- Environment-dependent: availability of LLVM object backend and Windows linker/SDK libraries on another machine.

The coverage tests validate lowering text and diagnostics; `tests/native/native.test.ts` builds, validates, runs, and cleans up a real PE when the native toolchain is available.
