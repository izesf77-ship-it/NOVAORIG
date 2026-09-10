import type { Block, Expr, Program, Stmt, TypeExpr } from '../ast/ast.ts';
import type { Span2 } from '../lexer/token.ts';
import type { Diagnostic } from '../diagnostics/diagnostics.ts';
import {
  isAssignable, isNumeric, typeToString, T_BOOL, T_INT, T_STRING,
  T_UNKNOWN, T_VOID, T_NULL, type NovaType,
} from './types.ts';

/**
 * Symbol information gathered by the checker. Kept public so tooling
 * (`nova symbols --json`, LSP) can introspect programs.
 */

export interface FieldInfo {
  name: string;
  type: NovaType;
  span: Span2;
}

export interface StructInfo {
  name: string;
  fields: Map<string, FieldInfo>;
  span: Span2;
}

export interface EnumInfo {
  name: string;
  variants: Map<string, Span2>;
  span: Span2;
}

export interface FnInfo {
  name: string;
  typeParams: string[];  // Generic type parameter names
  params: { name: string; type: NovaType; span: Span2 }[];
  ret: NovaType;
  hasDeclaredRet: boolean;
  span: Span2;
}

export interface ConstInfo {
  name: string;
  type: NovaType;
  span: Span2;
}

export interface VarBinding {
  type: NovaType;
  span: Span2;
  isConst: boolean;
  read: boolean;
}

/** Declared signatures of built-in (native) functions. */
export const NATIVE_SIGNATURES: Readonly<Record<string, { params: string; ret: NovaType }>> = {
  print: { params: 'any', ret: T_VOID },
  println: { params: 'any', ret: T_VOID },
  len: { params: 'any', ret: T_INT },
  str: { params: 'any', ret: T_STRING },
  int: { params: 'any', ret: T_INT },
  float: { params: 'any', ret: { kind: 'prim', name: 'Float' } },
  abs: { params: 'numeric', ret: T_UNKNOWN },
  min: { params: 'numeric', ret: T_UNKNOWN },
  max: { params: 'numeric', ret: T_UNKNOWN },
  range: { params: 'int', ret: { kind: 'array', element: T_INT } },
  push: { params: 'any', ret: T_VOID },
  pop: { params: 'any', ret: T_UNKNOWN },
  first: { params: 'any', ret: T_UNKNOWN },
  last: { params: 'any', ret: T_UNKNOWN },
  slice: { params: 'any', ret: T_UNKNOWN },
  contains: { params: 'any', ret: T_BOOL },
  join: { params: 'any', ret: T_STRING },
  keys: { params: 'any', ret: { kind: 'array', element: T_UNKNOWN } },
  values: { params: 'any', ret: { kind: 'array', element: T_UNKNOWN } },
  has: { params: 'any', ret: T_BOOL },
  remove: { params: 'any', ret: T_VOID },
  merge: { params: 'any', ret: T_UNKNOWN },
  expect: { params: 'bool', ret: T_VOID },
  expect_eq: { params: 'any', ret: T_VOID },
  input: { params: 'int', ret: T_STRING },
  clock_ms: { params: 'int', ret: T_INT },
  sleep_ms: { params: 'any', ret: T_VOID },
  exit: { params: 'any', ret: T_VOID },
  panic: { params: 'any', ret: T_VOID },
  env_has: { params: 'any', ret: T_BOOL },
  env_get: { params: 'any', ret: { kind: 'optional', inner: T_STRING } },
  args: { params: 'any', ret: { kind: 'array', element: T_STRING } },
  file_exists: { params: 'any', ret: T_BOOL },
  file_read: { params: 'any', ret: { kind: 'result', ok: T_STRING, err: T_STRING } },
  file_write: { params: 'any', ret: T_BOOL },
  file_delete: { params: 'any', ret: T_BOOL },
  sqrt: { params: 'numeric', ret: { kind: 'prim', name: 'Float' } },
  floor: { params: 'numeric', ret: T_INT },
  ceil: { params: 'numeric', ret: T_INT },
  round: { params: 'numeric', ret: T_INT },
  pow: { params: 'numeric', ret: { kind: 'prim', name: 'Float' } },
  random: { params: 'int', ret: { kind: 'prim', name: 'Float' } },
  random_int: { params: 'int', ret: T_INT },
  reverse: { params: 'any', ret: { kind: 'array', element: T_UNKNOWN } },
  sort: { params: 'any', ret: { kind: 'array', element: T_UNKNOWN } },
  typeof: { params: 'any', ret: T_STRING },
  Some: { params: 'any', ret: { kind: 'optional', inner: T_UNKNOWN } },
  None: { params: 'any', ret: { kind: 'optional', inner: T_UNKNOWN } },
};


/**
 * The NOVA type checker.
 *
 * Also performs name resolution (undefined names, duplicate declarations)
 * and annotates `assign` statements that introduce new bindings.
 */
export interface NominalInfo {
  name: string;
  inner: NovaType;
  span: Span2;
}

