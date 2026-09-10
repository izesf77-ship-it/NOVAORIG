/**
 * AST → HIR lowering.
 *
 * Converts the typed AST (AST + checker symbol tables + ExprTypeMap) into HIR.
 * Every HIR expression carries its resolved type. HIR is backend-agnostic.
 */
import type {
  Block, Expr, Program, Stmt, Decl, TypeExpr,
  FnDecl, StructDecl, EnumDecl, ConstDecl, TypeDecl,
  Pattern, UseDecl,
} from '../ast/ast.ts';
import type { Span2 } from '../lexer/token.ts';
import type { NovaType } from '../typechecker/types.ts';
import type {
  HirModule, HirDecl, HirExpr, HirStmt, HirType, HirParam,
  HirLiteral, HirPattern, HirIdent, HirMatchArm, HirBlockExpr,
  HirFnDecl, HirStructDecl, HirEnumDecl, HirConstDecl, HirNominalDecl,
} from './hir.ts';
import type { SymbolTables } from '../backend/backend.ts';

function novaToHirType(t: NovaType): HirType {
  switch (t.kind) {
    case 'prim': return { kind: 'prim', name: t.name };
    case 'struct': return { kind: 'struct', name: t.name };
    case 'enum': return { kind: 'enum', name: t.name };
    case 'array': return { kind: 'array', element: novaToHirType(t.element) };
    case 'map': return { kind: 'map', key: novaToHirType(t.key), value: novaToHirType(t.value) };
    case 'optional': return { kind: 'optional', inner: novaToHirType(t.inner) };
    case 'result': return { kind: 'result', ok: novaToHirType(t.ok), err: novaToHirType(t.err) };
    case 'fn': return {
      kind: 'fn',
      params: t.params.map((p) => ({ name: p.name, type: novaToHirType(p.type) })),
      ret: novaToHirType(t.ret),
    };
    case 'void': return { kind: 'void' };
    case 'nominal': return { kind: 'nominal', name: t.name, inner: novaToHirType(t.inner) };
    case 'var': return { kind: 'var', id: t.id };
    case 'generic': return { kind: 'prim', name: 'Null' };
    case 'unknown': return { kind: 'prim', name: 'Null' };
  }
}

function typeExprToHirType(t: TypeExpr): HirType {
  if (t.kind === 'optional') return { kind: 'optional', inner: typeExprToHirType(t.inner) };
  if (t.kind === 'func') return {
    kind: 'fn',
    params: t.params.map((p, i) => ({ name: `p${i}`, type: typeExprToHirType(p) })),
    ret: typeExprToHirType(t.ret),
  };
  if (t.name === 'Int' || t.name === 'Float' || t.name === 'String' || t.name === 'Bool' || t.name === 'Null') {
    return { kind: 'prim', name: t.name };
  }
  // For user-defined names, use an opaque nominal reference. The typechecker
  // has already validated the name by lowering time.
  return { kind: 'struct', name: t.name };
}

interface Ctx {
  exprTypes: Map<Expr, NovaType>;
  symbols: SymbolTables;
}

export function astToHir(
  programs: Program[],
  symbols: SymbolTables,
  exprTypes: Map<Expr, NovaType>,
): HirModule {
  const ctx: Ctx = { exprTypes, symbols };
  const decls: HirDecl[] = [];

  for (const prog of programs) {
    for (const decl of prog.decls) {
      const out = lowerDecl(decl, ctx);
      if (out) decls.push(out);
    }
  }

  return {
    name: 'main',
    decls,
    imports: programs.flatMap((p) => p.decls.filter((d) => d.kind === 'use').map((d) => (d as UseDecl).path)),
  };
}

function lowerDecl(decl: Decl, ctx: Ctx): HirDecl | null {
  switch (decl.kind) {
    case 'fn': return lowerFn(decl, ctx);
    case 'struct': return lowerStruct(decl);
    case 'enum': return lowerEnum(decl);
    case 'const': return lowerConst(decl, ctx);
    case 'type': return lowerNominal(decl);
    case 'test':
    case 'use':
      return null;
  }
}

