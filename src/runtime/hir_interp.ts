/**
 * NOVA HIR interpreter.
 *
 * Consumes a HirModule and symbol tables. Implements the Backend interface so
 * `nova run` can use it directly. This is the preferred interpreter for Phase 2;
 * the legacy AST interpreter in `src/runtime/interpreter.ts` remains as a
 * compatibility fallback and will be removed once the HIR interpreter reaches
 * parity on all existing examples and tests.
 */
import type {
  HirModule, HirDecl, HirExpr, HirStmt, HirPattern, HirType, HirIdent, HirParam, HirMatchArm,
} from '../compiler/hir/hir.ts';
import type { Diagnostic, Span2 } from '../compiler/diagnostics/diagnostics.ts';
import type { SymbolTables } from '../compiler/backend/backend.ts';
import type { BackendOutput, RunResult } from '../compiler/backend/backend.ts';
import { NovaExitSignal, NovaPanicSignal } from './signals.ts';
import * as fs from 'node:fs';

// --------------------------------------------------------------------------
// Value model — same tagged-object representation as the JS backend prelude.
// --------------------------------------------------------------------------

export type Value =
  | null
  | boolean
  | number
  | string
  | ArrayValue
  | MapValue
  | StructValue
  | EnumValue
  | ResultValue
  | OptionValue
  | ClosureValue
  | NativeFnValue;

export interface OptionValue {
  tag: 'some' | 'none';
  value?: Value;
}

export interface ArrayValue {
  tag: 'array';
  items: Value[];
}

export interface MapValue {
  tag: 'map';
  entries: Map<string, Value>;
}

export interface StructValue {
  tag: 'struct';
  structName: string;
  fields: Map<string, Value>;
}

export interface EnumValue {
  tag: 'enum';
  enumName: string;
  variant: string;
}

export interface ResultValue {
  tag: 'result';
  ok: boolean;
  value: Value;
}

export interface ClosureValue {
  tag: 'closure';
  params: HirParam[];
  body: HirExpr & { kind: 'block' };
  env: Env;
}

export interface NativeFnValue {
  tag: 'native';
  name: string;
  call: (args: Value[], span: Span2) => Value;
}

export class Env {
  private vars = new Map<string, { value: Value; isConst: boolean }>();
  private readonly parent: Env | null;
  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  get(name: string): Value | undefined {
    let e: Env | null = this;
    while (e) {
      const v = e.vars.get(name);
      if (v) return v.value;
      e = e.parent;
    }
    return undefined;
  }
  has(name: string): boolean {
    let e: Env | null = this;
    while (e) {
      if (e.vars.has(name)) return true;
      e = e.parent;
    }
    return false;
  }
  define(name: string, value: Value, isConst = false): void {
    this.vars.set(name, { value, isConst });
  }
  assign(name: string, value: Value): void {
    let e: Env | null = this;
    while (e) {
      const v = e.vars.get(name);
      if (v) {
        if (v.isConst) throw new RuntimeError(`cannot assign to constant '${name}'`, null);
        v.value = value;
        return;
      }
      e = e.parent;
    }
    throw new RuntimeError(`undefined variable '${name}'`, null);
  }
}

export class ReturnSignal {
  readonly value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}
export class BreakSignal {}
export class ContinueSignal {}

export class RuntimeError extends Error {
  readonly span: Span2 | null;
  constructor(message: string, span: Span2 | null) {
    super(message);
    this.name = 'RuntimeError';
    this.span = span;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export function stringify(v: Value): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const marker = v as { __enumMarker?: boolean; enumName?: string };
    if (marker.__enumMarker && marker.enumName) return marker.enumName;
    switch (v.tag) {
      case 'array': return '[' + v.items.map(stringify).join(', ') + ']';
      case 'map': return '{' + [...v.entries].map(([k, x]) => k + ': ' + stringify(x)).join(', ') + '}';
      case 'struct': return v.structName + '(' + [...v.fields].map(([k, x]) => k + ': ' + stringify(x)).join(', ') + ')';
      case 'enum': return v.enumName + '.' + v.variant;
      case 'result': return v.ok ? 'ok(' + stringify(v.value) + ')' : 'err(' + stringify(v.value) + ')';
      case 'some': return 'Some(' + stringify(v.value as Value) + ')';
      case 'none': return 'None';
      case 'closure': return '<fn>';
      case 'native': return '<native fn ' + v.name + '>';
    }
  }
  return String(v);
}

