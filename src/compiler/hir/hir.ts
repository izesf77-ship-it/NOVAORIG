/**
 * NOVA High-level Intermediate Representation (HIR).
 *
 * HIR is the first backend-independent representation. It is produced by the
 * type checker and consumed by all backends (interpreter, JS codegen, future
 * native backend). HIR is:
 *
 *   - Typed: every expression carries its resolved type.
 *   - JS-independent: no JavaScript-specific value types or semantics.
 *   - Simplified: no syntactic sugar, all desugaring done.
 *
 * HIR is NOT optimized. For optimization-friendly IR, see MIR.
 */

import type { Span2 } from '../lexer/token.ts';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type HirType =
  | { kind: 'prim'; name: 'Int' | 'Float' | 'String' | 'Bool' | 'Null' }
  | { kind: 'struct'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'nominal'; name: string; inner: HirType }
  | { kind: 'array'; element: HirType }
  | { kind: 'map'; key: HirType; value: HirType }
  | { kind: 'optional'; inner: HirType }
  | { kind: 'result'; ok: HirType; err: HirType }
  | { kind: 'fn'; params: HirParam[]; ret: HirType }
  | { kind: 'void' }
  | { kind: 'var'; id: number };

export interface HirParam {
  name: string;
  type: HirType;
}

// ----------------------------------------------------------------------------
// Identifiers
// ----------------------------------------------------------------------------

export type HirIdent =
  | { kind: 'local'; name: string; type: HirType }
  | { kind: 'global'; name: string; type: HirType }
  | { kind: 'fn'; name: string; type: HirType };

// ----------------------------------------------------------------------------
// Expressions
// ----------------------------------------------------------------------------

export type HirExpr =
  | HirLiteral
  | HirIdentExpr
  | HirBinaryExpr
  | HirUnaryExpr
  | HirCallExpr
  | HirFieldExpr
  | HirIndexExpr
  | HirArrayLit
  | HirMapLit
  | HirBlockExpr
  | HirIfExpr
  | HirMatchExpr
  | HirReturnExpr
  | HirPropagateExpr
  | HirOkExpr
  | HirErrorExpr
  | HirAssignExpr
  | HirClosureExpr
  | HirSomeExpr
  | HirNoneExpr;

export interface HirTyped {
  type: HirType;
  span: Span2;
}

export interface HirLiteral extends HirTyped {
  kind: 'lit';
  value: number | string | boolean | null;
}

export interface HirIdentExpr extends HirTyped {
  kind: 'ident';
  ident: HirIdent;
}

export interface HirBinaryExpr extends HirTyped {
  kind: 'binary';
  op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
  left: HirExpr;
  right: HirExpr;
}

export interface HirUnaryExpr extends HirTyped {
  kind: 'unary';
  op: '-' | '!' | 'not';
  expr: HirExpr;
}

export interface HirCallArg {
  name?: string;
  value: HirExpr;
}

export interface HirCallExpr extends HirTyped {
  kind: 'call';
  callee: HirExpr;
  args: HirCallArg[];
}

export interface HirFieldExpr extends HirTyped {
  kind: 'field';
  obj: HirExpr;
  name: string;
}

export interface HirIndexExpr extends HirTyped {
  kind: 'index';
  obj: HirExpr;
  index: HirExpr;
}

export interface HirArrayLit extends HirTyped {
  kind: 'array';
  elements: HirExpr[];
}

export interface HirMapEntry {
  key: HirExpr;
  value: HirExpr;
}

export interface HirMapLit extends HirTyped {
  kind: 'map';
  entries: HirMapEntry[];
}

export interface HirBlockExpr extends HirTyped {
  kind: 'block';
  stmts: HirStmt[];
  tail?: HirExpr;
}

/**
 * An if *expression* (tail-position conditional value), as opposed to a
 * statement-level `HirIfStmt`. The distinct `kind: 'if_expr'` tag guarantees
 * a backend can always distinguish the two; HIR invariants require that
 * every node's `kind` is unambiguous.
 */
export interface HirIfExpr extends HirTyped {
  kind: 'if_expr';
  cond: HirExpr;
  then: HirBlockExpr;
  else?: HirBlockExpr | HirIfExpr;
}


// ----------------------------------------------------------------------------
// Patterns
// ----------------------------------------------------------------------------

export type HirPattern =
  | { kind: 'wildcard'; span: Span2 }
  | { kind: 'binding'; name: string; type: HirType; span: Span2 }
  | { kind: 'path'; enumName: string; variant: string; span: Span2 }
  | { kind: 'literal'; value: HirLiteral; span: Span2 }
  | { kind: 'some'; inner: HirPattern; span: Span2 }
  | { kind: 'none'; span: Span2 }
  | { kind: 'ok'; inner: HirPattern; span: Span2 }
  | { kind: 'err'; inner: HirPattern; span: Span2 };

export interface HirMatchArm {
  pattern: HirPattern;
  body: HirBlockExpr;
}

export interface HirMatchExpr extends HirTyped {
  kind: 'match_expr';
  subject: HirExpr;
  arms: HirMatchArm[];
}

export interface HirReturnExpr extends HirTyped {
  kind: 'return';
  value?: HirExpr;
}

export interface HirPropagateExpr extends HirTyped {
  kind: 'propagate';
  expr: HirExpr;
}

export interface HirOkExpr extends HirTyped {
  kind: 'ok';
  value?: HirExpr;
}

