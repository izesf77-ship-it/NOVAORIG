# MIR Format Specification

MIR (Mid-level Intermediate Representation) is the backend-agnostic layer
between HIR and all backends (reference interpreter, JS backend, future
native/LLVM backend).

## Pipeline

```
NOVA source
  -> parse -> resolve -> typecheck
  -> HIR (hir_lower)
  -> MIR (mir_lower)
  -> verify (mir_verify)
  -> backend (MIR interpreter / native / JS)
```

## Design principles

- **Typed.** Every value and instruction carries a `HirType`.
- **Explicit control flow.** A function is a `MirBlock[]`; control transfers
  ONLY through a block's single `terminator`. There is no implicit
  fall-through.
- **Exactly one terminator per block** (`jump` / `branch` / `return` /
  `unreachable`), always last.
- **Deterministic.** Stable declaration/instruction ordering produces
  byte-identical text/JSON output across compilations.
- **Backend-independent.** No JavaScript- or LLVM-specific constructs.
- **SSA-ready.** Named local slots are the input a future `mem2reg` pass
  converts into SSA with phi nodes. Phi/block-argument support is reserved
  (block params exist in the type but are unused in M3).

## JSON schema

Top-level:

```json
{
  "name": "module name",
  "imports": ["..."],
  "decls": [ <MirDecl> ]
}
```

### Declarations (`MirDecl`)

| kind          | fields                                              |
|---------------|-----------------------------------------------------|
| `fn`          | name, typeParams, params[], ret, blocks[]           |
| `closure_fn`  | name, params[], ret, captured[], blocks[]           |
| `struct`      | name, typeParams, fields[]                          |
| `enum`        | name, typeParams, variants[]                        |
| `const`       | name, type, value                                   |

### Block

```json
{
  "label": "abs.entry.0",
  "params": [{ "name": "n", "type": "Int" }],
  "instrs": [ <MirInstr> ],
  "term": <MirTerm>
}
```

### Instructions (`MirInstr`)

| kind           | fields                           |
|----------------|----------------------------------|
| `assign`       | name, type, value                |
| `store_field`  | obj, name, value                 |
| `store_index`  | obj, index, value                |

### Terminators (`MirTerm`)

| kind            | fields                              |
|-----------------|-------------------------------------|
| `jump`          | target                              |
| `branch`        | cond, thenLabel, elseLabel          |
| `return`        | value?                              |
| `unreachable`    | —                                  |

### Values (`MirValue`)

`lit`, `ref`, `bin`, `unary`, `call`, `field`, `index`, `struct_lit`,
`array_lit`, `map_lit`, `enum_lit`, `closure_ref`, `intrinsic`.

Types are rendered as strings via `mirTypeString` (e.g. `Int`,
`Array<Int>`, `Int?`, `Result<Int, String>`). Spans are stripped.

## Text format ( `nova dump-mir` )

```
; MIR module 'main'
enum Color { Red, Green, Blue }
fn abs(n: Int) -> Int {
abs.entry.0(n: Int):
    __t0: Bool = (n < 0)
    branch __t0, ife.then.1, ife.else.3
ife.then.1:
    __t1: Int = (-n)
    return __t1
...
}
```

## Intrinsics

Option/Result tag inspection and unwinding are single `intrinsic` value
kinds (backend-agnostic):

- `is_some`, `is_none` — Bool tag test
- `is_ok`, `is_err` — Bool tag test
- `unwrap_some`, `unwrap_ok`, `unwrap_err` — payload extraction

## CLI

| command                 | purpose                                  |
|-------------------------|------------------------------------------|
| `nova dump-mir f.nova`  | text MIR (add `--json` for JSON)         |
| `nova check-mir f.nova` | verify MIR, report errors (`--json`)      |
| `nova run-mir f.nova`   | run on reference MIR interpreter         |

## Verifier guarantees

`verifyMirModule` checks: unique block labels, valid terminator targets,
exactly one terminator per block, locals defined before use (CFG fixpoint),
type consistency (arithmetic, branches, returns, call arity, intrinsics),
and that only the entry block declares params.
