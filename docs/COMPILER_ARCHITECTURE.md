# NOVA Compiler Architecture — Phase 2

**Last updated:** 2026-09-06
**Status:** Phase 2 — turning the prototype into a real language toolchain.

---

## 1. Pipeline (target)

```
Source (.nova)
    ↓
Lexer            (src/compiler/lexer/)
    ↓
Parser           (src/compiler/parser/)
    ↓
AST              (src/compiler/ast/)         — JSON-serializable, span-tagged
    ↓
Resolver         (src/compiler/resolver/)    — name → declaration
    ↓
TypeChecker      (src/compiler/typechecker/) — infers types, fills ExprTypeMap
    ↓
HIR              (src/compiler/hir/)         — typed, backend-agnostic
    ↓
MIR              (src/compiler/mir/)         — basic blocks (M3+)
    ↓
Target ABI       (src/compiler/target/)      — native layout (M4)
    │                ├── target.ts — TargetSpec (triple, arch, OS, ...)
    │                ├── abi.ts    — AbiMapper (type → native repr)
    │                └── layout.ts — field offsets, size/align computation
    ▼
┌────────────────────────────────────────────────┐
│ Backend                                        │
│  ├── JsBackend       → ESM (bootstrap)         │
│  ├── HirInterpreter  → runs HIR directly       │
│  └── NativeBackend   → LLVM IR → Object → PE   │
│        (consumes Target ABI for codegen)       │
└────────────────────────────────────────────────┘
    │
    ▼
Runtime ABI      (src/compiler/backend/llvm/) — native LLVM-IR runtime
  │                ├── print/println, panic, arrays
  ▼
Static Linking + Windows SDK kernel32 imports
    ↓
Windows PE executable
```

The JavaScript backend is **not** deleted. It is the bootstrap backend that
keeps examples running while the rest of the chain is being built. The
frontend is not allowed to assume JavaScript semantics anywhere.

---

## 2. Lexer — `src/compiler/lexer/`

* `token.ts` — token kinds, `Span2`, `StringPart`, `KEYWORDS`.
* `lexer.ts` — emits a token stream, supports `//` and `/* */` comments,
  string interpolation (`"hello {name}"` — recursive re-lex), escape sequences.
* Errors are reported as `NOVA1xxx` diagnostics and accumulate.

## 3. Parser — `src/compiler/parser/parser.ts`

* Recursive descent, newline-sensitive (newlines terminate statements).
* Produces a `Program` of `Decl | Stmt` (`TopLevelNode`).
* Supports `fn`, `struct`, `enum`, `const`, `test`, `use`, `type`, plus
  statements and expressions listed in `src/compiler/ast/ast.ts`.
* Recovery: when a declaration fails, parser synchronises to the next newline.

## 4. AST — `src/compiler/ast/`

* `ast.ts` — node types. Every node has a `span`.
* `serialize.ts` — JSON serializer for `nova ast --json`.

## 5. Resolver — `src/compiler/resolver/resolver.ts`

* Walks the AST and produces a `ResolvedSymbols` (currently used by tooling).
* Will become a real name-resolution pass: scopes, use-before-define,
  module imports. (M2)

## 6. TypeChecker — `src/compiler/typechecker/`

* `types.ts` — `NovaType` union (`prim | struct | enum | array | map | optional
  | result | fn | void | nominal | generic | var | unknown`),
  `isAssignable`, `typeToString`, `typeToJson`.
* `checker.ts` — runs `collectDecls` then `checkBodies`. Reports diagnostics
  with stable codes (`NOVA3xxx` name resolution, `NOVA4xxx` types).

### Supported now

* Primitives: `Int`, `Float`, `String`, `Bool`, `Null`, `Void`.
* Structs, enums (unit variants), arrays, maps.
* `Option<T>` (encoded as `optional`), `Result<T,E>` (encoded as `result`).
* `type UserId = Int` (nominal types; checked structurally with distinct
  identity).
* Generic `fn` declarations with explicit call-site args
  (`identity<Int>(42)`).

### Limitations (tracked)

* Generic call-site **inference** for arguments is partial.
* Enum variant payloads (e.g. `Shape::Circle(radius: Float)`) are not yet
  parsed from source.
* Exhaustivity checking does not cover `Option`/`Result` — only enums.

## 7. HIR — `src/compiler/hir/`  *(stable boundary)*

The HIR is the **stable interface** between the typed frontend and every
backend. The frontend emits exactly one HIR module per compilation; backends
(native, JS, interpreter) never touch the AST directly.

### Invariants (enforced & tested)

* **Typed.** Every `HirExpr` carries a `type: HirType`.
* **Backend-agnostic.** No JS value representation (`tag`-discriminated objects,
  `process.*`, `Buffer`, etc.) appears in HIR or its type system.
* **Sugar-free.** All syntactic sugar from the AST is desugared: there are no
  raw `StringPart` interpolation nodes — interpolated strings lower to nested
  `+` concatenations; trailing `if`/`match`/`expr` statements in a block lower
  to a `tail` expression (see below).
