import type { Block, Expr, MatchStmt, Stmt } from '../compiler/ast/ast.ts';
import type { Program } from '../compiler/ast/ast.ts';
import type { Diagnostic, Span2 } from '../compiler/diagnostics/diagnostics.ts';
import type { ConstInfo, EnumInfo, FnInfo, NominalInfo, StructInfo } from '../compiler/typechecker/checker.ts';
import { NovaExitSignal, NovaPanicSignal } from './signals.ts';
import * as fs from 'node:fs';

/**
 * NOVA tree-walking interpreter.
 *
 * Used by `nova run` for instant startup. Values map directly to host
 * representations; NOVA-specific values are tagged plain objects.
 */

export type NovaValue =
  | null
  | boolean
  | number
  | string
  | NovaArray
  | NovaMap
  | StructValue
  | EnumValue
  | ResultValue
  | SomeValue
  | NoneValue
  | NovaClosure
  | NativeFnValue;

export interface SomeValue {
  tag: 'some';
  value: NovaValue;
}

export interface NoneValue {
  tag: 'none';
}

export interface NovaArray {
  tag: 'array';
  items: NovaValue[];
}

export interface NovaMap {
  tag: 'map';
  entries: Map<string, NovaValue>;
}

export interface StructValue {
  tag: 'struct';
  structName: string;
  fields: Map<string, NovaValue>;
}

export interface EnumValue {
  tag: 'enum';
  enumName: string;
  variant: string;
}

export interface ResultValue {
  tag: 'result';
  ok: boolean;
  value: NovaValue;
}

export interface NovaClosure {
  tag: 'closure';
  name: string;
  params: string[];
  body: Block;
  env: Env;
}

export interface NativeFnValue {
  tag: 'native';
  name: string;
  call: (args: NovaValue[], span: Span2) => NovaValue;
}

export class Env {
  private vars = new Map<string, { value: NovaValue; isConst: boolean }>();
  private readonly parent: Env | null;

  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  get(name: string): NovaValue | undefined {
    let env: Env | null = this;
    while (env) {
      const found = env.vars.get(name);
      if (found) return found.value;
      env = env.parent;
    }
    return undefined;
  }

  has(name: string): boolean {
    let env: Env | null = this;
    while (env) {
      if (env.vars.has(name)) return true;
      env = env.parent;
    }
    return false;
  }

  define(name: string, value: NovaValue, isConst = false): void {
    this.vars.set(name, { value, isConst });
  }

  assign(name: string, value: NovaValue): void {
    let env: Env | null = this;
    while (env) {
      const found = env.vars.get(name);
      if (found) {
        if (found.isConst) {
          throw new NovaRuntimeError(`cannot assign to constant '${name}'`, null);
        }
        found.value = value;
        return;
      }
      env = env.parent;
    }
    throw new NovaRuntimeError(`undefined variable '${name}'`, null);
  }
}

export class ReturnSignal {
  readonly value: NovaValue;
  constructor(value: NovaValue) {
    this.value = value;
  }
}

export class BreakSignal {}
export class ContinueSignal {}

/** Runtime error with an optional source span; becomes a NOVA5xxx diagnostic. */
export class NovaRuntimeError extends Error {
  readonly span: Span2 | null;
  constructor(message: string, span: Span2 | null) {
    super(message);
    this.span = span;
    this.name = 'NovaRuntimeError';
  }
}

export function stringify(v: NovaValue): string {
  if (v === null || v === undefined) return 'null';
  // Check for Option markers
  if (typeof v === 'object' && v !== null) {
    if ((v as { __option?: boolean }).__option) {
      const inner = (v as { value: NovaValue }).value;
      return inner === null ? 'None' : `Some(${stringify(inner)})`;
    }
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    if (v.tag === 'some') return `Some(${stringify((v as { value: NovaValue }).value)})`;
    if (v.tag === 'none') return 'None';
  }
  if (v.tag === 'array') return `[${v.items.map(stringify).join(', ')}]`;
  if (v.tag === 'map') {
    return `{${[...v.entries].map(([k, val]) => `${k}: ${stringify(val)}`).join(', ')}}`;
  }
  if (v.tag === 'struct') {
    return `${v.structName}(${[...v.fields].map(([k, val]) => `${k}: ${stringify(val)}`).join(', ')})`;
  }
  if (v.tag === 'enum') return `${v.enumName}.${v.variant}`;
  if (v.tag === 'result') return v.ok ? `ok(${stringify(v.value)})` : `err(${stringify(v.value)})`;
  if (v.tag === 'closure') return `<fn ${v.name}>`;
  return `<native fn ${v.name}>`;
}


export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