export class Checker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly exprTypes = new Map<Expr, NovaType>();
  private readonly structs = new Map<string, StructInfo>();
  private readonly enums = new Map<string, EnumInfo>();
  private readonly nominals = new Map<string, NominalInfo>();
  private readonly fns = new Map<string, FnInfo>();
  private readonly consts = new Map<string, ConstInfo>();
  private scopes: Map<string, VarBinding>[] = [];
  private currentFn: FnInfo | null = null;
  private currentTypeParams: string[] = [];
  private readonly programs: Program[];

  constructor(programs: Program[]) {
    this.programs = programs;
  }

    /** Run all phases; returns gathered symbols for tooling. */
  check(): {
    diagnostics: Diagnostic[];
    structs: Map<string, StructInfo>;
    enums: Map<string, EnumInfo>;
    nominals: Map<string, NominalInfo>;
    fns: Map<string, FnInfo>;
    consts: Map<string, ConstInfo>;
    exprTypes: Map<Expr, NovaType>;
  } {
    this.collectDecls();
    this.checkBodies();
    return {
      diagnostics: this.diagnostics,
      structs: this.structs,
      enums: this.enums,
      nominals: this.nominals,
      fns: this.fns,
      consts: this.consts,
      exprTypes: this.exprTypes,
    };
  }

  private error(code: string, message: string, span: Span2, help?: string): void {
    this.diagnostics.push({ code, severity: 'error', message, span: { file: this.currentFile ?? span.file ?? '', ...span }, help });
  }

  private warn(code: string, message: string, span: Span2, help?: string): void {
    this.diagnostics.push({ code, severity: 'warning', message, span: { file: this.currentFile ?? span.file ?? '', ...span }, help });
  }

  private currentFile: string | undefined;

  // ------------------------------------------------------------- declarations

  private collectDecls(): void {
    for (const prog of this.programs) {
      this.currentFile = prog.file;
      for (const decl of prog.decls) {
        switch (decl.kind) {
          case 'struct': this.declareStruct(decl); break;
          case 'enum': this.declareEnum(decl); break;
          case 'fn': this.declareFn(decl); break;
          case 'type': this.declareNominal(decl); break;
          default: break;
        }
      }
    }
    for (const prog of this.programs) {
      this.currentFile = prog.file;
      for (const decl of prog.decls) {
        if (decl.kind === 'const') this.declareConst(decl);
      }
    }
    this.currentFile = undefined;
  }

  private declareNominal(decl: { kind: 'type'; name: string; inner: TypeExpr; span: Span2 }): void {
    if (this.nominals.has(decl.name)) {
      this.error('NOVA3008', `type '${decl.name}' is already declared`, decl.span);
      return;
    }
    // Resolve inner type
    const inner = this.resolveType(decl.inner);
    this.nominals.set(decl.name, { name: decl.name, inner, span: decl.span });
  }

  private resolveType(t: TypeExpr): NovaType {
    switch (t.kind) {
      case 'named': {
        const name = t.name;
        // Check if it's a type parameter (generic)
        if (this.currentTypeParams.includes(name)) {
          return { kind: 'var', id: this.currentTypeParams.indexOf(name) };
        }
        // Check primitives
        if (name === 'Int') return T_INT;
        if (name === 'Float') return T_FLOAT;
        if (name === 'String') return T_STRING;
        if (name === 'Bool') return T_BOOL;
        if (name === 'Null') return T_NULL;
        // Check built-in generic types: Option<T>, Result<T, E>
        if (name === 'Option') {
          const inner = t.args.length > 0 ? this.resolveType(t.args[0]!) : T_UNKNOWN;
          return { kind: 'optional', inner };
        }
        if (name === 'Result') {
          const ok = t.args.length > 0 ? this.resolveType(t.args[0]!) : T_UNKNOWN;
          const err = t.args.length > 1 ? this.resolveType(t.args[1]!) : T_UNKNOWN;
          return { kind: 'result', ok, err };
        }
        // Check structs
        if (this.structs.has(name)) return { kind: 'struct', name };
        // Check enums
        if (this.enums.has(name)) return { kind: 'enum', name };
        // Check nominals
        const nominal = this.nominals.get(name);
        if (nominal) return nominal.inner;
        // Unknown
        return { kind: 'prim', name: 'Unknown' };
      }
      case 'optional': {
        return { kind: 'optional', inner: this.resolveType(t.inner) };
      }
      case 'result': {
        // Nested result type expression (rare)
        return { kind: 'result', ok: T_UNKNOWN, err: T_UNKNOWN };
      }
      default:
        return T_UNKNOWN;
    }
  }


  private declareName(
    table: Map<string, { span: Span2 }>,
    kind: string,
    name: string,
    span: Span2,
  ): boolean {
    const existing = table.get(name);
    if (existing) {
      this.error(
        'NOVA3001',
        `duplicate ${kind} '${name}'`,
        span,
        `a ${kind} with this name is already declared`,
      );
      return false;
    }
    table.set(name, { span });
    return true;
  }

  private declareStruct(decl: Extract<Program['decls'][number], { kind: 'struct' }>): void {
    this.declareName(this.structs as unknown as Map<string, { span: Span2 }>, 'struct', decl.name, decl.span);
    const fields = new Map<string, FieldInfo>();
    for (const field of decl.fields) {
      if (fields.has(field.name)) {
        this.error('NOVA3001', `duplicate field '${field.name}' in struct '${decl.name}'`, field.span);
        continue;
      }
      fields.set(field.name, { name: field.name, type: this.resolveType(field.type), span: field.span });
    }
    this.structs.set(decl.name, { name: decl.name, fields, span: decl.span });
  }

  private declareEnum(decl: Extract<Program['decls'][number], { kind: 'enum' }>): void {
    this.declareName(this.enums as unknown as Map<string, { span: Span2 }>, 'enum', decl.name, decl.span);
    const variants = new Map<string, Span2>();
    for (const v of decl.variants) variants.set(v.name, v.span);
    this.enums.set(decl.name, { name: decl.name, variants, span: decl.span });
  }

  private declareFn(decl: Extract<Program['decls'][number], { kind: 'fn' }>): void {
    this.declareName(this.fns as unknown as Map<string, { span: Span2 }>, 'function', decl.name, decl.span);
    // Set type parameter scope for resolving generic types
    this.currentTypeParams = decl.typeParams;
    const params = decl.params.map((p) => ({
      name: p.name,
      type: p.type ? this.resolveType(p.type) : T_UNKNOWN,
      span: p.span,
    }));
    const ret = decl.ret ? this.resolveType(decl.ret) : T_UNKNOWN;
    this.fns.set(decl.name, {
      name: decl.name, typeParams: decl.typeParams, params, ret,
      hasDeclaredRet: decl.ret !== undefined,
      span: decl.span,
    });
    this.currentTypeParams = [];
  }

  private declareConst(decl: Extract<Program['decls'][number], { kind: 'const' }>): void {
    if (!this.declareName(this.consts as unknown as Map<string, { span: Span2 }>, 'constant', decl.name, decl.span)) {
      return;
    }
    const annotated = decl.annot ? this.resolveType(decl.annot) : undefined;
    const valueType = this.checkExpr(decl.value);
    if (annotated && !isAssignable(valueType, annotated)) {
      this.error(
        'NOVA4002',
        `constant '${decl.name}' is declared as ${typeToString(annotated)}, but its value is ${typeToString(valueType)}`,
        decl.span,
      );
    }
    this.consts.set(decl.name, { name: decl.name, type: annotated ?? valueType, span: decl.span });
  }

  /** Resolve a syntactic type annotation into a semantic type. */
  resolveType(t: TypeExpr): NovaType {
    if (t.kind === 'optional') {
      return { kind: 'optional', inner: this.resolveType(t.inner) };
    }
    if (t.kind === 'func') {
      return {
        kind: 'fn',
        params: t.params.map((p) => ({ name: '', type: this.resolveType(p) })),
        ret: this.resolveType(t.ret),
      };
    }
    const name = t.name;
    // Generic type parameter in scope: `fn identity<T>(value: T)`.
    if (this.currentTypeParams.includes(name) && t.args.length === 0) {
      return { kind: 'var', id: this.currentTypeParams.indexOf(name) };
    }
    if (['Int', 'Float', 'String', 'Bool', 'Null'].includes(name) && t.args.length === 0) {
      return { kind: 'prim', name: name as 'Int' | 'Float' | 'String' | 'Bool' | 'Null' };
    }
    if (name === 'Void') return T_VOID;
    if (name === 'Array' && t.args.length === 1) {
      return { kind: 'array', element: this.resolveType(t.args[0]!) };
    }
    if (name === 'Map' && t.args.length === 2) {
      return { kind: 'map', key: this.resolveType(t.args[0]!), value: this.resolveType(t.args[1]!) };
    }
    if (name === 'Option' && t.args.length === 1) {
      return { kind: 'optional', inner: this.resolveType(t.args[0]!) };
    }
    if (name === 'Result' && t.args.length === 2) {
      return { kind: 'result', ok: this.resolveType(t.args[0]!), err: this.resolveType(t.args[1]!) };
    }
    if (this.nominals.has(name)) {
      const nom = this.nominals.get(name)!;
      if (t.args.length > 0) {
        return { kind: 'generic', name, args: t.args.map((a) => this.resolveType(a)) };
      }
      return { kind: 'nominal', name, inner: nom.inner };
    }
    if (this.structs.has(name)) return { kind: 'struct', name };
    if (this.enums.has(name)) return { kind: 'enum', name };
    this.error('NOVA3003', `unknown type '${name}'`, t.span, 'declare the type with `struct` or `enum`, or use a built-in type');
    return T_UNKNOWN;
  }


  // ------------------------------------------------------------------ bodies

  private checkBodies(): void {
    // Top-level statements of each file run before `main` (script style).
    for (const prog of this.programs) {
      this.currentFile = prog.file;
      for (const decl of prog.decls) {
        if (this.isStmt(decl)) {
          this.currentFn = null;
          this.pushScope();
          this.checkStmt(decl);
          this.popScope();
        }
      }
    }
    for (const prog of this.programs) {
      this.currentFile = prog.file;
      for (const decl of prog.decls) {
        if (decl.kind === 'fn') this.checkFnBody(this.fns.get(decl.name)!, decl.body);
        if (decl.kind === 'test') {
          this.pushScope();
          for (const stmt of decl.body.stmts) this.checkStmt(stmt);
          this.popScope();
        }
      }
    }
    this.currentFile = undefined;
  }

  private isStmt(n: unknown): n is Stmt {
    return typeof n === 'object' && n !== null && 'kind' in n &&
      ['assign', 'expr', 'if', 'while', 'for', 'return', 'match', 'block', 'break', 'continue']
        .includes((n as { kind: string }).kind);
  }