* **Unambiguous `kind`.** Every node's `kind` discriminator uniquely identifies
  the node variant. Statement-level `if` is `HirIfStmt.kind === 'if'`;
  tail-position / value-producing `if` is `HirIfExpr.kind === 'if_expr'`. They
  must never share a tag.
* **Block tail is explicit.** A `HirBlockExpr` (and `HirBlockStmt`) separates
  its `stmts: HirStmt[]` from an optional tail `expr: HirExpr | undefined`.
  There is exactly one tail; a trailing expression statement is *not* a stmt.
* **Bindings distinguish declaration and mutation.**
  `HirLetStmt.kind === 'let'` introduces a binding (checked against
  `AssignStmt.isDeclaration`); a re-assignment to an existing local is
  `HirAssignStmt.kind === 'assign'`. This preserves mutability for the native
  backend and prevents re-binding a `let` as a mutation.
* **Source locations preserved.** Every HIR node keeps a `span` for diagnostics
  that maps back to the originating `.nova` source.

### `hir.ts` — the type schema

`HirType` mirrors `NovaType` minus the inference poison `unknown`/`generic`
(residual nominal info is kept as `{kind:'nominal', name, inner}`).

`HirExpr` covers: literals, idents (local/global/fn), binary, unary, calls
(named args), field/index, array/map literals, block, `if_expr`, `match`,
`return`, `?`-propagation, `ok`/`error`/`some`/`none`, `assign` (expr form),
and `closure`.

`HirStmt` covers: `expr`, `let`, `assign`, `field_assign`, `index_assign`,
`block`, `if`, `while`, `for`, `return`, `match`, `break`, `continue`.

`HirDecl` covers: `fn`, `struct`, `enum`, `const`, `nominal`.

`HirPattern` covers: `wildcard`, `binding`, `path` (enum.variant), `literal`,
`some`/`none`/`ok`/`err` for `Option`/`Result`.

`hirTypeToString`, `isHirNumeric`, `isHirOptional`, `isHirResult` are pure
helpers used by backends and the serializer.

### `hir_lower.ts` — AST → HIR

`astToHir(programs, symbols, exprTypes) -> HirModule` is a pure function: it
runs once the checker has finished, takes the typed AST + symbol tables +
`ExprTypeMap`, and returns a single backend-agnostic module. Lowering never
mutates the AST.

### `hir_serialize.ts` — debugging & golden tests

`hirToJson` / `hirToString` render HIR for `nova dump-hir` and the golden test
suite. `hirToJson` strips spans for stable comparisons; `hirToString` is the
human-friendly form.

### Verification

`tests/hir.test.ts` (9 cases) runs full programs through HIR + the HIR
interpreter. `tests/hir_golden.test.ts` (5 cases) checks structural invariants
(tail promotion, let/assign, interpolation-lowering, match shape) and a golden
fixture in `tests/hir_fixtures/`.

## 8. MIR — `src/compiler/mir/`  *(live since M3)*

MIR is the **basic-block, explicit-control-flow** layer produced from HIR and
consumed by every backend. It is the NOVA analogue of LLVM IR *before*
`mem2reg`.

### Design

* `mir.ts` — type schema: `MirModule`, `MirDecl` (`fn`, `closure_fn`, `struct`, `enum`, `const`), `MirBlock`, `MirInstr`, `MirTerm`, `MirValue`.
* `mir_lower.ts` — `HIR → MIR` lowering. Total and deterministic. Every HIR
  expression lowers to a `MirValue`; complex expressions bind a fresh temp via
  `assign`. Control flow lowers to explicit `jump`/`branch`/`return`/`unreachable`
  terminators — there is no implicit fall-through.
* `mir_verify.ts` — static verifier (`verifyMirModule`): unique block labels,
  valid terminator targets, exactly one terminator per block, locals defined
  before use (CFG fixpoint), type consistency, call arity, intrinsic shapes.
* `mir_serialize.ts` — `mirToJson` (deterministic, spans stripped) /
  `mirToString` (LLVM-flavoured text).
* `mir_interp.ts` — reference MIR interpreter. Semantic reference for the
  native backend later.

### Invariants

* **Typed.** Every value/instruction carries a `HirType`.
* **One terminator per block**, always last, stored in `MirBlock.term`.
* **Block params reserved** for future SSA/`mem2reg` (unused in M3: only the
  entry block may declare params).
* **Match → control flow.** `match` is lowered to a discriminant-test +
  branch cascade; it is NOT a MIR instruction.
* **Closures closure-converted.** Captured variables become leading params of a
  synthetic `closure_fn`; the closure value is a function reference + captures.
* **Option/Result** use `intrinsic` tag tests (`is_some`/`is_ok`) + unwrap, so
  they stay backend-agnostic.

### CLI

`nova dump-mir f.nova` (text), `nova dump-mir f.nova --json` (JSON),
`nova check-mir f.nova` (verify), `nova run-mir f.nova` (reference interpreter).