/** Runs a checked NOVA program. */
export class Interpreter {
  private globals = new Env();
  private diagnostics: Diagnostic[] = [];
  private readonly structs: Map<string, StructInfo>;
  private readonly enums: Map<string, EnumInfo>;
  private readonly fns: Map<string, FnInfo>;
  private readonly consts: Map<string, ConstInfo>;
  private readonly programs: Program[];
  private readonly fnDeclsByName = new Map<string, Extract<Program['decls'][number], { kind: 'fn' }>>();

  constructor(
    programs: Program[],
    symbols: {
      structs: Map<string, StructInfo>;
      enums: Map<string, EnumInfo>;
      nominals: Map<string, NominalInfo>;
      fns: Map<string, FnInfo>;
      consts: Map<string, ConstInfo>;
    },
  ) {
    this.programs = programs;
    this.structs = symbols.structs;
    this.enums = symbols.enums;
    this.nominals = symbols.nominals;
    this.fns = symbols.fns;
    this.consts = symbols.consts;
    this.installNatives();
  }

  private error(message: string, span: Span2 | null): never {
    throw new NovaRuntimeError(message, span);
  }

  // ------------------------------------------------------------- entry points

  /** Execute top-level statements, then `main()`. Returns the exit code. */
  run(): number {
    try {
      this.executeTopLevel();
      if (this.fns.has('main')) {
        this.callFunction('main', [], null);
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

  /** Run every `test` declaration. */
  runTests(): TestResult[] {
    const results: TestResult[] = [];
    for (const prog of this.programs) {
      for (const decl of prog.decls) {
        if (decl.kind !== 'test') continue;
        try {
          this.executeTopLevelOnce();
          this.executeBlock(decl.body, new Env(this.globals));
          results.push({ name: decl.name, passed: true });
        } catch (e) {
          results.push({ name: decl.name, passed: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return results;
  }

  private topLevelExecuted = false;

  private executeTopLevelOnce(): void {
    if (this.topLevelExecuted) return;
    this.topLevelExecuted = true;
    this.executeTopLevel();
  }

  private executeTopLevel(): void {
    for (const prog of this.programs) {
      for (const decl of prog.decls) {
        if (decl.kind === 'const') {
          this.globals.define(decl.name, this.evalExpr(decl.value, this.globals), true);
        } else if (
          decl.kind === 'assign' || decl.kind === 'expr' || decl.kind === 'if' ||
          decl.kind === 'while' || decl.kind === 'for' || decl.kind === 'match' ||
          decl.kind === 'block'
        ) {
          this.executeStmt(decl, this.globals);
        }
      }
    }
  }

  private report(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    const span = e instanceof NovaRuntimeError ? e.span : null;
    this.diagnostics.push({
      code: e instanceof NovaRuntimeError ? 'NOVA5001' : 'NOVA0500',
      severity: 'error',
      message: e instanceof NovaRuntimeError ? `${message}${span ? ` at ${span.line}:${span.col}` : ''}` : `internal error: ${message}`,
      span: span ?? { file: '<runtime>', start: 0, end: 0, line: 1, col: 1 },
    });
  }

  getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  // ---------------------------------------------------------------- functions

  private callFunction(name: string, args: NovaValue[], span: Span2 | null): NovaValue {
    const fn = this.fns.get(name);
    if (!fn) this.error(`undefined function '${name}'`, span);
    const decl = this.findFnDecl(name);
    if (!decl) this.error(`undefined function '${name}'`, span);
    const env = new Env(this.globals);
    for (let i = 0; i < fn.params.length; i++) {
      env.define(fn.params[i]!.name, args[i] ?? null);
    }
    try {
      return this.executeBlock(decl.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
  }

  private findFnDecl(name: string): Extract<Program['decls'][number], { kind: 'fn' }> {
    const cached = this.fnDeclsByName.get(name);
    if (cached) return cached;
    for (const prog of this.programs) {
      for (const d of prog.decls) {
        if (d.kind === 'fn' && d.name === name) {
          this.fnDeclsByName.set(name, d);
          return d;
        }
      }
    }
    this.error(`undefined function '${name}'`, null);
  }


  // -------------------------------------------------------------- statements

  private executeBlock(block: Block, env: Env): NovaValue {
    const blockEnv = new Env(env);
    let result: NovaValue = null;
    for (const stmt of block.stmts) {
      result = this.executeStmt(stmt, blockEnv);
    }
    return result;
  }

  private executeStmt(stmt: Stmt, env: Env): NovaValue {
    switch (stmt.kind) {
      case 'assign': {
        const value = this.evalExpr(stmt.value, env);
        if (stmt.target.kind === 'ident') {
          if (stmt.isDeclaration || !env.has(stmt.target.name)) {
            env.define(stmt.target.name, value);
          } else {
            env.assign(stmt.target.name, value);
          }
          return value;
        }
        if (stmt.target.kind === 'field') {
          const obj = this.evalExpr(stmt.target.obj, env);
          if (obj !== null && typeof obj === 'object') {
            if ((obj as StructValue).tag === 'struct') {
              const sv = obj as StructValue;
              if (!sv.fields.has(stmt.target.name)) {
                this.error(`struct '${sv.structName}' has no field '${stmt.target.name}'`, stmt.span);
              }
              sv.fields.set(stmt.target.name, value);
              return value;
            }
            if ((obj as NovaMap).tag === 'map') {
              (obj as NovaMap).entries.set(stmt.target.name, value);
              return value;
            }
          }
          this.error('can only assign to fields of structs and maps', stmt.span);
        }
        if (stmt.target.kind === 'index') {
          const obj = this.evalExpr(stmt.target.obj, env);
          const index = this.evalExpr(stmt.target.index, env);
          if (obj !== null && typeof obj === 'object' && (obj as NovaArray).tag === 'array') {
            if (typeof index !== 'number' || !Number.isInteger(index)) {
              this.error('array index must be an integer', stmt.span);
            }
            const arr = (obj as NovaArray).items;
            if (index < 0 || index >= arr.length) {
              this.error(`array index ${index} out of bounds (length ${arr.length})`, stmt.span);
            }
            arr[index] = value;
            return value;
          }
          if (obj !== null && typeof obj === 'object' && (obj as NovaMap).tag === 'map') {
            if (typeof index !== 'string') this.error('map keys must be strings', stmt.span);
            (obj as NovaMap).entries.set(index, value);
            return value;
          }
          this.error('can only index arrays and maps', stmt.span);
        }
        this.error('invalid assignment target', stmt.span);
        return value;
      }
      case 'expr':
        return this.evalExpr(stmt.expr, env);
      case 'if': {
        if (this.truthy(this.evalExpr(stmt.cond, env), stmt.span)) {
          return this.executeBlock(stmt.then, env);
        } else if (stmt.else) {
          return this.executeBlock(stmt.else, env);
        }
        return null;
      }
      case 'while': {
        while (this.truthy(this.evalExpr(stmt.cond, env), stmt.span)) {
          try {
            this.executeBlock(stmt.body, env);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }
      case 'for': {
        const iterable = this.evalExpr(stmt.iter, env);
        let items: NovaValue[];
        if (iterable !== null && typeof iterable === 'object' && (iterable as NovaArray).tag === 'array') {
          items = (iterable as NovaArray).items;
        } else if (iterable !== null && typeof iterable === 'object' && (iterable as NovaMap).tag === 'map') {
          items = [...(iterable as NovaMap).entries.keys()];
        } else {
          this.error('can only iterate over arrays and maps', stmt.span);
          return null;
        }
        for (const item of items) {
          const loopEnv = new Env(env);
          loopEnv.define(stmt.name, item);
          try {
            this.executeBlock(stmt.body, loopEnv);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return null;
      }
      case 'match': {
        return this.executeMatch(stmt, env);
      }
      case 'return': {
        const value = stmt.value ? this.evalExpr(stmt.value, env) : null;
        throw new ReturnSignal(value);
      }
      case 'block':
        return this.executeBlock(stmt.block, env);
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
    }
  }

  private executeMatch(stmt: MatchStmt, env: Env): NovaValue {
    const subject = this.evalExpr(stmt.subject, env);
    for (const arm of stmt.arms) {
      const p = arm.pattern;
      const armEnv = new Env(env);
      let matched = false;
      if (p.kind === 'wildcard') {
        matched = true;
      } else if (p.kind === 'literal') {
        const literal = this.evalExpr(p.expr, armEnv);
        matched = this.valuesEqual(subject, literal);
      } else if (p.kind === 'path') {
        matched = subject !== null && typeof subject === 'object' &&
          (subject as EnumValue).tag === 'enum' &&
          (subject as EnumValue).enumName === p.name &&
          (!p.variant || (subject as EnumValue).variant === p.variant);
      } else if (p.kind === 'binding') {
        armEnv.define(p.name, subject);
        matched = true;
      } else if (p.kind === 'some') {
        // Some(pattern): subject must be Some(value); optional inner binding.
        if (subject !== null && typeof subject === 'object' && (subject as SomeValue).tag === 'some') {
          const inner = (subject as SomeValue).value as NovaValue;
          if (p.inner?.kind === 'binding') armEnv.define(p.inner.name!, inner);
          else if (p.inner?.kind === 'wildcard') { /* no binding */ }
          matched = true;
        }
      } else if (p.kind === 'none') {
        matched = subject !== null && typeof subject === 'object' && (subject as NoneValue).tag === 'none';
      } else if (p.kind === 'ok') {
        // ok(pattern): subject must be OkResult(value); optional inner binding.
        if (subject !== null && typeof subject === 'object' &&
            (subject as ResultValue).tag === 'result' && (subject as ResultValue).ok) {
          const inner = (subject as ResultValue).value as NovaValue;
          if (p.inner?.kind === 'binding') armEnv.define(p.inner.name!, inner);
          else if (p.inner?.kind === 'wildcard') { /* no binding */ }
          matched = true;
        }
      } else if (p.kind === 'err') {
        // err(pattern): subject must be ErrResult(value); optional inner binding.
        if (subject !== null && typeof subject === 'object' &&
            (subject as ResultValue).tag === 'result' && !(subject as ResultValue).ok) {
          const inner = (subject as ResultValue).value as NovaValue;
          if (p.inner?.kind === 'binding') armEnv.define(p.inner.name!, inner);
          else if (p.inner?.kind === 'wildcard') { /* no binding */ }
          matched = true;
        }
      }
      if (matched) {
        return this.executeBlock(arm.body, armEnv);
      }
    }
    return null;
  }

  private truthy(v: NovaValue, span: Span2 | null): boolean {
    if (typeof v === 'boolean') return v;
    this.error(`expected Bool, found ${stringify(v)}`, span);
  }

  private valuesEqual(a: NovaValue, b: NovaValue): boolean {
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return a === b;
    if (typeof a === 'object' && typeof b === 'object') {
      if ((a as EnumValue).tag === 'enum' && (b as EnumValue).tag === 'enum') {
        const ea = a as EnumValue;
        const eb = b as EnumValue;
        return ea.enumName === eb.enumName && ea.variant === eb.variant;
      }
      if ((a as StructValue).tag === 'struct' && (b as StructValue).tag === 'struct') {
        const sa = a as StructValue;
        const sb = b as StructValue;
        if (sa.structName !== sb.structName) return false;
        for (const [k, v] of sa.fields) {
          if (!sb.fields.has(k) || !this.valuesEqual(v, sb.fields.get(k)!)) return false;
        }
        return true;
      }
      if ((a as ResultValue).tag === 'result' && (b as ResultValue).tag === 'result') {
        const ra = a as ResultValue;
        const rb = b as ResultValue;
        return ra.ok === rb.ok && this.valuesEqual(ra.value, rb.value);
      }
      if ((a as NovaArray).tag === 'array' && (b as NovaArray).tag === 'array') {
        const aa = (a as NovaArray).items;
        const ab = (b as NovaArray).items;
        return aa.length === ab.length && aa.every((v, i) => this.valuesEqual(v, ab[i]!));
      }
    }
    return a === b;
  }

  // ------------------------------------------------------------ expressions

  evalExpr(expr: Expr, env: Env): NovaValue {
    switch (expr.kind) {
      case 'int':
      case 'float':
        return expr.value;
      case 'string': {
        let out = '';
        for (const part of expr.parts) {
          if (part.kind === 'text') out += part.text;
          else out += stringify(this.evalExpr(part.expr, env));
        }
        return out;
      }
      case 'bool':
        return expr.value;
      case 'null':
        return null;
      case 'ident': {
        const value = env.get(expr.name);
        if (value !== undefined) return value;
        // Check if it's an enum name — return a marker for field access
        if (this.enums.has(expr.name)) {
          return { __enumMarker: true, enumName: expr.name } as unknown as NovaValue;
        }
        this.error(`undefined variable '${expr.name}'`, expr.span);
        return null;
      }
      case 'unary': {
        if (expr.op === '-') {
          const v = this.evalExpr(expr.expr, env);
          if (typeof v !== 'number') this.error(`unary '-' requires a number, found ${stringify(v)}`, expr.span);
          return -v;
        }
        const v = this.evalExpr(expr.expr, env);
        if (typeof v !== 'boolean') this.error(`'not' requires a Bool, found ${stringify(v)}`, expr.span);
        return !v;
      }
      case 'binary':
        return this.evalBinary(expr, env);
      case 'field': {
        const obj = this.evalExpr(expr.obj, env);
        if (obj !== null && typeof obj === 'object') {
          if ((obj as StructValue).tag === 'struct') {
            const sv = obj as StructValue;
            if (!sv.fields.has(expr.name)) {
              this.error(`struct '${sv.structName}' has no field '${expr.name}'`, expr.span);
            }
            return sv.fields.get(expr.name)!;
          }
          if ((obj as NovaMap).tag === 'map') {
            return (obj as NovaMap).entries.get(expr.name) ?? null;
          }
          // Enum marker: create EnumValue from enumName.variant
          const marker = obj as { __enumMarker?: boolean; enumName?: string };
          if (marker.__enumMarker && marker.enumName) {
            const enumInfo = this.enums.get(marker.enumName);
            if (enumInfo && enumInfo.variants.has(expr.name)) {
              return { tag: 'enum', enumName: marker.enumName, variant: expr.name };
            }
            this.error(`enum '${marker.enumName}' has no variant '${expr.name}'`, expr.span);
            return null;
          }
        }
        this.error(`cannot access field '${expr.name}' on ${stringify(obj)}`, expr.span);
        return null;
      }
      case 'index': {
        const obj = this.evalExpr(expr.obj, env);
        const index = this.evalExpr(expr.index, env);
        if (obj !== null && typeof obj === 'object' && (obj as NovaArray).tag === 'array') {
          if (typeof index !== 'number' || !Number.isInteger(index)) {
            this.error('array index must be an integer', expr.span);
          }
          const arr = (obj as NovaArray).items;
          if (index < 0 || index >= arr.length) {
            this.error(`array index ${index} out of bounds (length ${arr.length})`, expr.span);
          }
          return arr[index]!;
        }
        if (obj !== null && typeof obj === 'object' && (obj as NovaMap).tag === 'map') {
          if (typeof index !== 'string') this.error('map keys must be strings', expr.span);
          return (obj as NovaMap).entries.get(index) ?? null;
        }
        this.error(`cannot index into ${stringify(obj)}`, expr.span);
        return null;
      }
      case 'array':
        return { tag: 'array', items: expr.elements.map((el) => this.evalExpr(el, env)) };
      case 'map': {
        const entries = new Map<string, NovaValue>();
        for (const entry of expr.entries) {
          const key = this.evalExpr(entry.key, env);
          if (typeof key !== 'string') this.error('map keys must be strings', expr.span);
          entries.set(key, this.evalExpr(entry.value, env));
        }
        return { tag: 'map', entries };
      }
      case 'call':
        return this.evalCall(expr, env);
      case 'propagate': {
        const inner = this.evalExpr(expr.expr, env);
        if (inner !== null && typeof inner === 'object' && (inner as ResultValue).tag === 'result') {
          const r = inner as ResultValue;
          if (r.ok) return r.value;
          throw new ReturnSignal(r); // propagate Err upward
        }
        if (inner === null) {
          throw new ReturnSignal(null); // propagate null optional upward
        }
        return inner;
      }
      case 'ok': {
        const value = expr.value ? this.evalExpr(expr.value, env) : null;
        return { tag: 'result', ok: true, value };
      }
      case 'error': {
        const value = expr.value ? this.evalExpr(expr.value, env) : '';
        return { tag: 'result', ok: false, value };
      }
      case 'some': {
        const value = expr.value ? this.evalExpr(expr.value, env) : null;
        return { tag: 'some', value };
      }
      case 'none': {
        return { tag: 'none' };
      }
      case 'closure': {
        return {
          tag: 'closure',
          name: '<closure>',
          params: expr.params.map((p) => p.name),
          body: expr.body,
          env,
        } satisfies NovaClosure;
      }
    }
  }


  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>, env: Env): NovaValue {
    const op = expr.op;
    // Short-circuit logical operators.
    if (op === 'and' || op === 'or') {
      const left = this.evalExpr(expr.left, env);
      if (typeof left !== 'boolean') this.error(`'${op}' requires Bools, found ${stringify(left)}`, expr.span);
      if (op === 'and' && !left) return false;
      if (op === 'or' && left) return true;
      const right = this.evalExpr(expr.right, env);
      if (typeof right !== 'boolean') this.error(`'${op}' requires Bools, found ${stringify(right)}`, expr.span);
      return right;
    }

    const left = this.evalExpr(expr.left, env);
    const right = this.evalExpr(expr.right, env);

    switch (op) {
      case '+': {
        if (typeof left === 'string' && typeof right === 'string') return left + right;
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        this.error(`operator '+' requires two numbers or two strings, found ${stringify(left)} and ${stringify(right)}`, expr.span);
        return null;
      }
      case '-':
      case '*':
      case '/':
      case '%': {
        if (typeof left !== 'number' || typeof right !== 'number') {
          this.error(`operator '${op}' requires numbers, found ${stringify(left)} and ${stringify(right)}`, expr.span);
        }
        switch (op) {
          case '-': return left - right;
          case '*': return left * right;
          case '/':
            if (right === 0) this.error('division by zero', expr.span);
            return left / right;
          case '%':
            if (right === 0) this.error('modulo by zero', expr.span);
            return left % right;
        }
        return null;
      }
      case '==': return this.valuesEqual(left, right);
      case '!=': return !this.valuesEqual(left, right);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (typeof left !== 'number' || typeof right !== 'number') {
          this.error(`operator '${op}' requires numbers, found ${stringify(left)} and ${stringify(right)}`, expr.span);
        }
        switch (op) {
          case '<': return left < right;
          case '<=': return left <= right;
          case '>': return left > right;
          case '>=': return left >= right;
        }
        return null;
      }
    }
    this.error(`unknown operator '${op}'`, expr.span);
    return null;
  }

  private evalCall(expr: Extract<Expr, { kind: 'call' }>, env: Env): NovaValue {
    // Evaluate arguments in source order.
    const args = expr.args.map((a) => this.evalExpr(a.value, env));

    // Struct constructor.
    if (expr.callee.kind === 'ident' && !env.has(expr.callee.name) && this.structs.has(expr.callee.name)) {
      return this.constructStruct(expr.callee.name, expr, args, env);
    }

    // Top-level named function call (plain or generic: `foo(...)` / `foo<T>(...)`).
    if (
      (expr.callee.kind === 'ident' || expr.callee.kind === 'generic') &&
      !env.has(expr.callee.name) && this.fns.has(expr.callee.name)
    ) {
      return this.callFunction(expr.callee.name, args, expr.span);
    }

    const callee = this.evalExpr(expr.callee, env);
    if (callee !== null && typeof callee === 'object') {
      if ((callee as NativeFnValue).tag === 'native') {
        return (callee as NativeFnValue).call(args, expr.span);
      }
      if ((callee as NovaClosure).tag === 'closure') {
        const closure = callee as NovaClosure;
        if (args.length !== closure.params.length) {
          this.error(`function '${closure.name}' expects ${closure.params.length} arguments, got ${args.length}`, expr.span);
        }
        const callEnv = new Env(closure.env);
        for (let i = 0; i < closure.params.length; i++) {
          callEnv.define(closure.params[i]!, args[i]!);
        }
        try {
          return this.executeBlock(closure.body, callEnv);
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        }
      }
    }
    this.error(`value ${stringify(callee)} is not callable`, expr.callee.span);
    return null;
  }

  private constructStruct(
    name: string,
    expr: Extract<Expr, { kind: 'call' }>,
    args: NovaValue[],
    env: Env,
  ): NovaValue {
    const info = this.structs.get(name)!;
    const fields = new Map<string, NovaValue>();
    let positional = 0;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i]!;
      if (arg.name) {
        if (!info.fields.has(arg.name)) {
          this.error(`struct '${name}' has no field '${arg.name}'`, arg.value.span);
        }
        fields.set(arg.name, args[i]!);
      } else {
        const fieldName = [...info.fields.keys()][positional];
        if (fieldName === undefined) {
          this.error(`too many arguments for struct '${name}'`, arg.value.span);
        }
        fields.set(fieldName!, args[i]!);
        positional++;
      }
    }
    for (const fieldName of info.fields.keys()) {
      if (!fields.has(fieldName)) fields.set(fieldName, null);
    }
    return { tag: 'struct', structName: name, fields };
  }


  // ---------------------------------------------------------------- natives

  private native(name: string, call: (args: NovaValue[], span: Span2) => NovaValue): void {
    this.globals.define(name, { tag: 'native', name, call });
  }

  private installNatives(): void {
    this.native('print', (args) => {
      process.stdout.write(args.map(stringify).join(' '));
      return null;
    });
    this.native('println', (args) => {
      process.stdout.write(args.map(stringify).join(' ') + '\n');
      return null;
    });
    this.native('len', (args, span) => {
      const v = args[0] ?? null;
      if (v !== null && typeof v === 'object') {
        if ((v as NovaArray).tag === 'array') return (v as NovaArray).items.length;
        if ((v as NovaMap).tag === 'map') return (v as NovaMap).entries.size;
        if ((v as StructValue).tag === 'struct') return (v as StructValue).fields.size;
      }
      if (typeof v === 'string') return v.length;
      this.error(`len() expects a string, array, map or struct, found ${stringify(v)}`, span);
      return null;
    });
    this.native('str', (args) => stringify(args[0] ?? null));
    this.native('int', (args, span) => {
      const v = args[0] ?? null;
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
      this.error(`int() cannot convert ${stringify(v)}`, span);
      return null;
    });
    this.native('float', (args, span) => {
      const v = args[0] ?? null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
      this.error(`float() cannot convert ${stringify(v)}`, span);
      return null;
    });
    this.native('abs', (args) => Math.abs(args[0] as number));
    this.native('min', (args) => Math.min(...(args as number[])));
    this.native('max', (args) => Math.max(...(args as number[])));
    this.native('sqrt', (args) => Math.sqrt(args[0] as number));
    this.native('range', (args, span) => {
      const n = args[0];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        this.error(`range() expects a non-negative Int, found ${stringify(n)}`, span);
      }
      return { tag: 'array', items: Array.from({ length: n }, (_, i) => i) };
    });
    this.native('push', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`push() expects an array, found ${stringify(arr)}`, span);
      }
      (arr as NovaArray).items.push(args[1] ?? null);
      return null;
    });
    this.native('keys', (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as NovaMap).tag !== 'map') {
        this.error(`keys() expects a map, found ${stringify(m)}`, span);
      }
      return { tag: 'array', items: [...(m as NovaMap).entries.keys()] };
    });
    this.native('values', (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as NovaMap).tag !== 'map') {
        this.error(`values() expects a map, found ${stringify(m)}`, span);
      }
      return { tag: 'array', items: [...(m as NovaMap).entries.values()] };
    });
    this.native('has', (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as NovaMap).tag !== 'map') {
        this.error(`has() expects a map, found ${stringify(m)}`, span);
      }
      return (m as NovaMap).entries.has(args[1] as string);
    });
    this.native('remove', (args, span) => {
      const m = args[0];
      if (m === null || typeof m !== 'object' || (m as NovaMap).tag !== 'map') {
        this.error(`remove() expects a map, found ${stringify(m)}`, span);
      }
      (m as NovaMap).entries.delete(args[1] as string);
      return null;
    });
    this.native('expect', (args, span) => {
      const v = args[0];
      if (v !== true) {
        this.error(`expectation failed: expected true, found ${stringify(v)}`, span);
      }
      return null;
    });
    this.native('expect_eq', (args, span) => {
      if (!this.valuesEqual(args[0] ?? null, args[1] ?? null)) {
        this.error(`expectation failed: ${stringify(args[0] ?? null)} != ${stringify(args[1] ?? null)}`, span);
      }
      return null;
    });
    this.native('clock_ms', () => Date.now());
    this.native('sleep_ms', (args) => {
      const ms = typeof args[0] === 'number' ? Math.max(0, Math.trunc(args[0])) : 0;
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, true, ms);
      return null;
    });
    this.native('exit', (args) => {
      const code = typeof args[0] === 'number' ? Math.trunc(args[0]) : 0;
      throw new NovaExitSignal(code);
    });
    this.native('panic', (args) => {
      const msg = args.length > 0 ? args.map(stringify).join(' ') : 'panic';
      throw new NovaPanicSignal(msg);
    });
    this.native('env_has', (args, span) => {
      const name = args[0];
      if (typeof name !== 'string') this.error('env_has() expects a String name', span);
      return process.env[name] !== undefined;
    });
    this.native('env_get', (args, span) => {
      const name = args[0];
      if (typeof name !== 'string') this.error('env_get() expects a String name', span);
      const value = process.env[name];
      if (value === undefined) return { tag: 'none' };
      return { tag: 'some', value };
    });
    this.native('args', () => ({ tag: 'array', items: process.argv.slice(2) }));
    this.native('file_exists', (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') this.error('file_exists() expects a String path', span);
      return fs.existsSync(p);
    });
    this.native('file_read', (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') this.error('file_read() expects a String path', span);
      try {
        return { tag: 'result', ok: true, value: fs.readFileSync(p, 'utf8') };
      } catch {
        return { tag: 'result', ok: false, value: '' };
      }
    });
    this.native('file_write', (args, span) => {
      const p = args[0], d = args[1];
      if (typeof p !== 'string' || typeof d !== 'string') this.error('file_write() expects two String arguments (path, data)', span);
      try {
        fs.writeFileSync(p, d, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    this.native('file_delete', (args, span) => {
      const p = args[0];
      if (typeof p !== 'string') this.error('file_delete() expects a String path', span);
      try {
        fs.unlinkSync(p);
        return true;
      } catch {
        return false;
      }
    });
    this.native('input', (args, span) => {
      const prompt = typeof args[0] === 'string' ? args[0] : '';
      const line = globalThis.prompt?.(prompt);
      if (line === undefined) this.error('input() is not available in this environment', span);
      return line ?? '';
    });
    this.native('typeof', (args) => {
      const v = args[0] ?? null;
      if (v === null) return 'null';
      if (typeof v === 'boolean') return 'Bool';
      if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float';
      if (typeof v === 'string') return 'String';
      if (typeof v === 'object') {
        if (v.tag === 'array') return 'Array';
        if (v.tag === 'map') return 'Map';
        if (v.tag === 'struct') return 'Struct';
        if (v.tag === 'enum') return 'Enum';
        if (v.tag === 'result') return 'Result';
        if (v.tag === 'closure' || v.tag === 'native') return 'Fn';
      }
      return 'Unknown';
    });
    this.native('pop', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`pop() expects an array, found ${stringify(arr)}`, span);
      }
      const a = arr as NovaArray;
      if (a.items.length === 0) this.error('pop() on empty array', span);
      return a.items.pop()!;
    });
    this.native('first', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`first() expects an array, found ${stringify(arr)}`, span);
      }
      const a = arr as NovaArray;
      if (a.items.length === 0) this.error('first() on empty array', span);
      return a.items[0]!;
    });
    this.native('last', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`last() expects an array, found ${stringify(arr)}`, span);
      }
      const a = arr as NovaArray;
      if (a.items.length === 0) this.error('last() on empty array', span);
      return a.items[a.items.length - 1]!;
    });
    this.native('slice', (args, span) => {
      const v = args[0] ?? null;
      const start = args[1] as number;
      const end = args[2] as number;
      if (typeof v === 'string') return v.slice(start, end);
      if (v !== null && typeof v === 'object' && (v as NovaArray).tag === 'array') {
        return { tag: 'array', items: (v as NovaArray).items.slice(start, end) };
      }
      this.error(`slice() expects a string or array, found ${stringify(v)}`, span);
      return null;
    });
    this.native('contains', (args, span) => {
      const v = args[0] ?? null;
      const item = args[1] ?? null;
      if (typeof v === 'string' && typeof item === 'string') return v.includes(item);
      if (v !== null && typeof v === 'object' && (v as NovaArray).tag === 'array') {
        return (v as NovaArray).items.some((x) => this.valuesEqual(x, item));
      }
      this.error(`contains() expects a string or array, found ${stringify(v)}`, span);
      return false;
    });
    this.native('join', (args, span) => {
      const arr = args[0];
      const sep = (args[1] as string) ?? '';
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`join() expects an array, found ${stringify(arr)}`, span);
      }
      return (arr as NovaArray).items.map(stringify).join(sep);
    });
    this.native('floor', (args) => Math.floor(args[0] as number));
    this.native('ceil', (args) => Math.ceil(args[0] as number));
    this.native('round', (args) => Math.round(args[0] as number));
    this.native('pow', (args) => Math.pow(args[0] as number, args[1] as number));
    this.native('random', () => Math.random());
    this.native('random_int', (args) => {
      const lo = args[0] as number;
      const hi = args[1] as number;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    });
    this.native('reverse', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`reverse() expects an array, found ${stringify(arr)}`, span);
      }
      return { tag: 'array', items: [...(arr as NovaArray).items].reverse() };
    });
    this.native('sort', (args, span) => {
      const arr = args[0];
      if (arr === null || typeof arr !== 'object' || (arr as NovaArray).tag !== 'array') {
        this.error(`sort() expects an array, found ${stringify(arr)}`, span);
      }
      const items = [...(arr as NovaArray).items];
      items.sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
        return 0;
      });
      return { tag: 'array', items };
    });
    this.native('merge', (args, span) => {
      const m1 = args[0];
      const m2 = args[1];
      if (m1 === null || typeof m1 !== 'object' || (m1 as NovaMap).tag !== 'map') {
        this.error(`merge() expects two maps, found ${stringify(m1)}`, span);
      }
      if (m2 === null || typeof m2 !== 'object' || (m2 as NovaMap).tag !== 'map') {
        this.error(`merge() expects two maps, found ${stringify(m2)}`, span);
      }
      return { tag: 'map', entries: new Map([...(m1 as NovaMap).entries, ...(m2 as NovaMap).entries]) };
    });
    this.native('typeof', (args) => {
      const v = args[0] ?? null;
      if (v === null) return 'null';
      if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float';
      if (typeof v === 'string') return 'String';
      if (typeof v === 'boolean') return 'Bool';
      if (typeof v === 'object') {
        if ((v as NovaArray).tag === 'array') return 'Array';
        if ((v as NovaMap).tag === 'map') return 'Map';
        if ((v as StructValue).tag === 'struct') return 'Struct';
        if ((v as EnumValue).tag === 'enum') return 'Enum';
        if ((v as ResultValue).tag === 'result') return 'Result';
      }
      return 'unknown';
    });
    // Option<T> constructors: Some(value) wraps a value, None represents absence
    this.native('Some', (args) => {
      const v = args[0] ?? null;
      // Mark as Some by wrapping in a special object
      return { __option: true, value: v } as unknown as NovaValue;
    });
    this.native('None', () => {
      // None is represented as an Option marker with null value
      return { __option: true, value: null } as unknown as NovaValue;
    });
  }

  private valuesEqual(a: NovaValue, b: NovaValue): boolean {
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    if (a.tag === 'enum' && b.tag === 'enum') return a.enumName === b.enumName && a.variant === b.variant;
    if (a.tag === 'struct' && b.tag === 'struct') {
      if (a.structName !== b.structName) return false;
      if (a.fields.size !== b.fields.size) return false;
      for (const [k, v] of a.fields) {
        if (!b.fields.has(k) || !this.valuesEqual(v, b.fields.get(k)!)) return false;
      }
      return true;
    }
    if (a.tag === 'result' && b.tag === 'result') return a.ok === b.ok && this.valuesEqual(a.value, b.value);
    if (a.tag === 'array' && b.tag === 'array') {
      if (a.items.length !== b.items.length) return false;
      return a.items.every((v, i) => this.valuesEqual(v, b.items[i]!));
    }
    return a === b;
  }
}
