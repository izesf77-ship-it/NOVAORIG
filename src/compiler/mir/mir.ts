/**
 * NOVA Mid-level Intermediate Representation (MIR).
 *
 * MIR is the backend-agnostic, optimization-friendly layer produced from HIR
 * and consumed by every backend (reference interpreter, JS backend, future native
 * backend). M3 MIR is a **typed, explicit-control-flow** representation — the
 * NOVA analogue of LLVM IR *before* `mem2reg`:
 *
 *   - **Explicit basic blocks.** A function is a `MirBlock[]`; blocks[0] is the
 *     entry. Control flow transfers ONLY through a block's single `terminator`.
 *   - **Exactly one terminator per block** (`jump` / `branch` / `return` /
 *     `unreachable`), always last. There is no implicit fall-through.
 *   - **Named local slots.** Each definition binds a local by name; uses read
 *     the current binding. This is correct for all control flow (including
 *     loop-carried accumulation) and is the input a future mem2reg pass will
 *     convert into SSA with phi nodes.
 *   - **Typed.** Every value and instruction carries a `HirType`.
 *   - **Deterministic.** Stable ordering → reproducible text/JSON output.
 *
 * `match` is lowered to real control flow (discriminant compare + branches),
 * not kept as a high-level MIR op. Closures are closure-converted: captured
 * variables become leading parameters of a synthetic MIR function, so a
 * closure is just a function reference at the value level.
 *
 * Invariants (enforced by `mir_verify.ts`):
 *   1. Every block has exactly one terminator, as the last element of `instrs`
 *      (the terminator is stored separately as `term`, not in `instrs`).
 *   2. Block labels referenced by terminators and phi are unique and exist in
 *      the same function.
 *   3. Locals are defined before use within the linearized flow of a block.
 *   4. Types are consistent (operands, branches, returns).
 *   5. The entry block has no block-arguments/predecessor edges except the
 *      synthetic call entry.
 */
import type { Span2 } from '../lexer/token.ts';
import type { HirType } from '../hir/hir.ts';

// ----------------------------------------------------------------------------
// Values — pure SSA-able productions. They are always the RHS of an `assign`
// or an operand of some instruction.
// ----------------------------------------------------------------------------

export type MirValue =
  | MirLit
  | MirRef
  | MirBin
  | MirUnary
  | MirCall
  | MirField
  | MirIndex
  | MirStructLit
  | MirArrayLit
  | MirMapLit
  | MirEnumLit
  | MirClosureRef
  | MirIntrinsic;

export interface MirLit {
  kind: 'lit';
  value: number | string | boolean | null;
  type: HirType;
}

export interface MirRef {
  kind: 'ref';
  name: string;
  type: HirType;
}

export interface MirBin {
  kind: 'bin';
  op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
  left: MirValue;
  right: MirValue;
  type: HirType;
}

export interface MirUnary {
  kind: 'unary';
  op: '-' | '!' | 'not';
  expr: MirValue;
  type: HirType;
}

export interface MirCall {
  kind: 'call';
  callee: MirValue;
  args: MirValue[];
  type: HirType;
}

export interface MirField {
  kind: 'field';
  obj: MirValue;
  name: string;
  type: HirType;
}

export interface MirIndex {
  kind: 'index';
  obj: MirValue;
  index: MirValue;
  type: HirType;
}

export interface MirStructLitField {
  name: string;
  value: MirValue;
}

export interface MirStructLit {
  kind: 'struct_lit';
  structName: string;
  fields: MirStructLitField[];
  type: HirType;
}

export interface MirArrayLit {
  kind: 'array_lit';
  elements: MirValue[];
  type: HirType;
}

export interface MirMapEntry {
  key: MirValue;
  value: MirValue;
}

export interface MirMapLit {
  kind: 'map_lit';
  entries: MirMapEntry[];
  type: HirType;
}

export interface MirEnumLit {
  kind: 'enum_lit';
  enumName: string;
  variant: string;
  data?: MirValue;
  type: HirType;
}

/**
 * Reference to a function value (first-class function / closure). Closures are
 * closure-converted during lowering: captured variables become leading params
 * of the referenced MIR function, so a closure is just a function reference.
 */
export interface MirClosureRef {
  kind: 'closure_ref';
  fnName: string;
  captures: MirValue[];   // captured outer values, positional
  type: HirType;
}

/**
 * Tag-inspection intrinsics used to lower `match` on Option/Result and to
 * extract their inner payload for binding patterns. Backends implement them as
 * a tag-field check + field load (trivial for native; trivial for the
 * reference interpreter's tagged values). Keeping them as a single
 * `intrinsic` value kind avoids grammar inflation while staying backend
 * agnostic.
 */
