import type { Block, Expr, Program, Stmt } from '../ast/ast.ts';
import { PRELUDE } from './prelude.ts';

/**
 * JavaScript code generator.
 *
 * Compiles checked NOVA programs to a standalone ES module. The emitted file
 * embeds a small runtime prelude with the same value semantics as the
 * interpreter (tagged values, Result propagation, structural equality).
 */

const NATIVE_MAP: Record<string, string> = {
  print: '__print', println: '__print', len: '__len', int: '__int',
  float: '__float', range: '__range', keys: '__keys', values: '__values',
  has: '__has', remove: '__remove', merge: '__merge',
  expect: '__expect', expect_eq: '__expectEq',
  push: '__push', pop: '__pop', first: '__first', last: '__last',
  slice: '__slice', contains: '__contains', join: '__join',
  abs: 'Math.abs', min: 'Math.min', max: 'Math.max', sqrt: 'Math.sqrt',
  floor: 'Math.floor', ceil: 'Math.ceil', round: 'Math.round',
  pow: 'Math.pow', random: 'Math.random', typeof: '__typeof',
};

class Emitter {
  private lines: string[] = [];
  private depth = 0;
  private readonly structFieldOrder: Map<string, string[]>;

  constructor(structFieldOrder: Map<string, string[]>) {
    this.structFieldOrder = structFieldOrder;
  }

  emit(prog: Program): string {
    const fns: Extract<Program['decls'][number], { kind: 'fn' }>[] = [];
    const topLevel: Stmt[] = [];
    const consts: Extract<Program['decls'][number], { kind: 'const' }>[] = [];
    const enums: Extract<Program['decls'][number], { kind: 'enum' }>[] = [];

    for (const decl of prog.decls) {
      if (decl.kind === 'fn') fns.push(decl);
      else if (decl.kind === 'const') consts.push(decl);
      else if (decl.kind === 'enum') enums.push(decl);
      else if (this.isStmt(decl)) topLevel.push(decl);
    }

    // Enums become plain objects of tagged variants.
    for (const e of enums) {
      const variants = e.variants.map((v) => `${v.name}: __enum('${e.name}', '${v.name}')`);
      this.line(`const ${e.name} = { ${variants.join(', ')} };`);
    }

    // Functions (hoisted declarations).
    for (const fn of fns) this.emitFn(fn);

    // Top-level initialisation.
    this.line('function __init() {');
    this.depth++;
    for (const c of consts) {
      this.line(`${c.name} = ${this.expr(c.value)};`);
    }
    for (const stmt of topLevel) this.emitStmt(stmt);
    this.depth--;
    this.line('}');

    // Entry point.
    this.line('__init();');
    if (fns.some((f) => f.name === 'main')) {
      this.line('try { main(); } catch (e) {');
      this.line('  if (e && e.__nova_propagate) { console.error("error: unhandled error result"); process.exit(1); }');
      this.line('  throw e;');
      this.line('}');
    }

    return this.lines.join('\n') + '\n';
  }

  private isStmt(n: unknown): n is Stmt {
    return typeof n === 'object' && n !== null && 'kind' in n;
  }

  private line(text: string): void {
    this.lines.push('  '.repeat(this.depth) + text);
  }

  private emitFn(fn: Extract<Program['decls'][number], { kind: 'fn' }>): void {
    const params = fn.params.map((p) => `nova_${p.name}`).join(', ');
    this.line(`function ${fn.name}(${params}) {`);
    this.depth++;
    this.line('try {');
    this.depth++;
    this.emitBody(fn.body, true);
    this.depth--;
    this.line('} catch (e) { if (e && e.__nova_propagate) { return e.value; } throw e; }');
    this.depth--;
    this.line('}');
  }

