import type { Span2 } from '../lexer/token.ts';

/**
 * NOVA abstract syntax tree.
 *
 * Plain tagged-union nodes; every node carries a Span for diagnostics and
 * source maps. The AST is serializable to JSON (`nova ast --json`).
 */

export type Expr =
  | IntLit
  | FloatLit
  | StrLit
  | BoolLit
  | NullLit
  | IdentExpr
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | FieldExpr
  | IndexExpr
  | ArrayLit
  | MapLit
  | PropagateExpr
  | OkExpr
  | ErrorExpr
  | SomeExpr
  | NoneExpr
  | ClosureExpr;

export interface Spanned {
  span: Span2;
}

export interface IntLit extends Spanned {
  kind: 'int';
  value: number;
}

export interface FloatLit extends Spanned {
  kind: 'float';
  value: number;
}

export type StringPartExpr =
  | { kind: 'text'; text: string }
  | { kind: 'interp'; expr: Expr };

export interface StrLit extends Spanned {
  kind: 'string';
  parts: StringPartExpr[];
}

export interface BoolLit extends Spanned {
  kind: 'bool';
  value: boolean;
}

export interface NullLit extends Spanned {
  kind: 'null';
}

export interface IdentExpr extends Spanned {
  kind: 'ident';
  name: string;
}

export type BinOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export interface BinaryExpr extends Spanned {
  kind: 'binary';
  op: BinOp;
  left: Expr;
  right: Expr;
}

export type UnOp = '-' | '!' | 'not';

export interface UnaryExpr extends Spanned {
  kind: 'unary';
  op: UnOp;
  expr: Expr;
}

export interface CallArg {
  name?: string;
  value: Expr;
}

export interface CallExpr extends Spanned {
  kind: 'call';
  callee: Expr;
  args: CallArg[];
}

export interface FieldExpr extends Spanned {
  kind: 'field';
  obj: Expr;
  name: string;
}

export interface IndexExpr extends Spanned {
  kind: 'index';
  obj: Expr;
  index: Expr;
}

export interface ArrayLit extends Spanned {
  kind: 'array';
  elements: Expr[];
}

export interface MapLit extends Spanned {
  kind: 'map';
  entries: { key: Expr; value: Expr }[];
}

/** `expr?` — Result/Option propagation. */
export interface PropagateExpr extends Spanned {
  kind: 'propagate';
  expr: Expr;
}

export interface OkExpr extends Spanned {
  kind: 'ok';
  value?: Expr;
}

export interface ErrorExpr extends Spanned {
  kind: 'error';
  value?: Expr;
}

export interface SomeExpr extends Spanned {
  kind: 'some';
  value?: Expr;
}

export interface NoneExpr extends Spanned {
  kind: 'none';
}

export interface ClosureExpr extends Spanned {
  kind: 'closure';
  params: Param[];
  body: Block;
}

// ------------------------------------------------------------------ patterns

export type Pattern =
  | { kind: 'wildcard'; span: Span2 }
  | { kind: 'binding'; name: string; span: Span2 }
  | { kind: 'path'; name: string; variant: string; span: Span2 }  // Enum.Variant / struct name
  | { kind: 'literal'; expr: Expr; span: Span2 }
  | { kind: 'some'; inner: Pattern; span: Span2 }   // some(pattern) — Option payload
  | { kind: 'none'; span: Span2 }
  | { kind: 'ok'; inner: Pattern; span: Span2 }     // ok(pattern) — Result payload
  | { kind: 'err'; inner: Pattern; span: Span2 };

// ----------------------------------------------------------------- statements

export type Stmt =
  | AssignStmt
  | ExprStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | MatchStmt
  | BlockStmt
  | BreakStmt
  | ContinueStmt;

export interface AssignStmt extends Spanned {
  kind: 'assign';
  /** Declaration when the name is not yet bound in scope (resolve decides). */
  target: Expr; // IdentExpr | FieldExpr | IndexExpr
  annot?: TypeExpr;
  value: Expr;
  /** Set by the resolver: true when this introduces a new binding. */
  isDeclaration?: boolean;
}

export interface ExprStmt extends Spanned {
  kind: 'expr';
  expr: Expr;
}

export interface Block {
  stmts: Stmt[];
  span: Span2;
}

export interface IfStmt extends Spanned {
  kind: 'if';
  cond: Expr;
  then: Block;
  else?: Block;
}

export interface WhileStmt extends Spanned {
  kind: 'while';
  cond: Expr;
  body: Block;
}

export interface ForStmt extends Spanned {
  kind: 'for';
  name: string;
  iter: Expr;
  body: Block;
}

export interface ReturnStmt extends Spanned {
  kind: 'return';
  value?: Expr;
}

export interface MatchArm {
  pattern: Pattern;
  body: Block;
  span: Span2;
}

export interface MatchStmt extends Spanned {
  kind: 'match';
  subject: Expr;
  arms: MatchArm[];
}

export interface BlockStmt extends Spanned {
  kind: 'block';
  block: Block;
}

export interface BreakStmt extends Spanned {
  kind: 'break';
}

export interface ContinueStmt extends Spanned {
  kind: 'continue';
}

// ----------------------------------------------------------------------------
// Type declarations
// ----------------------------------------------------------------------------

export interface TypeDecl extends Spanned {
  kind: 'type';
  name: string;
  inner: TypeExpr;
}

// ---------------------------------------------------------------- type exprs

export type TypeExpr =
  | { kind: 'named'; name: string; args: TypeExpr[]; span: Span2 }
  | { kind: 'optional'; inner: TypeExpr; span: Span2 }
  | { kind: 'func'; params: TypeExpr[]; ret: TypeExpr; span: Span2 };

// ------------------------------------------------------------------ decls

export interface Param {
  name: string;
  type?: TypeExpr;
  span: Span2;
}

export type Decl =
  | FnDecl
  | StructDecl
  | EnumDecl
  | ConstDecl
  | TestDecl
  | UseDecl
  | TypeDecl;

export interface FnDecl extends Spanned {
  kind: 'fn';
  name: string;
  typeParams: string[];  // Generic type parameters: <T, U>
  params: Param[];
  ret?: TypeExpr;
  body: Block;
  exported: boolean;
}

export interface StructField {
  name: string;
  type: TypeExpr;
  span: Span2;
}

export interface StructDecl extends Spanned {
  kind: 'struct';
  name: string;
  typeParams: string[];  // Generic type parameters: <T>
  fields: StructField[];
  exported: boolean;
}

export interface EnumVariant {
  name: string;
  span: Span2;
  fields: TypeExpr[];  // Variant payload types (empty for unit variants)
}

export interface EnumDecl extends Spanned {
  kind: 'enum';
  name: string;
  typeParams: string[];  // Generic type parameters: <T>
  variants: EnumVariant[];
  exported: boolean;
}

export interface ConstDecl extends Spanned {
  kind: 'const';
  name: string;
  annot?: TypeExpr;
  value: Expr;
  exported: boolean;
}

export interface TestDecl extends Spanned {
  kind: 'test';
  name: string;
  body: Block;
}

export interface UseDecl extends Spanned {
  kind: 'use';
  path: string;
}

export interface Program {
  kind: 'program';
  decls: TopLevelNode[];
  file: string;
  span: Span2;
}

/** Anything allowed at the top level of a compilation unit. */
export type TopLevelNode = Decl | Stmt;