export type MirIntrinsic =
  | { kind: 'intrinsic'; op: 'is_some' | 'is_none'; arg: MirValue; type: HirType }   // Bool
  | { kind: 'intrinsic'; op: 'is_ok' | 'is_err'; arg: MirValue; type: HirType }      // Bool
  | { kind: 'intrinsic'; op: 'unwrap_some' | 'unwrap_ok' | 'unwrap_err'; arg: MirValue; type: HirType };

// ----------------------------------------------------------------------------
// Block instructions (everything that executes inside a block except the
// terminator). Each carries a Span2.
// ----------------------------------------------------------------------------

export type MirInstr = MirAssign | MirStoreField | MirStoreIndex;

/** Defines a local: `name = value`. */
export interface MirAssign {
  kind: 'assign';
  name: string;
  type: HirType;
  value: MirValue;
  span: Span2;
}

export interface MirStoreField {
  kind: 'store_field';
  obj: MirValue;
  name: string;
  value: MirValue;
  span: Span2;
}

export interface MirStoreIndex {
  kind: 'store_index';
  obj: MirValue;
  index: MirValue;
  value: MirValue;
  span: Span2;
}

// ----------------------------------------------------------------------------
// Terminators — exactly one per block, stored in `MirBlock.term`.
// ----------------------------------------------------------------------------

export type MirTerm = MirJumpTerm | MirBranchTerm | MirReturnTerm | MirUnreachableTerm;

export interface MirJumpTerm {
  kind: 'jump';
  target: string;
}

export interface MirBranchTerm {
  kind: 'branch';
  cond: MirValue;
  thenLabel: string;
  elseLabel: string;
}

export interface MirReturnTerm {
  kind: 'return';
  value?: MirValue;
}

export interface MirUnreachableTerm {
  kind: 'unreachable';
}

// ----------------------------------------------------------------------------
// Basic blocks & functions
// ----------------------------------------------------------------------------

export interface MirBlock {
  label: string;
  params: MirBlockParam[];
  instrs: MirInstr[];
  term: MirTerm;
}

export interface MirBlockParam {
  name: string;
  type: HirType;
  span: Span2;
}

export interface MirFunctionParam {
  name: string;
  type: HirType;
  span: Span2;
}

export interface MirFunction {
  kind: 'fn';
  name: string;
  typeParams: string[];
  params: MirFunctionParam[];
  ret: HirType;
  blocks: MirBlock[];
  span: Span2;
}

export interface MirStructDecl {
  kind: 'struct';
  name: string;
  typeParams: string[];
  fields: Array<{ name: string; type: HirType }>;
  span: Span2;
}

export interface MirEnumDecl {
  kind: 'enum';
  name: string;
  typeParams: string[];
  variants: Array<{ name: string; data?: HirType }>;
  span: Span2;
}

export interface MirConstDecl {
  kind: 'const';
  name: string;
  value: MirValue;
  type: HirType;
  span: Span2;
}

/**
 * A closure-converted function lifted out of an expression during lowering.
 * These are appended to the module's declaration list.
 */
export interface MirClosureDecl {
  kind: 'closure_fn';
  name: string;
  params: MirFunctionParam[];
  ret: HirType;
  blocks: MirBlock[];
  captured: string[];
  span: Span2;
}

export type MirDecl = MirFunction | MirStructDecl | MirEnumDecl | MirConstDecl | MirClosureDecl;

export interface MirModule {
  name: string;
  imports: string[];
  decls: MirDecl[];
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function mirTypeString(t: HirType): string {
  switch (t.kind) {
    case 'prim': return t.name;
    case 'struct': return t.name;
    case 'enum': return t.name;
    case 'nominal': return t.name;
    case 'array': return `Array<${mirTypeString(t.element)}>`;
    case 'map': return `Map<${mirTypeString(t.key)}, ${mirTypeString(t.value)}>`;
    case 'optional': return `${mirTypeString(t.inner)}?`;
    case 'result': return `Result<${mirTypeString(t.ok)}, ${mirTypeString(t.err)}>`;
    case 'fn': return `fn(${t.params.map((p) => mirTypeString(p.type)).join(', ')}) -> ${mirTypeString(t.ret)}`;
    case 'void': return 'Void';
    case 'var': return `T${t.id}`;
  }
}

export function isMirNumeric(t: HirType): boolean {
  return t.kind === 'prim' && (t.name === 'Int' || t.name === 'Float');
}