  /** Emit block statements; `allowImplicitReturn` enables last-expression returns. */
  private emitBody(block: Block, allowImplicitReturn: boolean): void {
    const stmts = block.stmts;
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]!;
      const isLast = i === stmts.length - 1;
      if (isLast && allowImplicitReturn && stmt.kind === 'expr') {
        this.line(`return ${this.expr(stmt.expr)};`);
      } else {
        this.emitStmt(stmt);
      }
    }
  }

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'assign': {
        const value = this.expr(stmt.value);
        if (stmt.target.kind === 'ident') {
          const decl = stmt.isDeclaration && !stmt.annot;
          this.line(`${decl ? 'let ' : ''}${stmt.target.name} = ${value};`);
          return;
        }
        if (stmt.target.kind === 'field') {
          this.line(`__setField(${this.expr(stmt.target.obj)}, '${stmt.target.name}', ${value});`);
          return;
        }
        if (stmt.target.kind === 'index') {
          this.line(`__setIndex(${this.expr(stmt.target.obj)}, ${this.expr(stmt.target.index)}, ${value});`);
          return;
        }
        return;
      }
      case 'expr':
        this.line(`${this.expr(stmt.expr)};`);
        return;
      case 'if': {
        this.line(`if (${this.expr(stmt.cond)}) {`);
        this.depth++;
        this.emitBody(stmt.then, false);
        this.depth--;
        if (stmt.else) {
          this.line('} else {');
          this.depth++;
          this.emitBody(stmt.else, false);
          this.depth--;
        }
        this.line('}');
        return;
      }
      case 'while': {
        this.line(`while (${this.expr(stmt.cond)}) {`);
        this.depth++;
        this.emitBody(stmt.body, false);
        this.depth--;
        this.line('}');
        return;
      }
      case 'for': {
        this.line(`for (const ${stmt.name} of __iter(${this.expr(stmt.iter)})) {`);
        this.depth++;
        this.emitBody(stmt.body, false);
        this.depth--;
        this.line('}');
        return;
      }
      case 'return':
        this.line(stmt.value ? `return ${this.expr(stmt.value)};` : 'return;');
        return;
      case 'match':
        this.emitMatch(stmt);
        return;
      case 'block':
        this.line('{');
        this.depth++;
        this.emitBody(stmt.block, false);
        this.depth--;
        this.line('}');
        return;
      case 'break':
        this.line('break;');
        return;
      case 'continue':
        this.line('continue;');
        return;
    }
  }

  private emitMatch(stmt: Extract<Stmt, { kind: 'match' }>): void {
    this.line('{');
    this.depth++;
    this.line(`const __subject = ${this.expr(stmt.subject)};`);
    for (let i = 0; i < stmt.arms.length; i++) {
      const arm = stmt.arms[i]!;
      const cond = this.patternCond(arm.pattern);
      const prefix = i === 0 ? 'if' : '} else if';
      this.line(`${prefix} (${cond}) {`);
      this.depth++;
      const pat = arm.pattern;
      const bindName =
        (pat.kind === 'binding' && pat.name) ||
        ((pat.kind === 'some' || pat.kind === 'ok' || pat.kind === 'err') && pat.inner.kind === 'binding' && pat.inner.name) ||
        null;
      if (bindName) {
        const valueExpr = pat.kind === 'binding' ? '__subject' : '__subject.value';
        this.line(`const ${bindName} = ${valueExpr};`);
      }
      this.emitBody(arm.body, false);
      this.depth--;
    }
    if (stmt.arms.length > 0) this.line('}');
    this.depth--;
    this.line('}');
  }

  private patternCond(p: Extract<Stmt, { kind: 'match' }>['arms'][number]['pattern']): string {
    switch (p.kind) {
      case 'wildcard': return 'true';
      case 'binding': return 'true';
      case 'path': {
        if (!p.variant) return `__subject && __subject.tag === 'enum' && __subject.enumName === '${p.name}'`;
        return `__subject && __subject.tag === 'enum' && __subject.enumName === '${p.name}' && __subject.variant === '${p.variant}'`;
      }
      case 'literal': return `__eq(__subject, ${this.expr(p.expr)})`;
      case 'some': return `__subject && typeof __subject === 'object' && __subject.tag === 'some'`;
      case 'none': return `__subject && typeof __subject === 'object' && __subject.tag === 'none'`;
      case 'ok': return `__subject && typeof __subject === 'object' && __subject.tag === 'result' && __subject.ok === true`;
      case 'err': return `__subject && typeof __subject === 'object' && __subject.tag === 'result' && __subject.ok === false`;
    }
  }

  // ------------------------------------------------------------- expressions

  private expr(e: Expr): string {
    switch (e.kind) {
      case 'int': case 'float':
        return String(e.value);
      case 'string': {
        const parts = e.parts.map((p) =>
          p.kind === 'text' ? p.text : `\${__str(${this.expr(p.expr)})}`,
        ).join('');
        return '`' + parts.replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
      }
      case 'bool': return e.value ? 'true' : 'false';
      case 'null': return 'null';
      case 'ident': return e.name;
      case 'unary':
        return e.op === '-' ? `(-${this.expr(e.expr)})` : `(!${this.expr(e.expr)})`;
      case 'binary': {
        if (e.op === '==') return `__eq(${this.expr(e.left)}, ${this.expr(e.right)})`;
        if (e.op === '!=') return `(!__eq(${this.expr(e.left)}, ${this.expr(e.right)}))`;
        const op = e.op === 'and' ? '&&' : e.op === 'or' ? '||' : e.op;
        return `(${this.expr(e.left)} ${op} ${this.expr(e.right)})`;
      }
      case 'field':
        return `__field(${this.expr(e.obj)}, '${e.name}')`;
      case 'index':
        return `__index(${this.expr(e.obj)}, ${this.expr(e.index)})`;
      case 'call':
        return this.call(e);
      case 'array':
        return `__arr([${e.elements.map((el) => this.expr(el)).join(', ')}])`;
      case 'map': {
        const flat = e.entries.flatMap((en) => [this.expr(en.key), this.expr(en.value)]).join(', ');
        return `__map([${flat}])`;
      }
      case 'propagate':
        return `__unwrap(${this.expr(e.expr)})`;
      case 'ok':
        return `__ok(${e.value ? this.expr(e.value) : 'null'})`;
      case 'error':
        return `__err(${e.value ? this.expr(e.value) : '""'})`;
    }
    return 'null';
  }

  private call(e: Extract<Expr, { kind: 'call' }>): string {
    // Native functions.
    if (e.callee.kind === 'ident' && NATIVE_MAP[e.callee.name]) {
      return `${NATIVE_MAP[e.callee.name]}(${e.args.map((a) => this.expr(a.value)).join(', ')})`;
    }
    // Struct constructor: resolve positional args to field names at compile time.
    if (e.callee.kind === 'ident' && this.structFieldOrder.has(e.callee.name)) {
      const fields = this.structFieldOrder.get(e.callee.name)!;
      const values: string[] = [];
      let pos = 0;
      for (const arg of e.args) {
        if (arg.name) {
          values.push(`'${arg.name}'`, this.expr(arg.value));
        } else {
          const fieldName = fields[pos];
          if (fieldName === undefined) break;
          values.push(`'${fieldName}'`, this.expr(arg.value));
          pos++;
        }
      }
      return `__struct('${e.callee.name}', [${fields.map((f) => `'${f}'`).join(', ')}], [${values.join(', ')}])`;
    }
    const callee = this.expr(e.callee);
    return `${callee}(${e.args.map((a) => this.expr(a.value)).join(', ')})`;
  }
}

/** Compile a program to a standalone JS module. */
export function generateJs(prog: Program, structFieldOrder: Map<string, string[]>): string {
  return PRELUDE + '\n' + new Emitter(structFieldOrder).emit(prog);
}