export function isTruthy(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  throw new RuntimeError('expected Bool', null);
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return a === b;
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as { tag: string };
    const bo = b as { tag: string };
    if (ao.tag !== bo.tag) return false;
    switch (ao.tag) {
      case 'array': {
        const x = (a as ArrayValue).items;
        const y = (b as ArrayValue).items;
        return x.length === y.length && x.every((v, i) => valuesEqual(v, y[i]!));
      }
      case 'map': {
        const x = (a as MapValue).entries;
        const y = (b as MapValue).entries;
        if (x.size !== y.size) return false;
        for (const [k, v] of x) {
          if (!y.has(k) || !valuesEqual(v, y.get(k)!)) return false;
        }
        return true;
      }
      case 'struct': {
        const x = (a as StructValue).fields;
        const y = (b as StructValue).fields;
        if ((a as StructValue).structName !== (b as StructValue).structName) return false;
        for (const [k, v] of x) {
          if (!y.has(k) || !valuesEqual(v, y.get(k)!)) return false;
        }
        return true;
      }
      case 'enum':
        return (a as EnumValue).enumName === (b as EnumValue).enumName &&
          (a as EnumValue).variant === (b as EnumValue).variant;
      case 'result':
        return (a as ResultValue).ok === (b as ResultValue).ok &&
          valuesEqual((a as ResultValue).value, (b as ResultValue).value);
      case 'some':
        return valuesEqual((a as OptionValue).value as Value, (b as OptionValue).value as Value);
      case 'none':
        return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Interpreter
// --------------------------------------------------------------------------

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export class HirInterpreter {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly structFields = new Map<string, string[]>();
  private readonly enumVariants = new Map<string, Set<string>>();
  private readonly fnDeclsByName = new Map<string, Extract<HirDecl, { kind: 'fn' }>>();
  private globals = new Env();
  private topLevelDone = false;

  private readonly module: HirModule;
  private readonly symbols: SymbolTables;

  constructor(module: HirModule, symbols: SymbolTables) {
    this.module = module;
    this.symbols = symbols;
    for (const decl of module.decls) {
      if (decl.kind === 'struct') {
        this.structFields.set(decl.name, decl.fields.map((f) => f.name));
      } else if (decl.kind === 'enum') {
        this.enumVariants.set(decl.name, new Set(decl.variants.map((v) => v.name)));
      } else if (decl.kind === 'fn') {
        this.fnDeclsByName.set(decl.name, decl);
      }
    }
    this.installNatives();
  }

  // --- public API ---------------------------------------------------------

  run(): number {
    try {
      this.executeTopLevel();
      if (this.fnDeclsByName.has('main')) {
        this.callFunction('main', []);
      }
      return 0;
    } catch (e) {
      if (e instanceof NovaExitSignal) return e.code;
      if (e instanceof NovaPanicSignal) {
        process.stderr.write(`panic: ${e.panicMessage}\n`);
        return 1;
      }
      this.report(e);
      return 1;
    }
  }

  runTests(): TestResult[] {
    const results: TestResult[] = [];
    for (const decl of this.module.decls) {
      if (decl.kind !== 'fn') continue;
      // We don't have a 'test' kind in HIR decls (tests are filtered out).
      // Tests come from AST; tests/features.ts still uses the AST path.
    }
    return results;
  }

  getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  generate(): BackendOutput & { code: string } {
    return { code: '// HirInterpreter does not generate code', diagnostics: [] };
  }

  // --- top level ----------------------------------------------------------

  private executeTopLevel(): void {
    if (this.topLevelDone) return;
    this.topLevelDone = true;
    for (const decl of this.module.decls) {
      if (decl.kind === 'const') {
        const v = this.evalExpr(decl.value, this.globals);
        this.globals.define(decl.name, v, true);
      }
    }
  }

  private report(e: unknown): void {
    const span = e instanceof RuntimeError ? e.span : null;
    this.diagnostics.push({
      code: 'NOVA5001',
      severity: 'error',
      message: e instanceof Error ? e.message : String(e),
      span: span ?? { file: '<runtime>', start: 0, end: 0, line: 1, col: 1 },
    });
  }

  // --- functions ----------------------------------------------------------

  private callFunction(name: string, args: Value[]): Value {
    const decl = this.fnDeclsByName.get(name);
    if (!decl) throw new RuntimeError(`undefined function '${name}'`, null);
    if (decl.params.length !== args.length) {
      throw new RuntimeError(
        `function '${name}' expects ${decl.params.length} arguments, got ${args.length}`,
        null,
      );
    }
    const env = new Env(this.globals);
    for (let i = 0; i < decl.params.length; i++) {
      env.define(decl.params[i]!.name, args[i] ?? null);
    }
    try {
      const block = decl.body;
      const lastStmt = block.stmts[block.stmts.length - 1];
      // Execute statements; if no tail, return null.
      for (const s of block.stmts) this.execStmt(s, env);
      if (block.tail) return this.evalExpr(block.tail, env);
      // Check for implicit-return from last expr-stmt
      if (lastStmt?.kind === 'expr') return this.evalExpr(lastStmt.expr, env);
      return null;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  // --- statements ---------------------------------------------------------

  private execBlock(block: HirExpr & { kind: 'block' }, env: Env): Value {
    for (const s of block.stmts) this.execStmt(s, env);
    if (block.tail) return this.evalExpr(block.tail, env);
    return null;
  }

  private execStmt(stmt: HirStmt, env: Env): void {
    switch (stmt.kind) {
      case 'expr': {
        const v = this.evalExpr(stmt.expr, env);
        // Top-level expression statements do not produce a tail value; only a
        // block's trailing expression (HirBlockExpr.tail) is returned.
        return;
      }
      case 'let': {
        const v = this.evalExpr(stmt.value, env);
        env.define(stmt.name, v);
        return;
      }
      case 'assign': {
        const v = this.evalExpr(stmt.value, env);
        env.assign(stmt.target.ident.name, v);
        return;
      }
      case 'field_assign': {
        const obj = this.evalExpr(stmt.obj, env);
        const v = this.evalExpr(stmt.value, env);
        if (obj !== null && typeof obj === 'object' && (obj as StructValue).tag === 'struct') {
          (obj as StructValue).fields.set(stmt.name, v);
          return;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          (obj as MapValue).entries.set(stmt.name, v);
          return;
        }
        throw new RuntimeError('can only assign to fields of structs and maps', stmt.span);
      }
      case 'index_assign': {
        const obj = this.evalExpr(stmt.obj, env);
        const idx = this.evalExpr(stmt.index, env);
        const v = this.evalExpr(stmt.value, env);
        if (obj !== null && typeof obj === 'object' && (obj as ArrayValue).tag === 'array') {
          const n = idx as number;
          if (!Number.isInteger(n)) throw new RuntimeError('array index must be integer', stmt.span);
          (obj as ArrayValue).items[n] = v;
          return;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          (obj as MapValue).entries.set(idx as string, v);
          return;
        }
        throw new RuntimeError('can only index-assign arrays and maps', stmt.span);
      }
      case 'if': {
        const cond = isTruthy(this.evalExpr(stmt.cond, env));
        if (cond) this.execBlock(stmt.then, env);
        else if (stmt.else) this.execBlock(stmt.else, env);
        return;
      }
      case 'while': {
        while (isTruthy(this.evalExpr(stmt.cond, env))) {
          try { this.execBlock(stmt.body, env); }
          catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'for': {
        const iter = this.evalExpr(stmt.iter, env);
        const items = this.iterItems(iter, stmt.span);
        for (const item of items) {
          const loopEnv = new Env(env);
          loopEnv.define(stmt.name, item);
          try { this.execBlock(stmt.body, loopEnv); }
          catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'match': {
        this.execMatch(stmt.subject, stmt.arms, env, stmt.span);
        return;
      }
      case 'return': {
        const v = stmt.value ? this.evalExpr(stmt.value, env) : null;
        throw new ReturnSignal(v);
      }
      case 'block': {
        this.execBlock(stmt as unknown as HirExpr & { kind: 'block' }, env);
        return;
      }
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
    }
  }

  private iterItems(v: Value, span: Span2): Value[] {
    if (v !== null && typeof v === 'object' && (v as ArrayValue).tag === 'array') return (v as ArrayValue).items;
    if (v !== null && typeof v === 'object' && (v as MapValue).tag === 'map') return [...(v as MapValue).entries.keys()];
    throw new RuntimeError('can only iterate over arrays and maps', span);
  }

  private execMatch(subject: HirExpr, arms: HirMatchArm[], env: Env, span: Span2): Value {
    const subjVal = this.evalExpr(subject, env);
    for (const arm of arms) {
      const armEnv = new Env(env);
      if (this.matchPattern(arm.pattern, subjVal, armEnv)) {
        return this.execBlock(arm.body, armEnv);
      }
    }
    return null;
  }

  private matchPattern(p: HirPattern, subj: Value, env: Env): boolean {
    switch (p.kind) {
      case 'wildcard': return true;
      case 'binding': env.define(p.name, subj); return true;
      case 'literal': return valuesEqual(subj, (p.value as HirLiteral).value as Value);
      case 'path':
        return subj !== null && typeof subj === 'object' &&
          (subj as EnumValue).tag === 'enum' &&
          (subj as EnumValue).enumName === p.enumName &&
          (subj as EnumValue).variant === p.variant;
      case 'some': {
        // Match Some(x) pattern: subject must be a 'some' value
        if (subj === null || typeof subj !== 'object' || (subj as OptionValue).tag !== 'some') return false;
        // If there's an inner pattern, match against the inner value
        if (p.inner) {
          return this.matchPattern(p.inner, (subj as OptionValue).value as Value, env);
        }
        return true;
      }
      case 'none': {
        // Match None pattern: subject must be a 'none' value
        return subj !== null && typeof subj === 'object' && (subj as OptionValue).tag === 'none';
      }
      case 'ok': {
        // Match Ok(x) pattern: subject must be a 'result' value with ok: true
        if (subj === null || typeof subj !== 'object' || (subj as ResultValue).tag !== 'result' || !(subj as ResultValue).ok) return false;
        // If there's an inner pattern, match against the inner value
        if (p.inner) {
          return this.matchPattern(p.inner, (subj as ResultValue).value as Value, env);
        }
        return true;
      }
      case 'err': {
        // Match Err(x) pattern: subject must be a 'result' value with ok: false
        if (subj === null || typeof subj !== 'object' || (subj as ResultValue).tag !== 'result' || (subj as ResultValue).ok) return false;
        // If there's an inner pattern, match against the inner value
        if (p.inner) {
          return this.matchPattern(p.inner, (subj as ResultValue).value as Value, env);
        }
        return true;
      }
      default: return false;
    }
  }

  // --- expressions --------------------------------------------------------

  evalExpr(expr: HirExpr, env: Env): Value {
    switch (expr.kind) {
      case 'lit': return expr.value as Value;
      case 'ident': {
        const v = env.get(expr.ident.name);
        if (v !== undefined) return v;
        // Enum name as a marker (for `Color.Red` construction syntax).
        if (this.enumVariants.has(expr.ident.name)) {
          return { __enumMarker: true, enumName: expr.ident.name } as unknown as Value;
        }
        throw new RuntimeError(`undefined variable '${expr.ident.name}'`, expr.span);
      }
      case 'binary': {
        const op = expr.op;
        if (op === 'and') {
          const l = this.evalExpr(expr.left, env);
          if (!isTruthy(l)) return false;
          return isTruthy(this.evalExpr(expr.right, env));
        }
        if (op === 'or') {
          const l = this.evalExpr(expr.left, env);
          if (isTruthy(l)) return true;
          return isTruthy(this.evalExpr(expr.right, env));
        }
        const l = this.evalExpr(expr.left, env);
        const r = this.evalExpr(expr.right, env);
        switch (op) {
          case '+': {
            if (typeof l === 'string' && typeof r === 'string') return l + r;
            if (typeof l === 'number' && typeof r === 'number') return l + r;
            throw new RuntimeError(`'+' expects two numbers or two strings`, expr.span);
          }
          case '-': return (l as number) - (r as number);
          case '*': return (l as number) * (r as number);
          case '/': return (l as number) / (r as number);
          case '%': return (l as number) % (r as number);
          case '==': return valuesEqual(l, r);
          case '!=': return !valuesEqual(l, r);
          case '<': return (l as number) < (r as number);
          case '<=': return (l as number) <= (r as number);
          case '>': return (l as number) > (r as number);
          case '>=': return (l as number) >= (r as number);
        }
        throw new RuntimeError(`unknown operator`, expr.span);
      }
      case 'unary': {
        const v = this.evalExpr(expr.expr, env);
        if (expr.op === '-') return -(v as number);
        return !isTruthy(v);
      }
      case 'call': return this.evalCall(expr, env);
      case 'field': {
        const obj = this.evalExpr(expr.obj, env);
        if (obj !== null && typeof obj === 'object' && (obj as StructValue).tag === 'struct') {
          const sv = obj as StructValue;
          if (!sv.fields.has(expr.name)) throw new RuntimeError(`struct '${sv.structName}' has no field '${expr.name}'`, expr.span);
          return sv.fields.get(expr.name) ?? null;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          return (obj as MapValue).entries.get(expr.name) ?? null;
        }
        // Enum marker: construct EnumValue.
        const marker = obj as { __enumMarker?: boolean; enumName?: string };
        if (marker && marker.__enumMarker && marker.enumName) {
          return { tag: 'enum', enumName: marker.enumName, variant: expr.name } satisfies EnumValue;
        }
        throw new RuntimeError(`cannot access field '${expr.name}'`, expr.span);
      }
      case 'index': {
        const obj = this.evalExpr(expr.obj, env);
        const idx = this.evalExpr(expr.index, env);
        if (obj !== null && typeof obj === 'object' && (obj as ArrayValue).tag === 'array') {
          const n = idx as number;
          if (!Number.isInteger(n)) throw new RuntimeError('array index must be integer', expr.span);
          if (n < 0 || n >= (obj as ArrayValue).items.length) throw new RuntimeError(`index ${n} out of bounds`, expr.span);
          return (obj as ArrayValue).items[n] ?? null;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          return (obj as MapValue).entries.get(idx as string) ?? null;
        }
        throw new RuntimeError('cannot index', expr.span);
      }
      case 'array': return { tag: 'array', items: expr.elements.map((e) => this.evalExpr(e, env)) } satisfies ArrayValue;
      case 'map': {
        const entries = new Map<string, Value>();
        for (const en of expr.entries) {
          const k = this.evalExpr(en.key, env);
          if (typeof k !== 'string') throw new RuntimeError('map keys must be strings', expr.span);
          entries.set(k, this.evalExpr(en.value, env));
        }
        return { tag: 'map', entries } satisfies MapValue;
      }
      case 'propagate': {
        const v = this.evalExpr(expr.expr, env);
        if (v !== null && typeof v === 'object' && (v as ResultValue).tag === 'result') {
          const r = v as ResultValue;
          if (r.ok) return r.value;
          throw new ReturnSignal(r);
        }
        if (v === null) throw new ReturnSignal(null);
        return v;
      }
      case 'ok': return { tag: 'result', ok: true, value: expr.value ? this.evalExpr(expr.value, env) : null } satisfies ResultValue;
      case 'error': return { tag: 'result', ok: false, value: expr.value ? this.evalExpr(expr.value, env) : '' } satisfies ResultValue;
      case 'some': return { tag: 'some', value: expr.value ? this.evalExpr(expr.value, env) : null } satisfies OptionValue;
      case 'none': return { tag: 'none' } satisfies OptionValue;
      case 'closure': {
        const cv: ClosureValue = {
          tag: 'closure',
          params: expr.params,
          body: expr.body,
          env,
        };
        return cv;
      }
      case 'block': return this.execBlock(expr, env);
      case 'match_expr': {
        const subjVal = this.evalExpr(expr.subject, env);
        for (const arm of expr.arms) {
          const armEnv = new Env(env);
          if (this.matchPattern(arm.pattern, subjVal, armEnv)) {
            return this.execBlock(arm.body, armEnv);
          }
        }
        return null;
      }
      case 'if_expr': {
        const cond = isTruthy(this.evalExpr(expr.cond, env));
        return cond ? this.evalExpr(expr.then, env) : this.evalExpr(expr.else, env);
      }
    }
  }

  private evalCall(expr: Extract<HirExpr, { kind: 'call' }>, env: Env): Value {
    const args = expr.args.map((a) => this.evalExpr(a.value, env));
    // User-defined function call: callee is an ident not shadowed locally.
    if (expr.callee.kind === 'ident' && !env.has(expr.callee.ident.name) && this.fnDeclsByName.has(expr.callee.ident.name)) {
      return this.callFunction(expr.callee.ident.name, args);
    }
    // Struct constructor: struct names are uppercase.
    if (expr.callee.kind === 'ident' && !env.has(expr.callee.ident.name) && this.structFields.has(expr.callee.ident.name)) {
      return this.constructStruct(expr.callee.ident.name, expr, args);
    }
    const callee = this.evalExpr(expr.callee, env);
    if (callee !== null && typeof callee === 'object') {
      if ((callee as NativeFnValue).tag === 'native') return (callee as NativeFnValue).call(args, expr.span);
      if ((callee as ClosureValue).tag === 'closure') {
        const c = callee as ClosureValue;
        if (args.length !== c.params.length) {
          throw new RuntimeError(`closure expects ${c.params.length} args, got ${args.length}`, expr.span);
        }
        const callEnv = new Env(c.env);
        for (let i = 0; i < c.params.length; i++) callEnv.define(c.params[i]!.name, args[i]!);
        try { return this.execBlock(c.body, callEnv); }
        catch (e) { if (e instanceof ReturnSignal) return e.value; throw e; }
      }
    }
    throw new RuntimeError('value is not callable', expr.span);
  }

  private constructStruct(name: string, expr: Extract<HirExpr, { kind: 'call' }>, args: Value[]): StructValue {
    const order = this.structFields.get(name)!;
    const fields = new Map<string, Value>();
    let pos = 0;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i]!;
      if (arg.name) {
        if (!order.includes(arg.name)) throw new RuntimeError(`struct '${name}' has no field '${arg.name}'`, arg.value.span);
        fields.set(arg.name, args[i]!);
      } else {
        const f = order[pos++];
        if (f === undefined) throw new RuntimeError(`too many arguments for struct '${name}'`, arg.value.span);
        fields.set(f, args[i]!);
      }
    }
    for (const f of order) if (!fields.has(f)) fields.set(f, null);
    return { tag: 'struct', structName: name, fields };
  }

  // --- natives -------------------------------------------------------------

  private installNatives(): void {
    defineNatives((name, _sig, call) => {
      this.globals.define(name, { tag: 'native', name, call } satisfies NativeFnValue);
    });
  }
}

// ----------------------------------------------------------------------------
// Shared native functions.
//
// The natives are defined once here and shared by the HIR interpreter and the
// MIR reference interpreter so that both observe identical builtin semantics.
// ----------------------------------------------------------------------------

export type NativeCall = (args: Value[], span: Span2) => Value;

export function defineNatives(def: (name: string, sig: { ret: HirType }, call: NativeCall) => void): void {
  def('print', { ret: { kind: 'void' } }, (args) => {
      process.stdout.write(args.map(stringify).join(' '));
      return null;
    });
    def('println', { ret: { kind: 'void' } }, (args) => {
      process.stdout.write(args.map(stringify).join(' ') + '\n');
      return null;
    });
    def('len', { ret: { kind: 'prim', name: 'Int' } }, (args, span) => {
      const v = args[0] ?? null;
      if (typeof v === 'string') return v.length;
      if (v !== null && typeof v === 'object') {
        if ((v === 'object' ? v : v) && (v as ArrayValue).tag === 'array') return (v as ArrayValue).items.length;
        if ((v as MapValue).tag === 'map') return (v as MapValue).entries.size;
        if ((v as StructValue).tag === 'struct') return (v as StructValue).fields.size;
      }
      throw new RuntimeError('len() expects string/array/map/struct', span);
    });
    def('str', { ret: { kind: 'prim', name: 'String' } }, (args) => stringify(args[0] ?? null));
    def('int', { ret: { kind: 'prim', name: 'Int' } }, (args, span) => {
      const v = args[0] ?? null;
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
      throw new RuntimeError(`int() cannot convert ${stringify(v)}`, span);
    });
    def('float', { ret: { kind: 'prim', name: 'Float' } }, (args, span) => {
      const v = args[0] ?? null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
      throw new RuntimeError(`float() cannot convert ${stringify(v)}`, span);
    });
    def('abs', { ret: { kind: 'prim', name: 'Float' } }, (args) => Math.abs(args[0] as number));
    def('min', { ret: { kind: 'prim', name: 'Float' } }, (args) => Math.min(...(args as number[])));
    def('max', { ret: { kind: 'prim', name: 'Float' } }, (args) => Math.max(...(args as number[])));
    def('sqrt', { ret: { kind: 'prim', name: 'Float' } }, (args) => Math.sqrt(args[0] as number));
    def('floor', { ret: { kind: 'prim', name: 'Int' } }, (args) => Math.floor(args[0] as number));
    def('ceil', { ret: { kind: 'prim', name: 'Int' } }, (args) => Math.ceil(args[0] as number));
    def('round', { ret: { kind: 'prim', name: 'Int' } }, (args) => Math.round(args[0] as number));
    def('pow', { ret: { kind: 'prim', name: 'Float' } }, (args) => Math.pow(args[0] as number, args[1] as number));
    def('random', { ret: { kind: 'prim', name: 'Float' } }, () => Math.random());
    def('random_int', { ret: { kind: 'prim', name: 'Int' } }, (args) => {
      const lo = args[0] as number, hi = args[1] as number;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    });
    def('range', { ret: { kind: 'array', element: { kind: 'prim', name: 'Int' } } }, (args, span) => {
      const n = args[0] as number;
      if (!Number.isInteger(n) || n < 0) throw new RuntimeError(`range() expects non-negative Int`, span);
      return { tag: 'array', items: Array.from({ length: n }, (_, i) => i) } satisfies ArrayValue;
    });
    def('push', { ret: { kind: 'void' } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`push() expects array`, span);
      (a as ArrayValue).items.push(args[1] ?? null);
      return null;
    });
    def('pop', { ret: { kind: 'prim', name: 'Null' } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`pop() expects array`, span);
      const arr = (a as ArrayValue).items;
      if (arr.length === 0) throw new RuntimeError('pop() on empty array', span);
      return arr.pop()!;
    });
    def('first', { ret: { kind: 'prim', name: 'Null' } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`first() expects array`, span);
      const arr = (a as ArrayValue).items;
      if (arr.length === 0) throw new RuntimeError('first() on empty array', span);
      return arr[0]!;
    });
    def('last', { ret: { kind: 'prim', name: 'Null' } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`last() expects array`, span);
      const arr = (a as ArrayValue).items;
      if (arr.length === 0) throw new RuntimeError('last() on empty array', span);
      return arr[arr.length - 1]!;
    });
    def('slice', { ret: { kind: 'prim', name: 'Null' } }, (args, span) => {
      const v = args[0] ?? null, start = args[1] as number, end = args[2] as number;
      if (typeof v === 'string') return v.slice(start, end);
      if (v !== null && typeof v === 'object' && (v as ArrayValue).tag === 'array') {
        return { tag: 'array', items: (v as ArrayValue).items.slice(start, end) } satisfies ArrayValue;
      }
      throw new RuntimeError(`slice() expects string or array`, span);
    });
    def('contains', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const v = args[0] ?? null, item = args[1] ?? null;
      if (typeof v === 'string' && typeof item === 'string') return v.includes(item);
      if (v !== null && typeof v === 'object' && (v as ArrayValue).tag === 'array') {
        return (v as ArrayValue).items.some((x) => valuesEqual(x, item));
      }
      throw new RuntimeError(`contains() expects string or array`, span);
    });
    def('join', { ret: { kind: 'prim', name: 'String' } }, (args, span) => {
      const a = args[0];
      const sep = (args[1] as string) ?? '';
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`join() expects array`, span);
      return (a as ArrayValue).items.map(stringify).join(sep);
    });
    def('reverse', { ret: { kind: 'array', element: { kind: 'prim', name: 'Null' } } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`reverse() expects array`, span);
      return { tag: 'array', items: [...(a as ArrayValue).items].reverse() } satisfies ArrayValue;
    });
    def('sort', { ret: { kind: 'array', element: { kind: 'prim', name: 'Null' } } }, (args, span) => {
      const a = args[0];
      if (a === null || typeof a !== 'object' || (a as ArrayValue).tag !== 'array') throw new RuntimeError(`sort() expects array`, span);
      const items = [...(a as ArrayValue).items];
      items.sort((x, y) => {
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        if (typeof x === 'string' && typeof y === 'string') return x.localeCompare(y);
        return 0;
      });
      return { tag: 'array', items } satisfies ArrayValue;
    });
    def('keys', { ret: { kind: 'array', element: { kind: 'prim', name: 'String' } } }, (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as MapValue).tag !== 'map') throw new RuntimeError(`keys() expects map`, span);
      return { tag: 'array', items: [...(m as MapValue).entries.keys()] } satisfies ArrayValue;
    });
    def('values', { ret: { kind: 'array', element: { kind: 'prim', name: 'Null' } } }, (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as MapValue).tag !== 'map') throw new RuntimeError(`values() expects map`, span);
      return { tag: 'array', items: [...(m as MapValue).entries.values()] } satisfies ArrayValue;
    });
    def('has', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as MapValue).tag !== 'map') throw new RuntimeError(`has() expects map`, span);
      return (m as MapValue).entries.has(args[1] as string);
    });
    def('remove', { ret: { kind: 'void' } }, (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as MapValue).tag !== 'map') throw new RuntimeError(`remove() expects map`, span);
      (m as MapValue).entries.delete(args[1] as string);
      return null;
    });
    def('merge', { ret: { kind: 'map', key: { kind: 'prim', name: 'String' }, value: { kind: 'prim', name: 'Null' } } }, (args, span) => {
      const m1 = args[0], m2 = args[1];
      if (m1 === null || typeof m1 !== 'object' || (m1 as MapValue).tag !== 'map') throw new RuntimeError(`merge() expects two maps`, span);
      if (m2 === null || typeof m2 !== 'object' || (m2 as MapValue).tag !== 'map') throw new RuntimeError(`merge() expects two maps`, span);
      return { tag: 'map', entries: new Map([...(m1 as MapValue).entries, ...(m2 as MapValue).entries]) } satisfies MapValue;
    });
    def('expect', { ret: { kind: 'void' } }, (args, span) => {
      const v = args[0];
      if (v !== true) throw new RuntimeError(`expectation failed`, span);
      return null;
    });
    def('expect_eq', { ret: { kind: 'void' } }, (args, span) => {
      if (!valuesEqual(args[0] ?? null, args[1] ?? null)) {
        throw new RuntimeError(`expectation failed: ${stringify(args[0])} != ${stringify(args[1])}`, span);
      }
      return null;
    });
    def('clock_ms', { ret: { kind: 'prim', name: 'Int' } }, () => Date.now());
    def('sleep_ms', { ret: { kind: 'void' } }, (args) => {
      const ms = typeof args[0] === 'number' ? Math.max(0, Math.trunc(args[0])) : 0;
      if (ms > 0) {
        // Blocking sleep without timers: parks the host thread, mirroring the
        // native `Sleep` call in the LLVM runtime.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, true, ms);
      }
      return null;
    });
    def('exit', { ret: { kind: 'void' } }, (args) => {
      const code = typeof args[0] === 'number' ? Math.trunc(args[0]) : 0;
      throw new NovaExitSignal(code);
    });
    def('panic', { ret: { kind: 'void' } }, (args) => {
      const msg = args.length > 0 ? args.map(stringify).join(' ') : 'panic';
      throw new NovaPanicSignal(msg);
    });
    def('env_has', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const name = args[0];
      if (typeof name !== 'string') throw new RuntimeError('env_has() expects a String name', span);
      return process.env[name] !== undefined;
    });
    def('env_get', { ret: { kind: 'optional', inner: { kind: 'prim', name: 'String' } } }, (args, span) => {
      const name = args[0];
      if (typeof name !== 'string') throw new RuntimeError('env_get() expects a String name', span);
      const value = process.env[name];
      if (value === undefined) return { tag: 'none' } satisfies OptionValue;
      return { tag: 'some', value } satisfies OptionValue;
    });
    def('args', { ret: { kind: 'array', element: { kind: 'prim', name: 'String' } } }, () => {
      return { tag: 'array', items: process.argv.slice(2) } satisfies ArrayValue;
    });
    def('file_exists', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') throw new RuntimeError('file_exists() expects a String path', span);
      return fs.existsSync(p);
    });
    def('file_read', { ret: { kind: 'result', ok: { kind: 'prim', name: 'String' }, err: { kind: 'prim', name: 'String' } } }, (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') throw new RuntimeError('file_read() expects a String path', span);
      try {
        return { tag: 'result', ok: true, value: fs.readFileSync(p, 'utf8') } satisfies ResultValue;
      } catch {
        return { tag: 'result', ok: false, value: '' } satisfies ResultValue;
      }
    });
    def('file_write', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const p = args[0], d = args[1];
      if (typeof p !== 'string' || typeof d !== 'string') throw new RuntimeError('file_write() expects two String arguments (path, data)', span);
      try {
        fs.writeFileSync(p, d, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    def('file_delete', { ret: { kind: 'prim', name: 'Bool' } }, (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') throw new RuntimeError('file_delete() expects a String path', span);
      try {
        fs.unlinkSync(p);
        return true;
      } catch {
        return false;
      }
    });
    def('typeof', { ret: { kind: 'prim', name: 'String' } }, (args) => {
      const v = args[0] ?? null;
      if (v === null) return 'null';
      if (typeof v === 'boolean') return 'Bool';
      if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float';
      if (typeof v === 'string') return 'String';
      if (typeof v === 'object') {
        switch ((v as { tag: string }).tag) {
          case 'array': return 'Array';
          case 'map': return 'Map';
          case 'struct': return 'Struct';
          case 'enum': return 'Enum';
          case 'result': return 'Result';
          case 'some':
          case 'none': return 'Option';
          case 'closure':
          case 'native': return 'Fn';
        }
      }
      return 'unknown';
    });
}

export function runHir(module: HirModule, symbols: SymbolTables): RunResult {
  const interp = new HirInterpreter(module, symbols);
  const code = interp.run();
  return { exitCode: code, diagnostics: interp.getDiagnostics() };
}