function lowerFn(decl: FnDecl, ctx: Ctx): HirFnDecl {
  const params: HirParam[] = (decl.params ?? []).map((p) => ({
    name: p.name,
    type: p.type ? typeExprToHirType(p.type) : { kind: 'prim', name: 'Null' },
  }));
  const ret = decl.ret ? typeExprToHirType(decl.ret) : { kind: 'void' };
  const body = lowerBlock(decl.body, ret, ctx);
  return {
    kind: 'fn',
    name: decl.name,
    typeParams: decl.typeParams ?? [],
    params,
    ret,
    body,
    exported: decl.exported ?? false,
    span: decl.span,
  };
}

function lowerStruct(decl: StructDecl): HirStructDecl {
  return {
    kind: 'struct',
    name: decl.name,
    typeParams: decl.typeParams ?? [],
    fields: (decl.fields ?? []).map((f) => ({ name: f.name, type: typeExprToHirType(f.type) })),
    exported: decl.exported ?? false,
    span: decl.span,
  };
}

function lowerEnum(decl: EnumDecl): HirEnumDecl {
  return {
    kind: 'enum',
    name: decl.name,
    typeParams: decl.typeParams ?? [],
    variants: (decl.variants ?? []).map((v) => ({ name: v.name })),
    exported: decl.exported ?? false,
    span: decl.span,
  };
}

function lowerConst(decl: ConstDecl, ctx: Ctx): HirConstDecl {
  return {
    kind: 'const',
    name: decl.name,
    type: decl.annot ? typeExprToHirType(decl.annot) : undefined,
    value: lowerExpr(decl.value, ctx),
    exported: decl.exported ?? false,
    span: decl.span,
  };
}

function lowerNominal(decl: TypeDecl): HirNominalDecl {
  return {
    kind: 'nominal',
    name: decl.name,
    inner: typeExprToHirType(decl.inner),
    span: decl.span,
  };
}

// ----------------------------------------------------------- blocks & stmts

function lowerBlock(block: Block, retType: HirType, ctx: Ctx): HirBlockExpr {
  const stmts: HirStmt[] = [];
  let tail: HirExpr | undefined;
  const last = block.stmts[block.stmts.length - 1];

  for (let i = 0; i < block.stmts.length; i++) {
    const stmt = block.stmts[i]!;
    const isLast = i === block.stmts.length - 1;
    // Promote trailing `if` whose branches are pure expressions to a
    // tail-position if-expression so its value is used.
    if (isLast && stmt.kind === 'if' && isExprOnlyBranch(stmt.then) && (!stmt.else || isExprOnlyBranch(stmt.else))) {
      tail = lowerIfAsExpr(stmt, ctx);
      continue;
    }
    // Promote a trailing match to a tail-position match-expression.
    if (isLast && stmt.kind === 'match') {
      const subj = lowerExpr(stmt.subject, ctx);
      const arms = stmt.arms.map((arm) => ({
        pattern: lowerPattern(arm.pattern),
        body: lowerBlock(arm.body, { kind: 'void' }, ctx),
      }));
      // The match produces the matched arm's tail value, so its type comes
      // from the last arm's tail — NOT from the subject (the subject's type
      // is the scrutinee type).
      const lastArm = arms[arms.length - 1];
      const armType = lastArm && lastArm.body.tail ? lastArm.body.tail.type : { kind: 'void' };
      tail = { kind: 'match_expr', subject: subj, arms, type: armType, span: stmt.span };
      continue;
    }
    if (stmt.kind === 'expr' && isLast) {
      tail = lowerExpr(stmt.expr, ctx);
      continue;
    }
    const s = lowerStmt(stmt, ctx);
    if (s !== undefined) stmts.push(s);
  }

  return {
    kind: 'block',
    stmts,
    tail,
    type: tail ? tail.type : { kind: 'void' },
    span: block.span,
  };
}