private checkFnBody(fn: FnInfo, body: Block): void {
    const savedFn = this.currentFn;
    this.currentFn = fn;
    this.pushScope();
    for (const p of fn.params) {
      this.declareVar(p.name, p.type, p.span, false);
    }
    for (const stmt of body.stmts) this.checkStmt(stmt);
    this.popScope();
    this.currentFn = savedFn;
    // Validate the implicit return value (tail expression) against the
    // declared return type, when a type annotation was provided and the body
    // actually ends in a value-producing expression.
    if (fn.hasDeclaredRet && fn.ret.kind !== 'unknown') {
      const stmts = body.stmts;
      const last = stmts[stmts.length - 1];
      if (last && last.kind === 'expr') {
        const tail = this.exprTypes.get(last.expr);
        if (tail && tail.kind !== 'unknown' && !isAssignable(tail, fn.ret) && !isAssignable(fn.ret, tail)) {
          this.error(
            'NOVA4003',
            `function '${fn.name}' returns ${typeToString(fn.ret)}, but body has type ${typeToString(tail)}`,
            body.span,
          );
        }
      }
    }

  }

  // ------------------------------------------------------------- statements

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    const scope = this.scopes.pop();
    if (scope) {
      for (const [name, binding] of scope) {
        if (!binding.read && !name.startsWith('_')) {
          this.warn('NOVA6001', `unused variable '${name}'`, binding.span, "prefix the name with '_' to silence this warning");
        }
      }
    }
  }

  private lookup(name: string): VarBinding | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private declareVar(name: string, type: NovaType, span: Span2, isConst: boolean): void {
    this.scopes[this.scopes.length - 1]!.set(name, { type, span, isConst, read: false });
  }

  private checkStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'assign': this.checkAssign(stmt); break;
      case 'expr':
        this.checkExpr(stmt.expr);
        break;
      case 'if': {
        this.requireBool(this.checkExpr(stmt.cond), 'if condition', stmt.cond.span);
        this.checkBlock(stmt.then);
        if (stmt.else) this.checkBlock(stmt.else);
        break;
      }
      case 'while': {
        this.requireBool(this.checkExpr(stmt.cond), 'while condition', stmt.cond.span);
        this.checkBlock(stmt.body);
        break;
      }
      case 'for': {
        const iterType = this.checkExpr(stmt.iter);
        let elementType: NovaType = T_UNKNOWN;
        if (iterType.kind === 'array') elementType = iterType.element;
        else if (iterType.kind === 'map') elementType = iterType.key;
        else if (iterType.kind !== 'unknown') {
          this.error('NOVA4007', `cannot iterate over value of type ${typeToString(iterType)}`, stmt.iter.span, 'for-in works on arrays (elements) and maps (keys)');
        }
        this.pushScope();
        this.declareVar(stmt.name, elementType, stmt.span, false);
        this.checkBlock(stmt.body);
        this.popScope();
        break;
      }
      case 'return': {
        const fn = this.currentFn;
        if (!fn) {
          this.error('NOVA3004', '`return` outside of a function', stmt.span);
          break;
        }
        const valueType = stmt.value ? this.checkExpr(stmt.value) : T_VOID;
        if (fn.hasDeclaredRet && !isAssignable(valueType, fn.ret)) {
          this.error(
            'NOVA4003',
            `function '${fn.name}' returns ${typeToString(fn.ret)}, but this statement returns ${typeToString(valueType)}`,
            stmt.span,
          );
        }
        break;
      }
      case 'match': this.checkMatch(stmt); break;
      case 'block': this.checkBlock(stmt.block); break;
      case 'break':
      case 'continue': break;
    }
  }

  private checkBlock(block: { stmts: Stmt[] }): void {
    this.pushScope();
    for (const stmt of block.stmts) this.checkStmt(stmt);
    this.popScope();
  }

  private requireBool(t: NovaType, what: string, span: Span2): void {
    if (t.kind !== 'unknown' && !(t.kind === 'prim' && t.name === 'Bool')) {
      this.error('NOVA4001', `${what} must be Bool, found ${typeToString(t)}`, span);
    }
  }

  private requireInt(t: NovaType, what: string, span: Span2): void {
    if (t.kind !== 'unknown' && !(t.kind === 'prim' && t.name === 'Int')) {
      this.error('NOVA4001', `${what} must be Int, found ${typeToString(t)}`, span);
    }
  }



  private checkAssign(stmt: Extract<Stmt, { kind: 'assign' }>): void {
    const valueType = this.checkExpr(stmt.value);

    if (stmt.target.kind === 'ident') {
      const name = stmt.target.name;
      const existing = this.lookup(name);
      if (existing && !stmt.annot) {
        existing.read = true;
        if (existing.isConst) {
          this.error('NOVA3005', `cannot assign to constant '${name}'`, stmt.span);
          return;
        }
        if (!isAssignable(valueType, existing.type)) {
          this.error(
            'NOVA4004',
            `cannot assign ${typeToString(valueType)} to '${name}' of type ${typeToString(existing.type)}`,
            stmt.value.span,
          );
        }
        return;
      }
      // New declaration (possibly annotated).
      let type: NovaType = T_UNKNOWN;
      if (stmt.annot) {
        type = this.resolveType(stmt.annot);
        if (!isAssignable(valueType, type)) {
          this.error(
            'NOVA4002',
            `variable '${name}' is declared as ${typeToString(type)}, but its value is ${typeToString(valueType)}`,
            stmt.value.span,
          );
        }
      } else {
        type = valueType;
      }
      stmt.isDeclaration = true;
      this.declareVar(name, type, stmt.target.span, false);
      return;
    }

    // Field assignment: obj.field = value
    if (stmt.target.kind === 'field') {
      const objType = this.checkExpr(stmt.target.obj);
      if (objType.kind === 'struct') {
        const info = this.structs.get(objType.name);
        const field = info?.fields.get(stmt.target.name);
        if (!field) {
          this.error('NOVA3006', `struct '${objType.name}' has no field '${stmt.target.name}'`, stmt.target.span);
          return;
        }
        if (!isAssignable(valueType, field.type)) {
          this.error(
            'NOVA4004',
            `cannot assign ${typeToString(valueType)} to field '${stmt.target.name}' of type ${typeToString(field.type)}`,
            stmt.value.span,
          );
        }
        return;
      }
      if (objType.kind === 'map') {
        if (!isAssignable(valueType, objType.value)) {
          this.error(
            'NOVA4004',
            `cannot assign ${typeToString(valueType)} to map value of type ${typeToString(objType.value)}`,
            stmt.value.span,
          );
        }
        return;
      }
      if (objType.kind !== 'unknown') {
        this.error('NOVA3006', `type ${typeToString(objType)} has no field '${stmt.target.name}'`, stmt.target.span);
      }
      return;
    }

    // Index assignment: collection[i] = value
    const objType = this.checkExpr(stmt.target.obj);
    const indexType = this.checkExpr(stmt.target.index);
    if (objType.kind === 'array') {
      this.requireInt(indexType, 'array index', stmt.target.index.span);
      if (!isAssignable(valueType, objType.element)) {
        this.error('NOVA4004', `cannot assign ${typeToString(valueType)} to array of ${typeToString(objType.element)}`, stmt.value.span);
      }
      return;
    }
    if (objType.kind === 'map') {
      if (!isAssignable(indexType, objType.key)) {
        this.error('NOVA4004', `map key must be ${typeToString(objType.key)}`, stmt.target.index.span);
      }
      if (!isAssignable(valueType, objType.value)) {
        this.error('NOVA4004', `cannot assign ${typeToString(valueType)} to map of ${typeToString(objType.value)}`, stmt.value.span);
      }
      return;
    }
    if (objType.kind !== 'unknown') {
      this.error('NOVA3006', `cannot index into ${typeToString(objType)}`, stmt.target.span);
    }
  }


  private checkMatch(stmt: Extract<Stmt, { kind: 'match' }>): void {
    const subjectType = this.checkExpr(stmt.subject);
    const covered = new Set<string>();
    let hasWildcard = false;
    for (const arm of stmt.arms) {
      const p = arm.pattern;
      if (p.kind === 'wildcard') {
        hasWildcard = true;
      } else if (p.kind === 'literal') {
        const litType = this.checkExpr(p.expr);
        if (subjectType.kind !== 'unknown' && litType.kind !== 'unknown' && !isAssignable(litType, subjectType)) {
          this.error(
            'NOVA4005',
            `match arm pattern of type ${typeToString(litType)} cannot match subject of type ${typeToString(subjectType)}`,
            p.span,
          );
        }
        if (p.expr.kind === 'int' || p.expr.kind === 'float' ||
            p.expr.kind === 'bool' || p.expr.kind === 'string' ||
            p.expr.kind === 'null') {
          covered.add(JSON.stringify({ k: 'lit', v: (p.expr as { value?: unknown }).value }));
        }
      } else if (p.kind === 'path') {
        const enumInfo = this.enums.get(p.name);
        if (!enumInfo) {
          this.error('NOVA3002', `unknown enum '${p.name}' in match pattern`, p.span);
        } else if (p.variant && !enumInfo.variants.has(p.variant)) {
          this.error('NOVA3002', `enum '${p.name}' has no variant '${p.variant}'`, p.span);
        }
        if (subjectType.kind !== 'unknown' && !(subjectType.kind === 'enum' && subjectType.name === p.name)) {
          this.error(
            'NOVA4005',
            `match pattern '${p.name}${p.variant ? '.' + p.variant : ''}' cannot match subject of type ${typeToString(subjectType)}`,
            p.span,
          );
        }
        // Track covered variants (when both subject and pattern are enum).
        if (subjectType.kind === 'enum' && subjectType.name === p.name && p.variant) {
          covered.add(`variant:${p.variant}`);
        }
      } else if (p.kind === 'binding') {
        this.pushScope();
        this.declareVar(p.name, subjectType, p.span, false);
        this.checkBlock(arm.body);
        this.popScope();
        continue;
      } else if (p.kind === 'some' || p.kind === 'ok' || p.kind === 'err') {
        // Payload patterns: bind the unwrapped payload to the inner binding.
        const payloadType =
          subjectType.kind === 'optional' ? subjectType.inner
          : subjectType.kind === 'result'
            ? (p.kind === 'ok' ? subjectType.ok : subjectType.err)
            : T_UNKNOWN;
        const inner = p.inner;
        if (inner.kind === 'binding') {
          this.pushScope();
          this.declareVar(inner.name, payloadType, inner.span, false);
          this.checkBlock(arm.body);
          this.popScope();
          continue;
        }
        if (inner.kind === 'literal') {
          this.checkExpr(inner.expr);
        }
        this.checkBlock(arm.body);
        continue;
      } else if (p.kind === 'none') {
        this.checkBlock(arm.body);
        continue;
      }
      this.checkBlock(arm.body);
    }
    // Exhaustiveness check (enum subjects only — primitive/bool checks would
    // require range analysis that is out of scope).
    if (subjectType.kind === 'enum' && !hasWildcard) {
      const enumInfo = this.enums.get(subjectType.name);
      if (enumInfo) {
        for (const variant of enumInfo.variants.keys()) {
          if (!covered.has(`variant:${variant}`)) {
            const span = stmt.arms.length > 0 ? stmt.arms[stmt.arms.length - 1]!.span : stmt.span;
            this.warn(
              'NOVA4008',
              `match is not exhaustive: missing variant '${subjectType.name}.${variant}'`,
              span,
              `add an arm for '${subjectType.name}.${variant}' or a wildcard '_'`,
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ expressions

    /**
   * Check an expression and return its inferred type.
   * Never throws: on error it reports a diagnostic and returns `unknown`.
   */
  checkExpr(expr: Expr): NovaType {
    const t = this.inferExprInternal(expr);
    this.exprTypes.set(expr, t);
    return t;
  }

  /** Internal: infer the type of an expression without recording. */
  private inferExprInternal(expr: Expr): NovaType {
    switch (expr.kind) {
      case 'int': return T_INT;
      case 'float': return { kind: 'prim', name: 'Float' };
      case 'string': {
        for (const part of expr.parts) {
          if (part.kind === 'interp') this.checkExpr(part.expr);
        }
        return T_STRING;
      }
      case 'bool': return T_BOOL;
      case 'null': return T_NULL;
      case 'ident': {
        const binding = this.lookup(expr.name);
        if (binding) {
          binding.read = true;
          return binding.type;
        }
        const cnst = this.consts.get(expr.name);
        if (cnst) return cnst.type;
        const fn = this.fns.get(expr.name);
        if (fn) {
          return { kind: 'fn', params: fn.params, ret: fn.ret };
        }
        if (this.structs.has(expr.name)) {
          return { kind: 'fn', params: [], ret: { kind: 'struct', name: expr.name } };
        }
        if (this.enums.has(expr.name)) {
          return { kind: 'enum', name: expr.name };
        }
        this.error('NOVA3002', `undefined name '${expr.name}'`, expr.span,
          'declare it with an assignment (`name = value`) or check the spelling');
        return T_UNKNOWN;
      }
      case 'unary': {
        const t = this.checkExpr(expr.expr);
        if (expr.op === '-') {
          if (!isNumeric(t) && t.kind !== 'unknown') {
            this.error('NOVA4001', `operator '-' requires a number, found ${typeToString(t)}`, expr.span);
          }
          return t.kind === 'prim' ? t : T_UNKNOWN;
        }
        this.requireBool(t, "operand of 'not'", expr.expr.span);
        return T_BOOL;
      }
      case 'binary': return this.checkBinary(expr);
      case 'field': {
        const objType = this.checkExpr(expr.obj);
        if (objType.kind === 'struct') {
          const info = this.structs.get(objType.name);
          const field = info?.fields.get(expr.name);
          if (!field) {
            this.error('NOVA3006', `struct '${objType.name}' has no field '${expr.name}'`, expr.span,
              `available fields: ${[...(info?.fields.keys() ?? [])].join(', ') || '<none>'}`);
            return T_UNKNOWN;
          }
          return field.type;
        }
        if (objType.kind === 'enum') {
          const enumInfo = this.enums.get(objType.name);
          if (!enumInfo) {
            this.error('NOVA3002', `unknown enum '${objType.name}'`, expr.span);
            return T_UNKNOWN;
          }
          if (!enumInfo.variants.has(expr.name)) {
            this.error('NOVA3007', `enum '${objType.name}' has no variant '${expr.name}'`, expr.span,
              `available variants: ${[...enumInfo.variants.keys()].join(', ') || '<none>'}`);
            return T_UNKNOWN;
          }
          return objType;
        }
        if (objType.kind === 'map') return objType.value;
        if (objType.kind !== 'unknown') {
          this.error('NOVA3006', `type ${typeToString(objType)} has no field '${expr.name}'`, expr.span);
        }
        return T_UNKNOWN;
      }
      case 'index': {
        const objType = this.checkExpr(expr.obj);
        const indexType = this.checkExpr(expr.index);
        if (objType.kind === 'array') {
          this.requireInt(indexType, 'array index', expr.index.span);
          return objType.element;
        }
        if (objType.kind === 'map') {
          if (!isAssignable(indexType, objType.key)) {
            this.error('NOVA4004', `map key must be ${typeToString(objType.key)}, found ${typeToString(indexType)}`, expr.index.span);
          }
          return objType.value;
        }
        if (objType.kind !== 'unknown') {
          this.error('NOVA3006', `cannot index into ${typeToString(objType)}`, expr.span);
        }
        return T_UNKNOWN;
      }
      case 'array': {
        let element: NovaType = T_UNKNOWN;
        for (const el of expr.elements) {
          const t = this.checkExpr(el);
          if (element.kind === 'unknown' && t.kind !== 'unknown') element = t;
        }
        return { kind: 'array', element };
      }
      case 'map': {
        let key: NovaType = T_UNKNOWN;
        let value: NovaType = T_UNKNOWN;
        for (const entry of expr.entries) {
          const kt = this.checkExpr(entry.key);
          const vt = this.checkExpr(entry.value);
          if (key.kind === 'unknown' && kt.kind !== 'unknown') key = kt;
          if (value.kind === 'unknown' && vt.kind !== 'unknown') value = vt;
        }
        return { kind: 'map', key, value };
      }
      case 'call': return this.checkCall(expr);
      case 'generic': {
        // Explicit type-argument application: `identity<T>(value)`.
        const fn = this.fns.get(expr.name);
        if (!fn) {
          this.error('NOVA3002', `undefined function '${expr.name}'`, expr.span);
          return T_UNKNOWN;
        }
        const substMap = new Map<number, NovaType>();
        fn.typeParams.forEach((_, i) => {
          const arg = expr.typeArgs[i] ? this.resolveType(expr.typeArgs[i]!) : T_UNKNOWN;
          substMap.set(i, arg);
        });
        const subst = (t: NovaType): NovaType => {
          if (t.kind === 'var') {
            const r = substMap.get(t.id);
            return r ?? T_UNKNOWN;
          }
          if (t.kind === 'array') return { kind: 'array', element: subst(t.element) };
          if (t.kind === 'optional') return { kind: 'optional', inner: subst(t.inner) };
          if (t.kind === 'map') return { kind: 'map', key: subst(t.key), value: subst(t.value) };
          if (t.kind === 'result') return { kind: 'result', ok: subst(t.ok), err: subst(t.err) };
          return t;
        };
        return {
          kind: 'fn',
          params: fn.params.map((p) => ({ name: p.name, type: subst(p.type), span: p.span })),
          ret: subst(fn.ret),
        };
      }
      case 'propagate': {
        const inner = this.checkExpr(expr.expr);
        if (inner.kind === 'result') return inner.ok;
        if (inner.kind === 'optional') return inner.inner;
        if (inner.kind !== 'unknown') {
          this.error('NOVA4006', `operator '?' requires Result or Optional, found ${typeToString(inner)}`, expr.span,
            '`?` unwraps `Result<T, E>` / `T?` and propagates errors upward');
        }
        return T_UNKNOWN;
      }
      case 'ok': {
        const valueType = expr.value ? this.checkExpr(expr.value) : T_VOID;
        return { kind: 'result', ok: valueType, err: T_UNKNOWN };
      }
      case 'error': {
        const valueType = expr.value ? this.checkExpr(expr.value) : T_STRING;
        return { kind: 'result', ok: T_UNKNOWN, err: valueType };
      }
      case 'some': {
        const valueType = expr.value ? this.checkExpr(expr.value) : T_VOID;
        return { kind: 'optional', inner: valueType };
      }
      case 'none': {
        return { kind: 'optional', inner: T_UNKNOWN };
      }
      case 'closure': {
        this.pushScope();
        const params = expr.params.map((p) => {
          const type = p.type ? this.resolveType(p.type) : T_UNKNOWN;
          this.declareVar(p.name, type, p.span, true);
          return { name: p.name, type, span: p.span };
        });
        this.checkBlock(expr.body);
        const ret = this.lastExprType(expr.body);
        this.popScope();
        return { kind: 'fn', params, ret };
      }
    }
  }

  /** Type of the final expression of a block, or void when it ends in control flow. */
  private lastExprType(body: Block): NovaType {
    for (let i = body.stmts.length - 1; i >= 0; i--) {
      const s = body.stmts[i]!;
      if (s.kind === 'expr') return this.checkExpr(s.expr);
      if (s.kind !== 'block') break;
    }
    return T_VOID;
  }

  private checkBinary(expr: Extract<Expr, { kind: 'binary' }>): NovaType {
    const left = this.checkExpr(expr.left);
    const right = this.checkExpr(expr.right);
    const op = expr.op;

    if (op === 'and' || op === 'or') {
      this.requireBool(left, `left operand of '${op}'`, expr.left.span);
      this.requireBool(right, `right operand of '${op}'`, expr.right.span);
      return T_BOOL;
    }

    if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (!isNumeric(left) && left.kind !== 'unknown') {
          this.error('NOVA4001', `operator '${op}' requires numbers, found ${typeToString(left)} on the left`, expr.left.span);
        }
        if (!isNumeric(right) && right.kind !== 'unknown') {
          this.error('NOVA4001', `operator '${op}' requires numbers, found ${typeToString(right)} on the right`, expr.right.span);
        }
      } else if (left.kind !== 'unknown' && right.kind !== 'unknown' &&
          !isAssignable(left, right) && !isAssignable(right, left)) {
        this.error('NOVA4004', `cannot compare ${typeToString(left)} with ${typeToString(right)}`, expr.span);
      }
      return T_BOOL;
    }

    if (op === '+') {
      const isStr = (t: NovaType) => t.kind === 'prim' && t.name === 'String';
      if (isStr(left) && isStr(right)) return T_STRING;
    }

    if (!isNumeric(left) && left.kind !== 'unknown') {
      this.error('NOVA4001', `operator '${op}' requires numbers, found ${typeToString(left)} on the left`, expr.left.span);
    }
    if (!isNumeric(right) && right.kind !== 'unknown') {
      this.error('NOVA4001', `operator '${op}' requires numbers, found ${typeToString(right)} on the right`, expr.right.span);
    }
    // `/` always widens to Float; `%` follows the operands (Int for Int operands).
    if (op === '/') return { kind: 'prim', name: 'Float' };
    const isFloat = (t: NovaType) => t.kind === 'prim' && t.name === 'Float';
    if (isFloat(left) || isFloat(right)) return { kind: 'prim', name: 'Float' };
    return T_INT;
  }


  private checkCall(expr: Extract<Expr, { kind: 'call' }>): NovaType {
    // Struct constructors take priority: `User(id: 1, ...)`.
    if (expr.callee.kind === 'ident' && !this.lookup(expr.callee.name) &&
        !this.fns.has(expr.callee.name) && this.structs.has(expr.callee.name)) {
      return this.checkStructCall(expr.callee.name, expr);
    }

    // Built-in natives.
    if (expr.callee.kind === 'ident' && !this.lookup(expr.callee.name) && !this.fns.has(expr.callee.name)) {
      const native = NATIVE_SIGNATURES[expr.callee.name];
      if (native) {
        for (const arg of expr.args) this.checkExpr(arg.value);
        return native.ret;
      }
    }

    const calleeType = this.checkExpr(expr.callee);
    const argTypes = expr.args.map((a) => ({
      name: a.name,
      type: this.checkExpr(a.value),
      span: a.value.span,
    }));

    if (calleeType.kind === 'fn') {
      this.checkArguments(calleeType.params, argTypes, expr);
      return calleeType.ret;
    }
    if (calleeType.kind === 'unknown') return T_UNKNOWN;
    if (calleeType.kind === 'struct') return this.checkStructCall(calleeType.name, expr);

    this.error('NOVA4001', `value of type ${typeToString(calleeType)} is not callable`, expr.callee.span);
    return T_UNKNOWN;
  }

  /** Check a struct construction call: `User(id: 1, name: "x")`. */
  private checkStructCall(structName: string, expr: Extract<Expr, { kind: 'call' }>): NovaType {
    const info = this.structs.get(structName)!;
    const argTypes = expr.args.map((a) => ({ name: a.name, type: this.checkExpr(a.value), span: a.value.span }));
    const assigned = new Set<string>();
    let position = 0;
    for (const arg of argTypes) {
      if (arg.name) {
        const field = info.fields.get(arg.name);
        if (!field) {
          this.error('NOVA3006', `struct '${structName}' has no field '${arg.name}'`, arg.span);
          continue;
        }
        if (assigned.has(arg.name)) {
          this.error('NOVA3001', `field '${arg.name}' specified twice`, arg.span);
        }
        assigned.add(arg.name);
        if (!isAssignable(arg.type, field.type)) {
          this.error('NOVA4004', `field '${arg.name}' expects ${typeToString(field.type)}, found ${typeToString(arg.type)}`, arg.span);
        }
      } else {
        const field = [...info.fields.values()][position];
        if (!field) {
          this.error('NOVA3001', `too many arguments for struct '${structName}'`, arg.span);
          break;
        }
        if (!isAssignable(arg.type, field.type)) {
          this.error('NOVA4004', `field '${field.name}' expects ${typeToString(field.type)}, found ${typeToString(arg.type)}`, arg.span);
        }
        assigned.add(field.name);
        position++;
      }
    }
    const missing = [...info.fields.keys()].filter((f) => !assigned.has(f));
    if (missing.length > 0) {
      this.error('NOVA3001', `missing fields for struct '${structName}': ${missing.join(', ')}`, expr.span,
        'construct the struct with all of its fields');
    }
    return { kind: 'struct', name: structName };
  }

  private checkArguments(
    params: { name: string; type: NovaType }[],
    args: { name?: string; type: NovaType; span: Span2 }[],
    expr: Extract<Expr, { kind: 'call' }>,
  ): void {
    const assigned = new Array<boolean>(params.length).fill(false);
    let positional = 0;
    for (const arg of args) {
      if (arg.name) {
        const index = params.findIndex((p) => p.name === arg.name);
        if (index === -1) {
          this.error('NOVA3002', `no parameter named '${arg.name}'`, arg.span,
            `parameters: ${params.map((p) => p.name).join(', ') || '<none>'}`);
          continue;
        }
        if (assigned[index]) {
          this.error('NOVA3001', `parameter '${arg.name}' specified twice`, arg.span);
        }
        assigned[index] = true;
        if (!isAssignable(arg.type, params[index]!.type)) {
          this.reportArgTypeMismatch(params[index]!, arg);
        }
      } else {
        const index = positional++;
        if (index >= params.length) {
          this.error('NOVA3001', `too many arguments: expected ${params.length}`, arg.span);
          break;
        }
        assigned[index] = true;
        if (!isAssignable(arg.type, params[index]!.type)) {
          this.reportArgTypeMismatch(params[index]!, arg);
        }
      }
    }
    const missing = params.filter((_p, i) => !assigned[i]).map((p) => p.name);
    if (missing.length > 0) {
      this.error('NOVA3001', `missing arguments: ${missing.join(', ')}`, expr.callee.span);
    }
  }

  private reportArgTypeMismatch(
    param: { name: string; type: NovaType },
    arg: { type: NovaType; span: Span2 },
  ): void {
    this.error(
      'NOVA4004',
      `parameter '${param.name}' expects ${typeToString(param.type)}, found ${typeToString(arg.type)}`,
      arg.span,
      `pass a value of type ${typeToString(param.type)}`,
    );
  }
}

