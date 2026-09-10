# NOVA Native ABI

**Last updated:** 2026-09-06
**Status:** M4 — Target definition, ABI, layout, toolchain abstraction

---

## 1. Overview

This document defines the native ABI (Application Binary Interface) for the NOVA
programming language. It describes how NOVA types are represented in memory and
function signatures at the boundary between compiled code and native execution.

The ABI is **backend-independent** — it is the contract between MIR, the LLVM
backend, and the native runtime. Currently, `x86_64-pc-windows-msvc` is the only
implemented target. Future targets (Linux, macOS, ARM64) will reuse the same ABI
principles with platform-specific adjustments.

## 2. Current Target

```
Target: x86_64-pc-windows-msvc
Architecture: x86_64
OS: Windows
Object format: COFF
Pointer width: 64-bit
Endianness: little
Calling convention: Windows x64
Stack alignment: 16-byte
Max alignment: 16-byte (SIMD-friendly)
```

## 3. Primitive Types

| NOVA Type | Native Type | Size | Alignment | Ownership | ParamCC |
|-----------|------------|------|-----------|-----------|---------|
| `Int`    | `i64`    | 8 | 8 | value | in_register |
| `Float`  | `f64`    | 8 | 8 | value | in_register |
| `Bool`   | `i8`     | 1 | 1 | value | in_register |
| `String` | `{ i8*, i64 }` (ptr+len) | 16 | 8 | boxed | by_reference |
| `Null`   | `i8` (zero-sized) | 0 | 1 | value | in_register |
| `Void`   | void     | 0 | 1 | value | in_register |

### Notes

- **Int**: 64-bit signed integer (`i64`). This is the canonical integer type.
- **Float**: 64-bit IEEE 754 floating point (`f64`).
- **Bool**: Stored as `i8` (0 = false, 1 = true). Passed in register.
- **String**: A fat pointer `{ptr: *const u8, len: u64}`. The pointer is
  heap-allocated UTF-8 data. NULL-terminated for C interop.
- **Null**: Zero-sized value. Type-checks as any optional.
- **Void**: Zero-sized. Only used as return type for no-return functions.

## 4. Aggregate Types

### 4.1 Structs

Structs use LLVM-style layout: fields at aligned offsets, padding inserted,
total size rounded up to struct alignment. Passed by reference at ABI boundary.

```nova
struct Point { x: Int, y: Int }  // Size: 16, Align: 8
```

### 4.2 Arrays

Arrays are a fat pointer `{ptr, len, capacity}`:
```
struct NovaArray { ptr: *mut u8, len: u64, cap: u64 }
```
Heap-allocated, bounds-checked, ownership: boxed.

### 4.3 Maps

Maps are an opaque boxed pointer to a hash table:
```
struct NovaMap { ptr: *mut u8, len: u64 }
```

### 4.4 Enums

All NOVA enums currently have unit variants only. Discriminant is `i64`.
Size: 8 bytes, alignment: 8. Passed in register.

For future payload-carrying variants:
```
struct EnumValue { discriminant: i64, payload: <union> }
```

### 4.5 Option<T>

**For pointer-sized types (String, Array, Map, pointer):**
- `None` = null pointer (0). `Some(x)` = pointer value `x`.
- Size: 8, Align: 8, paramCC: in_register.

**For value types (Int, Float):**
- Layout: `{ payload: T, discriminant: i8 }`.
- Size: aligned(payload_size + 1, 8).

### 4.6 Result<T, E>

Tagged layout:
```
struct NovaResult {
    payload: { i64 }              // union of T | E (largest wins)
    discriminant: i64             // 0 = Ok, 1 = Err
}
```
Passed by reference (`by_reference`).

### 4.7 Functions and Closures

**Function pointers:** opaque `ptr` (8 bytes), `in_register`, borrowed reference.

**Closures (current MIR):** closure-converted to function references.
Captured variables become leading parameters of synthetic functions.

**Future closure ABI:**
```
struct NovaClosure { fn_ptr: *const u8, env: *mut u8 }
```
Size: 16, Align: 8.

## 5. Memory Model

- **Stack**: 16-byte aligned automatic storage for locals.
- **Heap**: Dynamic allocation via `nova_alloc`/`nova_free`.

### Ownership

- Each value has a single owner.
- When owner goes out of scope, value is dropped.
- Ownership can be transferred (move semantics).
- No implicit copying of boxed types.

### Deallocation

- Stack values: deallocated when scope ends.
- Heap values (String, Array, Map): deallocated via runtime.

### Lifetime Rules

- References cannot outlive their owner (enforced by future borrow checker).

## 6. Calling Convention

Windows x64 calling convention:
- Integer args (≤4): RCX, RDX, R8, R9
- Float args (≤4): XMM0-XMM3
- Extra args: stack (right-to-left)
- Return: RAX/XMM0, or hidden pointer for large structs
- Stack alignment: 16-byte before call
- Callee-saved: RBX, RBP, RSI, RDI, R12-R15

## 7. C FFI

Foreign calls use `extern "C"`:
- Parameters: C ABI rules
- Strings: `{ i8*, i64 }` (NULL-terminated)
- Full C FFI: deferred to M5

## 8. Alignment Rules

1. Preferred alignment = size (power of 2).
2. Struct alignment = max(field alignments).
3. Struct size = rounded up to struct alignment.
4. Array alignment = element alignment.
5. Pointer alignment = 8 bytes on x64.

## 9. Determinism

All layout computations are deterministic. Golden tests verify exact offsets.

## 10. Future Considerations

- Generics: monomorphization creates target-specific layouts.
- SIMD: 16-byte alignable types.
- GC: optional RC (decision pending).
- Packed structs: future `#[repr(packed)]`.

## 11. Runtime ABI

The NOVA runtime provides memory management, string operations, array/map
operations, and panic handling. Implementation language: **C** (for static
linking). Runtime is statically linked into the final executable.

## 12. Decision Log

| Decision | Date | Rationale |
|----------|------|-----------|
| Int = i64 | 2026-09-06 | Canonical 64-bit, matches NOVA semantics |
| Float = f64 | 2026-09-06 | Double precision matches NOVA's Float |
| Bool = i8 | 2026-09-06 | Smallest addressable type |
| String = {ptr, len} | 2026-09-06 | Fat pointer, C interop friendly |
| Option<T> = nullable ptr | 2026-09-06 | Zero-cost for pointer types |
| Result<T,E> = tagged struct | 2026-09-06 | Deterministic, easy construct/destruct |
| Enum = i64 discriminant | 2026-09-06 | Simple, extensible |
| Closure = fn ptr | 2026-09-06 | MIR closure-converts; ABI is just ptr |
| Ownership = simple move | 2026-09-06 | No GC complexity; RC addable later |