function isExprOnlyBranch(b: Block): boolean {
  return b.stmts.length === 1 && b.stmts[0]!.kind === 'expr';
}

function lowerIfAsExpr(stmt: Extract<Stmt, { kind: 'if' }>, ctx: Ctx): HirExpr {
  const cond = lowerExpr(stmt.cond, ctx);
  const thenB = lowerBlock(stmt.then, { kind: 'void' }, ctx);
  // An `if` without an else still yields an if-expression; the missing branch
  // produces `null` so the expression is always well-defined.
  const elseB = stmt.else
    ? lowerBlock(stmt.else, { kind: 'void' }, ctx)
    : { kind: 'block' as const, stmts: [], tail: { kind: 'lit' as const, value: null, type: { kind: 'prim' as const, name: 'Null' as const }, span: stmt.span }, type: { kind: 'prim' as const, name: 'Null' as const }, span: stmt.span };
  return { kind: 'if_expr', cond, then: thenB, else: elseB, type: thenB.type, span: stmt.span };
}

function lowerStmt(stmt: Stmt, ctx: Ctx): HirStmt | undefined {
  switch (stmt.kind) {
    case 'expr': {
      const e = lowerExpr(stmt.expr, ctx);
      return { kind: 'expr', expr: e, span: stmt.span };
    }
    case 'assign': {
      if (stmt.target.kind === 'ident') {
        const value = lowerExpr(stmt.value, ctx);
        if (stmt.isDeclaration) {
          // A new binding — emit a `let` statement carrying the resolved type.
          return {
            kind: 'let',
            name: stmt.target.name,
            type: stmt.annot ? typeExprToHirType(stmt.annot) : value.type,
            value,
            isConst: false,
            span: stmt.span,
          };
        }
        // A re-assignment to an existing local — emit `assign` (backend must
        // have already seen the variable; otherwise the checker/rename phase
        // would have flagged it). This preserves mutability semantics for the
        // native backend.
        return {
          kind: 'assign',
          target: {
            kind: 'ident',
            ident: { kind: 'local', name: stmt.target.name, type: value.type },
            type: value.type,
            span: stmt.target.span,
          },
          value,
          span: stmt.span,
        };
      }
      if (stmt.target.kind === 'field') {
        const obj = lowerExpr(stmt.target.obj, ctx);
        const value = lowerExpr(stmt.value, ctx);
        return {
          kind: 'field_assign',
          obj,
          name: stmt.target.name,
          value,
          span: stmt.span,
        };
      }
      if (stmt.target.kind === 'index') {
        const obj = lowerExpr(stmt.target.obj, ctx);
        const index = lowerExpr(stmt.target.index, ctx);
        const value = lowerExpr(stmt.value, ctx);
        return {
          kind: 'index_assign',
          obj,
          index,
          value,
          span: stmt.span,
        };
      }
      return undefined;
    }
    case 'if': {
      const cond = lowerExpr(stmt.cond, ctx);
      const thenB = lowerBlock(stmt.then, { kind: 'void' }, ctx);
      const elseB = stmt.else ? lowerBlock(stmt.else, { kind: 'void' }, ctx) : undefined;
      return { kind: 'if', cond, then: thenB, else: elseB, span: stmt.span };
    }
    case 'while': {
      const cond = lowerExpr(stmt.cond, ctx);
      const body = lowerBlock(stmt.body, { kind: 'void' }, ctx);
      return { kind: 'while', cond, body, span: stmt.span };
    }
    case 'for': {
      const iter = lowerExpr(stmt.iter, ctx);
      const body = lowerBlock(stmt.body, { kind: 'void' }, ctx);
      return { kind: 'for', name: stmt.name, iter, body, span: stmt.span };
    }
    case 'return': {
      return {
        kind: 'return',
        value: stmt.value ? lowerExpr(stmt.value, ctx) : undefined,
        span: stmt.span,
      };
    }
    case 'match': {
      const subject = lowerExpr(stmt.subject, ctx);
      const arms: HirMatchArm[] = stmt.arms.map((arm) => ({
        pattern: lowerPattern(arm.pattern),
        body: lowerBlock(arm.body, { kind: 'void' }, ctx),
      }));
      return { kind: 'match', subject, arms, span: stmt.span };
    }
    case 'block': {
      const block = lowerBlock(stmt.block, { kind: 'void' }, ctx);
      return { kind: 'block', stmts: block.stmts, tail: block.tail, type: block.type, span: stmt.span };
    }
    case 'break':
      return { kind: 'break', span: stmt.span };
    case 'continue':
      return { kind: 'continue', span: stmt.span };
  }
}

