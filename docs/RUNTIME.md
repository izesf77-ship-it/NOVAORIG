# NOVA Native Runtime

**Last updated:** 2026-09-06
**Status:** M5 — minimal native LLVM-IR runtime implemented for Windows x64

---

## 1. Overview

The NOVA runtime supports native executables. The current Windows x64 runtime
is emitted directly as LLVM IR and linked into the PE executable. It provides
native string output, signed integer output, Bool output, panic handling, and
array allocation/indexing.

The runtime is **statically linked** into the final executable. No Node.js or
TypeScript runtime is required for execution.

## 2. Implementation Language

**Language: LLVM IR**

Rationale:
- It is consumed directly by the LLVM backend.
- It avoids a JavaScript, Node.js, or C compiler runtime dependency.
- Windows API calls remain explicit and auditable in generated LLVM IR.

## 3. Runtime ABI

The runtime exposes a set of C functions that NOVA code calls via LLVM IR intrinsics.

### 3.1 Memory Management

```text
// Allocate `size` bytes, aligned to `align`.
nova_alloc: not implemented yet

// Free memory previously allocated with nova_alloc.
nova_free: not implemented yet
```

### 3.2 Strings

```text
String representation: { i8*, i64 }

nova_print(i8*, i64)
nova_println(i8*, i64)
nova_print_int(i64)
nova_println_int(i64)
nova_print_bool(i8)
nova_println_bool(i8)

// Get string length in bytes.
len(String) -> i64
```

### 3.3 Arrays

```text
Array representation: { i8*, i64 }

nova_array_new(i64, i64) -> i8*
nova_array_get(i8*, i64, i64, i64) -> i8*
```

### 3.4 Maps

```text
// Create a new map.
struct NovaMap nova_map_new(void);

// Set a key-value pair.
void nova_map_set(struct NovaMap map, int64_t key, int64_t value);

// Get a value by key.
int64_t nova_map_get(struct NovaMap map, int64_t key);

// Get map length.
int64_t nova_map_len(struct NovaMap map);

// Free a map.
void nova_map_free(struct NovaMap map);
```

### 3.5 Panic

```text
// Print an error message and exit.
[[noreturn]] void nova_panic(const char* msg);
```

### 3.6 IO

```c
// Print a string to stdout.
void nova_print(struct NovaString s);

// Print a string + newline to stdout.
void nova_println(struct NovaString s);

// Read a line from stdin.
struct NovaString nova_input(void);
```

## 4. Static Linking

The runtime is emitted into the LLVM module and linked into every NOVA
executable. The tested Windows executable uses `kernel32.lib` and does not
require Node.js, TypeScript, or the NOVA source file.

### Build Pipeline

```
NOVA source
    ↓
MIR
    ↓
LLVM IR (with runtime calls)
    ↓
LLVM → Object code via llc or clang
    ↓
Linker + nova_rt.lib + C runtime
    ↓
Native executable (PE/ELF/Mach-O)
```

## 5. Ownership and Deallocation

- Ownership and destruction are not implemented yet.
- Heap arrays and integer-format buffers are explicitly allocated by the native runtime.
- A future drop pass must define cleanup semantics before automatic destruction is claimed.

## 6. Thread Safety

- Threading and synchronization are not implemented yet.

## 7. Future Considerations

- **Optional GC**: Can add reference counting (RC) for future shared ownership.
- **Arena allocation**: For temporary allocations within a function.
- **Custom allocators**: For user-defined types.