# NOVA — Phase 2 Architecture Audit & Plan

**Date:** 2026-09-05
**Author:** Kilo (automated audit pass)
**Source state:** 12/12 feature tests pass, smoke test passes.
**Working directory:** `C:\Users\admin\Desktop\NOVA`

---

## 1. Repository layout (real)

```
NOVA/
├── bin/nova.ts                # CLI entry (delegates to src/cli/main.ts)
├── nova.cmd                   # Windows launcher
├── package.json               # name nova-lang, scripts: nova=test
├── tsconfig.json              # strict, ES2023, NodeNext, noEmit
├── src/
│   ├── cli/main.ts            # CLI: run/build/check/fmt/ast/test/new/init/repl
│   ├── compiler/
│   │   ├── lexer/{token,lexer}.ts
│   │   ├── parser/parser.ts
│   │   ├── ast/{ast,serialize}.ts
│   │   ├── resolver/resolver.ts        # exists as a stub (only metadata export)
│   │   ├── typechecker/{types,checker}.ts
│   │   ├── diagnostics/diagnostics.ts  # Span, Diagnostic, NovaCompileError, formatter, JSON
│   │   ├── hir/{hir,hir_lower}.ts      # types defined; lowering is broken (see §3)
│   │   ├── mir/mir.ts                  # types defined, no lowering
│   │   ├── backend/backend.ts          # interface defined, not wired
│   │   ├── codegen/{js,prelude}.ts     # direct AST->JS
│   │   └── driver.ts                   # loadProgram, compile, compileSources
│   ├── fmt/formatter.ts
│   └── runtime/interpreter.ts          # AST walker
├── tests/{features,smoke}.ts
├── examples/*.nova                     # 10 example programs
├── docs/{COMPILER_ARCHITECTURE,ARCHITECTURE_AUDIT}.md
├── std/  lsp/  editors/  benchmarks/   # all currently empty directories
└── README.md
```

---

## 2. What's actually working

* **Lexer**: robust, supports `//` line comments, `/* */` block comments, string interpolation with recursive re-lexing, escape sequences, 2-char operators.
* **Parser**: recursive descent. Supports:
  * top-level `fn`, `struct`, `enum`, `const`, `test`, `use`, `type`
  * statements: `if/else`, `while`, `for-in`, `return`, `match`, `break`, `continue`, block, assign (incl. annotated `name: T = ...`)
  * expressions: literals, binary ops with precedence, unary, calls (named & positional args), field/index access, `?` propagate, `ok/error/some/none`, maps, arrays, closures (`|x, y| expr`)
  * generic syntax `<T>` for fn declarations and call sites (`identity<Int>(42)`)
  * generic syntax for `enum MathError { DivisionByZero }` (currently no payload — variant fields exist in AST but parser ignores payload types; see limitations)
  * type expressions: named with generic args, `T?` optional, `fn(...) -> T` function
* **Typechecker**: implements primitive types, arrays, maps, structs, enums, `Option<T>` (via `optional`), `Result<T,E>` (via `result`), nominal types (`type UserId = Int`), generic function **declaration** (type params recorded) but **no instantiation** at call sites (the `generic` AST expr is handled but with limitations — see §3).
* **Pattern matching**: `match` accepts path patterns (`Shape.Circle`), binding, wildcard, literal. Exhaustivity checking is **partial** — only structurally checks enum subject + presence of all variants; doesn't track wildcard.
* **Interpreter**: tree-walk, tagged runtime values (`{tag, ...}`), full native function set, propagates errors via `ReturnSignal`.
* **JS codegen**: emits standalone ESM with prelude; emits same tagged-value runtime. Native fns mapped to prelude helpers.
* **Formatter**: deterministic, two-space indent, one stmt per line, supports all decl/stmt kinds.
* **CLI**: `run`, `build`, `check --json`, `fmt --check`, `ast --json`, `test`, `new`, `init`, `repl`, `version`, `help`.
* **Diagnostics**: codes (`NOVA<phase><num>`), spans, severity, `help`, notes, rust-style pretty output, JSON serialization (`diagnosticsToJson`).
* **Modules**: file-level `use "..."` resolved transitively from disk (`loadProgram`) and in-memory (`compileSources`).

