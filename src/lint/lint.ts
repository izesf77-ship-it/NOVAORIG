/**
 * NOVA linter.
 *
 * A rule receives a checked program and may emit diagnostics (warnings/errors).
 * Rules are registered in `RULES` and run by `lintProgram`.
 *
 * New rules can be added by implementing `LintRule` and pushing to `RULES`.
 */
import type { Program, Stmt, Expr } from '../compiler/ast/ast.ts';
import type { Diagnostic, Span } from '../compiler/diagnostics/diagnostics.ts';

export interface LintProgram {
  programs: Program[];
  source: (file: string) => string | undefined;
}

export interface LintRule {
  name: string;
  code: string;
  diagnose: (ctx: LintProgram) => Diagnostic[];
}

function diag(code: string, message: string, span: Span, severity: 'warning' | 'error' = 'warning', help?: string): Diagnostic {
  return { code, severity, message, span, help };
}

// ---------------------------------------------------------------------------
// Rule NOVA7001: empty block
// ---------------------------------------------------------------------------

function emptyBlock(ctx: LintProgram): Diagnostic[] {
  const d: Diagnostic[] = [];
  for (const prog of ctx.programs) {
    for (const decl of prog.decls) {
      if (decl.kind === 'fn') visitEmpty(decl.body, d);
    }
  }
  return d;
}

function visitEmpty(b: { stmts: Stmt[]; span?: Span }, d: Diagnostic[]): void {
  for (const s of b.stmts) {
    if (s.kind === 'block' && s.block.stmts.length === 0) {
      d.push(diag('NOVA7004', 'empty block', s.span, 'warning', 'remove the empty braces or add statements'));
    }
    if (s.kind === 'if') {
      if (s.then.stmts.length === 0) d.push(diag('NOVA7004', 'empty block', s.then.span ?? s.span, 'warning', 'remove the empty braces or add statements'));
      if (s.else && s.else.stmts.length === 0) d.push(diag('NOVA7004', 'empty block', s.else.span ?? s.span, 'warning', 'remove the empty braces or add statements'));
      visitEmpty(s.then, d); if (s.else) visitEmpty(s.else, d);
    }
    if ((s.kind === 'while' || s.kind === 'for') && s.body.stmts.length === 0) d.push(diag('NOVA7004', 'empty block', s.body.span ?? s.span, 'warning', 'remove the empty braces or add statements'));
    if (s.kind === 'match') for (const a of s.arms) {
      if (a.body.stmts.length === 0) d.push(diag('NOVA7004', 'empty match arm', a.span ?? s.span, 'warning', 'remove the empty arm or add statements'));
      visitEmpty(a.body, d);
    }
    if (s.kind === 'block') visitEmpty(s.block, d);
  }
}

// ---------------------------------------------------------------------------
// Rule NOVA7002: unreachable code
// ---------------------------------------------------------------------------

function unreachable(ctx: LintProgram): Diagnostic[] {
  const d: Diagnostic[] = [];
  for (const prog of ctx.programs) {
    for (const decl of prog.decls) {
      if (decl.kind === 'fn') walkStmtsDead(decl.body.stmts, d);
    }
  }
  return d;
}

function walkStmtsDead(stmts: Stmt[], d: Diagnostic[]): void {
  let dead = false;
  for (const s of stmts) {
    if (dead) {
      d.push(diag('NOVA7002', 'unreachable statement', s.span, 'warning', 'control flow exits before this point'));
      continue;
    }
    if (s.kind === 'return' || s.kind === 'break' || s.kind === 'continue') dead = true;
    if (s.kind === 'block') walkStmtsDead(s.block.stmts, d);
    if (s.kind === 'if') { walkStmtsDead(s.then.stmts, d); if (s.else) walkStmtsDead(s.else.stmts, d); }
    if (s.kind === 'while' && s.cond.kind === 'bool' && s.cond.value === false) dead = true;
    if (s.kind === 'for') walkStmtsDead(s.body.stmts, d);
  }
}

// ---------------------------------------------------------------------------
// Rule NOVA7003: suspicious comparison (x == x)
// ---------------------------------------------------------------------------

function suspiciousCmp(ctx: LintProgram): Diagnostic[] {
  const d: Diagnostic[] = [];
  for (const prog of ctx.programs) {
    for (const decl of prog.decls) {
      if (decl.kind === 'fn') walkExpr(decl.body, d);
    }
  }
  return d;
}