See `docs/MIR_FORMAT.md` for the full JSON schema.

## 9. Backend — `src/compiler/backend/backend.ts`

```typescript
interface Backend {
  generate(hir: HirModule, symbols: SymbolTables): { code: string; diagnostics: Diagnostic[] };
  run(hir: HirModule, symbols: SymbolTables): RunResult;
}
```

Backends consume **HIR**, never the AST. (The legacy JS generator in
`codegen/js.ts` currently reads the AST directly as a **bootstrap-only**
shortcut; it is the dev backend and will be re-pointed at HIR or replaced by
the native backend. `nova run` uses the HIR interpreter.)

## 10. Runtime — `src/runtime/`

* `interpreter.ts` — the **AST** interpreter kept temporarily for the bootstrap
  path. Will be removed once the HIR interpreter reaches parity.
* `hir_interp.ts` — HIR-driven interpreter (M1).
* `value.ts` — shared `Value` model used by both interpreters and JS prelude.

## 11. Standard library — `std/`

The `std/` directory is intentionally **empty for now** (M8 will populate it).
Globals (`print`, `len`, `range`, …) continue to be installed by the
interpreter/prelude so existing programs keep working.

## 12. AI-native tooling

Every CLI subcommand accepts `--json` and emits a documented schema:

* `nova ast --json` — full AST (from `ast/serialize.ts`).
* `nova symbols --json` — resolved symbol table (M2).
* `nova types --json` — `ExprTypeMap` dump (M2).
* `nova diagnostics --json` — already supported on `nova check`.
* `nova dependencies --json` — module graph (M9).

## 13. CLI — `src/cli/main.ts`

| Command | Backend | Output |
|---|---|---|
| `nova run <file>` | HirInterpreter | stdout, exit code |
| `nova build <file>` | JsBackend | `dist/<name>.mjs` |
| `nova check <file> [--json]` | TypeChecker only | diagnostics |
| `nova fmt <file> [--check]` | Formatter | rewrites or exit code |
| `nova ast <file> --json` | — | JSON AST |
| `nova test [dir]` | HirInterpreter | pass/fail summary |
| `nova new <name>` / `nova init` | — | scaffold |
| `nova repl` | HirInterpreter | interactive |
| `nova symbols --json` | Resolver | JSON symbols (M2+) |
| `nova types --json` | TypeChecker | JSON ExprTypeMap (M2+) |
| `nova lint <file>` | Linter | diagnostics (M6) |
| `nova dump-hir <file> [--json]` | — | HIR dump (M1+) |
| `nova dump-mir <file> [--json]` | — | MIR dump (M3+) |
| `nova check-mir <file> [--json]` | — | MIR verification (M3+) |
| `nova run-mir <file>` | MIR interpreter | stdout, exit code (M3+) |

---

## 14. Design decisions

* **Tagged runtime values.** NOVA `Option<T>`, `Result<T,E>`, struct, enum,
  array, map all map to plain JS objects with a `tag` discriminator. This is
  the same representation in both the JS backend prelude and the interpreter.
  **Native ABI** (M4) defines a separate native representation — see
  `docs/NATIVE_ABI.md`. The two representations are **never mixed** in the
  compiler pipeline. Native values live downstream of the Target ABI layer.
* **Nominal types.** `type UserId = Int` is `nominal`, not `prim` — preventing
  implicit conversion between two newtypes that share the same inner type.
* **Tagged `Stmt` vs `Expr`.** Statements are not expressions in HIR; HIR
  blocks separate statements from a tail expression explicitly.
* **No `JS`-specific constructs in AST/HIR.** Tagged-value emission is the
  backend's job.

## 15. Roadmap status (Phase 2)

* [x] 2.1 — Clean compiler architecture doc (this file)
* [x] 2.2 — HIR types defined
* [x] 2.2 — HIR lowering live (M1): `.nova → AST → HIR` with structural + golden tests
* [x] 2.3 — MIR lowering live (M3): `HIR → MIR` basic-block lowering + verifier + reference interpreter
* [ ] 2.4–2.7 — generics, Option/Result, propagation (M3)
* [ ] 2.4–2.7 — generics, Option/Result, propagation (M3)
* [ ] 2.8–2.9 — pattern matching diagnostics (M4)
* [ ] 2.10–2.11 — test/golden suites (M5)
* [ ] 2.12–2.13 — formatter, linter (M6)
* [ ] 2.14–2.15 — project system, package manager (M7)
* [ ] 2.16 — stdlib structure (M8)
* [ ] 2.17–2.18 — async/await + concurrency doc (M8)
* [ ] 2.19 — AI-native tooling (M9)
* [ ] 2.20 — LSP + VS Code extension (M9)
* [ ] 2.21 — native backend arch (M10)
* [ ] 2.22 — benchmarks (M10)
* [ ] 2.23 — README honest update (M10)
* [ ] 2.24 — architectural rules enforced