---

## 3. Architectural problems (real, ordered by severity)

### 3.1 CRITICAL — HIR/MIR are not in the pipeline
`hir_lower.ts` contains a half-finished lowering that:
* references AST fields that don't exist (`stmt.annot` on `let`/`block`, `tailExpr` on HIR `block`, kind `bind` instead of `let`, etc.);
* uses `as any` everywhere because the AST `Stmt` union is wider than what HIR `Stmt` accepts;
* has a dead `inferExprType` fallback that is never reached in practice.

`mir/mir.ts` has definitions only — no lowering function. `backend.ts` interface exists but no implementation uses it.

**Fix:** Rebuild HIR lowering to match the **real** AST shape; produce a HIR that the interpreter and JS codegen can consume. Defer MIR to a minimal structural form (basic blocks) only after HIR is wired and stable.

### 3.2 CRITICAL — Typechecker does name resolution
The `Checker` (1016 lines) interleaves scope tracking, name resolution, and type checking. The `Resolver` exists as a stub that only republishes already-resolved info. There is no independent "use-before-define" pass.

**Fix:** Extract a `Resolver` phase that builds scope trees and resolves every `IdentExpr` to a binding. The checker then consumes the resolved AST. *This phase will be split incrementally — the Phase 2 first milestone makes the resolver a **read-only indexer** for tooling, then the checker will be refactored to consume resolved scopes without rewriting the checker from scratch.*

### 3.3 HIGH — JS codegen is tightly coupled to AST
`codegen/js.ts` re-implements every AST node. There is no HIR intermediate. This blocks any non-JS backend.

**Fix:** Move the codegen to consume HIR. The interpreter is also coupled to AST; it will consume HIR once HIR is stable. The legacy AST-direct codegen stays as `legacyJs.ts` referenced by the bootstrap backend so existing tests keep passing while HIR is wired.

### 3.4 HIGH — Interpreter is tightly coupled to AST
`runtime/interpreter.ts` imports `ast.ts` directly. No easy way to switch value representation (e.g., tagged object vs. tuple).

**Fix:** Build a `HirInterpreter` that consumes HIR and shares a small `Value` model with the JS backend prelude.

### 3.5 MEDIUM — Type system gaps
* Generic instantiation is partial (call sites with explicit args work, type-param inference at call sites without args does not).
* Enum variants currently have **no payload types supported in source** (the parser ignores payload syntax — `Shape.Circle(r)` inside an enum declaration fails to parse). Only `Color { Red Green Blue }` works.
* No exhaustivity for `Option<T>` and `Result<T,E>` in match.
* `T?` in `TypeExpr` produces `{kind:'optional'}` but is identical to `Option<T>`; the typechecker uses `optional` everywhere; no separate representation.

### 3.6 MEDIUM — Parser limitations
* No `async fn`, no `await` keywords.
* No `pub` semantics — keyword is parsed but `exported` flag never propagates to module exports.
* `match` arms with multiple bindings or guard expressions not supported.
* Generic call sites need `<T>` explicitly typed (no inference at call site).
* No `#[...]` attributes, no doc comments.

### 3.7 MEDIUM — Runtime limitations
* No async/await model.
* Native functions are global; no namespace, no registration mechanism.
* Map keys must be strings (literal or string-coercible).
* No stdlib structure.

### 3.8 LOW — Project system
`nova new` creates only `nova.toml` + `src/main.nova`. No `tests/`, no README, no `.gitignore`. No project root discovery (commands always take explicit files).

---

## 4. Target pipeline (Phase 2 final shape)

```
Source (.nova)
   ↓
Lexer ─────────────► Token[]
   ↓
Parser ────────────► AST (untyped, span-annotated)
   ↓
Resolver ──────────► AST' (IdentExpr → ResolvedBinding)
   ↓
TypeChecker ───────► AST' + symbol tables + ExprTypeMap
   ↓
HirLowering ───────► HirModule (typed, backend-agnostic)
   ↓
MirLowering ───────► MirModule (basic blocks, SSA-locals) — minimal
   ↓
┌─────────────────────────────────────────────────────┐
│ Backend                                             │
│  ├── JsBackend        → standalone ESM              │
│  ├── HirInterpreter   → runs HIR directly           │
│  └── NativeBackend    → LLVM IR (future)            │
└─────────────────────────────────────────────────────┘
```