function lowerPattern(p: Pattern): HirPattern {
  switch (p.kind) {
    case 'wildcard':
      return { kind: 'wildcard', span: p.span };
    case 'binding':
      return { kind: 'binding', name: p.name, span: p.span };
    case 'path':
      return { kind: 'path', enumName: p.name, variant: p.variant, span: p.span };
    case 'some':
      return { kind: 'some', inner: lowerPattern(p.inner), span: p.span };
    case 'none':
      return { kind: 'none', span: p.span };
    case 'ok':
      return { kind: 'ok', inner: lowerPattern(p.inner), span: p.span };
    case 'err':
      return { kind: 'err', inner: lowerPattern(p.inner), span: p.span };
    case 'literal': {
      const e = p.expr;
      if (e.kind === 'int') return { kind: 'literal', value: { kind: 'lit', value: e.value, type: { kind: 'prim', name: 'Int' }, span: e.span }, span: p.span };
      if (e.kind === 'float') return { kind: 'literal', value: { kind: 'lit', value: e.value, type: { kind: 'prim', name: 'Float' }, span: e.span }, span: p.span };
      if (e.kind === 'bool') return { kind: 'literal', value: { kind: 'lit', value: e.value, type: { kind: 'prim', name: 'Bool' }, span: e.span }, span: p.span };
      if (e.kind === 'string') return { kind: 'literal', value: { kind: 'lit', value: serializeStr(e), type: { kind: 'prim', name: 'String' }, span: e.span }, span: p.span };
      return { kind: 'wildcard', span: p.span };
    }
  }
}

// ----------------------------------------------------------- expressions