export interface HirErrorExpr extends HirTyped {
  kind: 'error';
  value?: HirExpr;
}

export interface HirAssignExpr extends HirTyped {
  kind: 'assign';
  target: HirIdentExpr;
  value: HirExpr;
}

export interface HirClosureExpr extends HirTyped {
  kind: 'closure';
  params: HirParam[];
  ret: HirType;
  body: HirBlockExpr;
}

// ----------------------------------------------------------------------------
// Statements
// ----------------------------------------------------------------------------

export type HirStmt =
  | HirExprStmt
  | HirLetStmt
  | HirAssignStmt
  | HirFieldAssignStmt
  | HirIndexAssignStmt
  | HirIfStmt
  | HirWhileStmt
  | HirForStmt
  | HirReturnStmt
  | HirMatchStmt
  | HirBreakStmt
  | HirContinueStmt;

export interface HirStmtBase {
  span: Span2;
}

export interface HirExprStmt extends HirStmtBase {
  kind: 'expr';
  expr: HirExpr;
}

export interface HirLetStmt extends HirStmtBase {
  kind: 'let';
  name: string;
  type?: HirType;
  value: HirExpr;
  isConst: boolean;
}

export interface HirAssignStmt extends HirStmtBase {
  kind: 'assign';
  target: HirIdentExpr;
  value: HirExpr;
}

export interface HirFieldAssignStmt extends HirStmtBase {
  kind: 'field_assign';
  obj: HirExpr;
  name: string;
  value: HirExpr;
}

export interface HirIndexAssignStmt extends HirStmtBase {
  kind: 'index_assign';
  obj: HirExpr;
  index: HirExpr;
  value: HirExpr;
}

export interface HirBlockStmt extends HirStmtBase {
  kind: 'block';
  stmts: HirStmt[];
  tail?: HirExpr;
  type: HirType;
}

export interface HirIfStmt extends HirStmtBase {
  kind: 'if';
  cond: HirExpr;
  then: HirBlockExpr;
  else?: HirBlockExpr;
}

export interface HirWhileStmt extends HirStmtBase {
  kind: 'while';
  cond: HirExpr;
  body: HirBlockExpr;
}

export interface HirForStmt extends HirStmtBase {
  kind: 'for';
  name: string;
  iter: HirExpr;
  body: HirBlockExpr;
}

export interface HirReturnStmt extends HirStmtBase {
  kind: 'return';
  value?: HirExpr;
}

export interface HirMatchStmt extends HirStmtBase {
  kind: 'match';
  subject: HirExpr;
  arms: HirMatchArm[];
}

export interface HirBreakStmt extends HirStmtBase {
  kind: 'break';
}

export interface HirContinueStmt extends HirStmtBase {
  kind: 'continue';
}

// ----------------------------------------------------------------------------
// Declarations
// ----------------------------------------------------------------------------

export type HirDecl =
  | HirFnDecl
  | HirStructDecl
  | HirEnumDecl
  | HirConstDecl
  | HirNominalDecl;

export interface HirFnDecl {
  kind: 'fn';
  name: string;
  typeParams: string[];
  params: HirParam[];
  ret: HirType;
  body: HirBlockExpr;
  exported: boolean;
  span: Span2;
}

export interface HirStructField {
  name: string;
  type: HirType;
}

export interface HirStructDecl {
  kind: 'struct';
  name: string;
  typeParams: string[];
  fields: HirStructField[];
  exported: boolean;
  span: Span2;
}

export interface HirEnumVariant {
  name: string;
  data?: HirType;
}

export interface HirEnumDecl {
  kind: 'enum';
  name: string;
  typeParams: string[];
  variants: HirEnumVariant[];
  exported: boolean;
  span: Span2;
}

export interface HirConstDecl {
  kind: 'const';
  name: string;
  type?: HirType;
  value: HirExpr;
  exported: boolean;
  span: Span2;
}

export interface HirNominalDecl {
  kind: 'nominal';
  name: string;
  inner: HirType;
  span: Span2;
}

// ----------------------------------------------------------------------------
// Module
// ----------------------------------------------------------------------------

export interface HirModule {
  name: string;
  decls: HirDecl[];
  imports: string[];
}

// ----------------------------------------------------------------------------
// Type utilities
// ----------------------------------------------------------------------------

export function hirTypeToString(t: HirType): string {
  switch (t.kind) {
    case 'prim': return t.name;
    case 'struct': return t.name;
    case 'enum': return t.name;
    case 'nominal': return t.name;
    case 'array': return `Array<${hirTypeToString(t.element)}>`;
    case 'map': return `Map<${hirTypeToString(t.key)}, ${hirTypeToString(t.value)}>`;
    case 'optional': return `${hirTypeToString(t.inner)}?`;
    case 'result': return `Result<${hirTypeToString(t.ok)}, ${hirTypeToString(t.err)}>`;
    case 'fn': return `fn(${t.params.map((p) => `${p.name}: ${hirTypeToString(p.type)}`).join(', ')}) -> ${hirTypeToString(t.ret)}`;
    case 'void': return 'Void';
    case 'var': return `T${t.id}`;
  }
}

export function isHirNumeric(t: HirType): boolean {
  return t.kind === 'prim' && (t.name === 'Int' || t.name === 'Float');
}

export function isHirOptional(t: HirType): boolean {
  return t.kind === 'optional';
}

export function isHirResult(t: HirType): boolean {
  return t.kind === 'result';
}