The Phase 2 milestone does not require the entire chain to be live. Concretely:

* **M1 (this pass):** HIR is real, lowering matches the AST, JS codegen **and** interpreter both consume HIR. Legacy AST codegen remains as a fallback for tests until parity is proven.
* **M2:** Resolver becomes an independent pass; TypeChecker reads resolved scopes.
* **M3:** Minimal MIR (basic blocks + branch/jump), behind a `--mir` flag for tooling.
* **M4:** Backend interface is the only public API used by `cmdRun`/`cmdBuild`.

---

## 5. Phase 2 — concrete milestone plan

The Phase 2 spec contains 24 sub-phases. They are grouped into 10 engineering milestones so that each milestone is independently mergeable and every milestone ends with a green test run.

| # | Milestone | Sub-phases | Verification |
|---|---|---|---|
| M1 | Real HIR + HIR-driven backends | 2.1, 2.2, 2.3, 2.10 (smoke) | features + smoke pass; new HIR tests |
| M2 | Resolver as independent pass | 2.1 (cont.) | LSP-style `nova symbols` works |
| M3 | Type system expansion | 2.4, 2.5, 2.6, 2.7 | new type tests pass; existing tests unchanged |
| M4 | Pattern matching diagnostics + exhaustivity | 2.8, 2.9 | golden diag tests |
| M5 | Test/golden suites | 2.10, 2.11 | 50+ tests; golden dir created |
| M6 | Formatter + Linter | 2.12, 2.13 | `nova fmt --check`, `nova lint` |
| M7 | Project system + package manager | 2.14, 2.15 | `nova new` scaffolds full layout |
| M8 | Stdlib structure + async + concurrency | 2.16, 2.17, 2.18 | doc + std/ layout |
| M9 | AI-native tooling + LSP | 2.19, 2.20 | `nova ast --json`, `nova symbols --json`, etc. |
| M10 | Native backend arch + benchmarks + README | 2.21, 2.22, 2.23, 2.24 | docs + benchmarks dir |

### Architectural rules (binding for every milestone)

1. **Never delete** the existing AST→JS codegen until the HIR-driven path produces **byte-identical** output for the existing examples.
2. **Never** assume JavaScript semantics in the frontend. `backend/backend.ts` is the only place that may import from `runtime/` or `codegen/`.
3. **Never** introduce a `TODO` for behavior. If a feature is documented, it must work end-to-end or it must be removed from docs.
4. **Never** accept a `// @ts-expect-error` or `as any` in production code paths.
5. **Always** add a regression test for every bug fix.
6. **Always** keep files under ~500 lines; refactor early.

---

## 6. What this audit does NOT change (deliberate)

* The runtime value representation stays tagged objects in M1. A future M11 may add an unboxed representation, but only after the type system is closed.
* The `?` propagation semantics: `null`/`err` of a `Result` propagates by throwing a control-flow signal in the interpreter and via `try/catch` in the JS backend. This is preserved.
* The lexer/parser combo: no grammar extensions in Phase 2.1 except adding `async`/`await` keywords (M8).
* The CLI surface is preserved. New commands are **additive**.

---

## 7. Immediate next step (this pass)

Execute **M1** end to end:

1. Rewrite `src/compiler/hir/hir_lower.ts` against the real AST.
2. Add `src/compiler/hir/hir_interp.ts` — a HIR-driven interpreter.
3. Refactor `src/compiler/codegen/js.ts` to consume HIR (keep a small adapter for structs/maps for now).
4. Wire `compile()` in `driver.ts` to optionally return a HIR module.
5. Add `tests/hir.test.ts` with 6 cases: literals, calls, if/match, struct, generic call, nested closure.

After M1 is green, the project is ready to evolve in M2–M10 without rewrite.