function lowerExpr(expr: Expr, ctx: Ctx): HirExpr {
  const nt = ctx.exprTypes.get(expr);
  const t = nt ? novaToHirType(nt) : { kind: 'prim' as const, name: 'Null' as const };

  switch (expr.kind) {
    case 'int':
      return { kind: 'lit', value: expr.value, type: t, span: expr.span };
    case 'float':
      return { kind: 'lit', value: expr.value, type: t, span: expr.span };
    case 'string':
      return lowerString(expr, t, ctx);
    case 'bool':
      return { kind: 'lit', value: expr.value, type: t, span: expr.span };
    case 'null':
      return { kind: 'lit', value: null, type: t, span: expr.span };
    case 'ident': {
      const ident: HirIdent = { kind: 'local', name: expr.name, type: t };
      return { kind: 'ident', ident, type: t, span: expr.span };
    }
    case 'binary':
      return {
        kind: 'binary', op: expr.op,
        left: lowerExpr(expr.left, ctx),
        right: lowerExpr(expr.right, ctx),
        type: t, span: expr.span,
      };
    case 'unary':
      return {
        kind: 'unary', op: expr.op,
        expr: lowerExpr(expr.expr, ctx),
        type: t, span: expr.span,
      };
    case 'call':
      return {
        kind: 'call',
        callee: lowerExpr(expr.callee, ctx),
        args: expr.args.map((a) => ({ name: a.name, value: lowerExpr(a.value, ctx) })),
        type: t, span: expr.span,
      };
    case 'field':
      return {
        kind: 'field',
        obj: lowerExpr(expr.obj, ctx),
        name: expr.name,
        type: t, span: expr.span,
      };
    case 'index':
      return {
        kind: 'index',
        obj: lowerExpr(expr.obj, ctx),
        index: lowerExpr(expr.index, ctx),
        type: t, span: expr.span,
      };
    case 'array':
      return {
        kind: 'array',
        elements: expr.elements.map((e) => lowerExpr(e, ctx)),
        type: t, span: expr.span,
      };
    case 'map':
      return {
        kind: 'map',
        entries: expr.entries.map((e) => ({
          key: lowerExpr(e.key, ctx),
          value: lowerExpr(e.value, ctx),
        })),
        type: t, span: expr.span,
      };
    case 'propagate':
      return { kind: 'propagate', expr: lowerExpr(expr.expr, ctx), type: t, span: expr.span };
    case 'ok':
      return { kind: 'ok', value: expr.value ? lowerExpr(expr.value, ctx) : undefined, type: t, span: expr.span };
    case 'error':
      return { kind: 'error', value: expr.value ? lowerExpr(expr.value, ctx) : undefined, type: t, span: expr.span };
    case 'some':
      return { kind: 'some', value: expr.value ? lowerExpr(expr.value, ctx) : undefined, type: t, span: expr.span };
    case 'none':
      return { kind: 'none', type: t, span: expr.span };
    case 'closure':
      // `t` is the full `fn(params) -> ret` type; the closure's own return type
      // is `t.ret`, not the whole function type.
      const closureRet = t.kind === 'fn' ? t.ret : { kind: 'void' as const };
      return {
        kind: 'closure',
        params: (expr.params ?? []).map((p) => ({
          name: p.name,
          type: p.type ? typeExprToHirType(p.type) : { kind: 'prim', name: 'Null' },
        })),
        ret: closureRet,
        body: lowerBlock(expr.body, { kind: 'void' }, ctx),
        type: t, span: expr.span,
      };
    default: {
      // 'generic' — a callee ident with explicit type args. Lower as ident.
      const e = expr as unknown as { kind: string; name: string; span: Span2 };
      if (e.kind === 'generic' && typeof e.name === 'string') {
        return { kind: 'ident', ident: { kind: 'local', name: e.name, type: t }, type: t, span: expr.span };
      }
      throw new Error(`hir_lower: cannot lower expr kind '${(expr as { kind: string }).kind}'`);
    }
  }
}

function serializeStr(expr: Extract<Expr, { kind: 'string' }>): string {
  return expr.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
}

/**
 * Lower a string literal, expanding interpolations `{expr}` into a chain of
 * `+` concatenations of string fragments and the interpolated expressions.
 * A pure-text string collapses to a single `lit` so it needs no runtime alloc.
 */
function lowerString(expr: Extract<Expr, { kind: 'string' }>, t: HirType, ctx: Ctx): HirExpr {
  // Fast path: no interpolations.
  if (!expr.parts.some((p) => p.kind === 'interp')) {
    return { kind: 'lit', value: serializeStr(expr), type: t, span: expr.span };
  }
  const strType: HirType = { kind: 'prim', name: 'String' };
  const fragments: HirExpr[] = [];
  for (const p of expr.parts) {
    if (p.kind === 'text' && p.text.length > 0) {
      fragments.push({ kind: 'lit', value: p.text, type: strType, span: expr.span });
    }
    if (p.kind === 'interp') {
      fragments.push(lowerExpr(p.expr, ctx));
    }
  }
  // If there were only interpolation text, ensure we have something.
  if (fragments.length === 0) {
    return { kind: 'lit', value: '', type: strType, span: expr.span };
  }
  let acc: HirExpr = fragments[0]!;
  for (let i = 1; i < fragments.length; i++) {
    const f = fragments[i]!;
    acc = {
      kind: 'binary',
      op: '+',
      left: acc,
      right: f,
      type: strType,
      span: { ...expr.span, start: acc.span.start, end: f.span.end },
    };
  }
  return acc;
}