function walkExpr(b: { stmts: Stmt[] }, d: Diagnostic[]): void {
  for (const s of b.stmts) walkStmt(s, d);
}
function walkStmt(s: Stmt, d: Diagnostic[]): void {
  if (s.kind === 'expr') visitExpr(s.expr, d);
  if (s.kind === 'assign') visitExpr(s.value, d);
  if (s.kind === 'if') { visitExpr(s.cond, d); walkExpr(s.then, d); if (s.else) walkExpr(s.else, d); }
  if (s.kind === 'while') { visitExpr(s.cond, d); walkExpr(s.body, d); }
  if (s.kind === 'for') { visitExpr(s.iter, d); walkExpr(s.body, d); }
  if (s.kind === 'match') { visitExpr(s.subject, d); for (const a of s.arms) walkExpr(a.body, d); }
  if (s.kind === 'block') walkExpr(s.block, d);
  if (s.kind === 'return' && s.value) visitExpr(s.value, d);
}
function visitExpr(e: Expr, d: Diagnostic[]): void {
  if (e.kind === 'binary' && (e.op === '==' || e.op === '!=')) {
    if (e.left.kind === 'ident' && e.right.kind === 'ident' && e.left.name === e.right.name) {
      d.push(diag('NOVA7003', `comparison of '${e.left.name}' with itself is always ${e.op === '==' ? 'true' : 'false'}`, e.span, 'warning', 'use two different values'));
    }
  }
  if (e.kind === 'binary') { visitExpr(e.left, d); visitExpr(e.right, d); }
  if (e.kind === 'unary') visitExpr(e.expr, d);
  if (e.kind === 'call') { visitExpr(e.callee, d); for (const a of e.args) visitExpr(a.value, d); }
  if (e.kind === 'field') visitExpr(e.obj, d);
  if (e.kind === 'index') { visitExpr(e.obj, d); visitExpr(e.index, d); }
  if (e.kind === 'array') for (const el of e.elements) visitExpr(el, d);
  if (e.kind === 'map') for (const en of e.entries) { visitExpr(en.key, d); visitExpr(en.value, d); }
  if (e.kind === 'propagate') visitExpr(e.expr, d);
  if (e.kind === 'ok' && e.value) visitExpr(e.value, d);
  if (e.kind === 'error' && e.value) visitExpr(e.value, d);
  if (e.kind === 'some' && e.value) visitExpr(e.value, d);
  if (e.kind === 'closure') walkExpr(e.body, d);
}

// ---------------------------------------------------------------------------
// Rule NOVA7005: unnecessary condition (literal Bool)
// ---------------------------------------------------------------------------

function unnecessaryCond(ctx: LintProgram): Diagnostic[] {
  const d: Diagnostic[] = [];
  for (const prog of ctx.programs) {
    for (const decl of prog.decls) {
      if (decl.kind === 'fn') findLitCond(decl.body, d);
    }
  }
  return d;
}

function findLitCond(b: { stmts: Stmt[] }, d: Diagnostic[]): void {
  for (const s of b.stmts) {
    if (s.kind === 'if' && s.cond.kind === 'bool') {
      d.push(diag('NOVA7005', `literal boolean condition is always ${s.cond.value}`, s.cond.span, 'warning', 'remove the condition'));
    }
    if (s.kind === 'while' && s.cond.kind === 'bool') {
      d.push(diag('NOVA7006', `literal boolean condition is always ${s.cond.value}`, s.cond.span, 'warning', 'use while true/false literally'));
    }
    if (s.kind === 'if') { findLitCond(s.then, d); if (s.else) findLitCond(s.else, d); }
    if (s.kind === 'while') findLitCond(s.body, d);
    if (s.kind === 'for') findLitCond(s.body, d);
    if (s.kind === 'block') findLitCond(s.block, d);
    if (s.kind === 'match') findLitCond(s.subject as unknown as { stmts: Stmt[] }, d);
  }
}

// ---------------------------------------------------------------------------

export const RULES: LintRule[] = [
  { name: 'empty-block', code: 'NOVA7004', diagnose: emptyBlock },
  { name: 'unreachable', code: 'NOVA7002', diagnose: unreachable },
  { name: 'suspicious-comparison', code: 'NOVA7003', diagnose: suspiciousCmp },
  { name: 'unnecessary-condition', code: 'NOVA7005', diagnose: unnecessaryCond },
];

export function lintProgram(ctx: LintProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rule of RULES) {
    try { out.push(...rule.diagnose(ctx)); } catch { /* rule failure does not abort */ }
  }
  return out;
}