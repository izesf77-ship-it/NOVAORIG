/**
 * Reference MIR interpreter.
 *
 * Executes a MirModule directly — the semantic reference implementation used
 * before the native backend exists. Pipeline position:
 *
 *     HIR -> MIR -> MIR interpreter      (this file, reference semantics)
 *     HIR -> MIR -> native backend       (M4, later)
 *
 * This is NOT the production runtime. Its job is to pin down MIR semantics:
 * the JS backend, golden tests and (later) the native backend must agree with
 * what this interpreter does for the same MIR.
 *
 * Value model: identical tagged representation to the HIR interpreter/JS
 * backend prelude (arrays/maps/structs/enums, `some`/`none` options, `result`
 * values) so results are directly comparable. Option/Result literals were
 * lowered to `__Option__`/`__Result__` enum literals by mir_lower and are
 * decoded back into tagged values here. Closures are closure-converted:
 * calling a `closure` value invokes the named closure_fn with
 * [args..., captures...].
 *
 * Every MIR value kind and terminator kind is executed; no high-level control
 * flow remains (there is no `match` instruction to interpret — match was
 * lowered to explicit branches by the lowering pass).
 */
import type { MirModule, MirFunction, MirClosureDecl, MirBlock, MirValue, MirInstr } from './mir.ts';
import {
  RuntimeError, stringify, valuesEqual, isTruthy, defineNatives,
  type Value, type ArrayValue, type MapValue, type StructValue,
  type OptionValue, type ResultValue, type NativeFnValue, type NativeCall,
} from '../../runtime/hir_interp.ts';

type FnLike = MirFunction | MirClosureDecl;

export interface MirInterpreterOptions {
  /** Stdout sink (defaults to process.stdout.write). */
  write?: (s: string) => void;
}

export class MirInterpreter {
  private readonly fns = new Map<string, FnLike>();
  private readonly globals = new Map<string, Value>();
  private readonly natives = new Map<string, NativeCall>();
  private readonly write: (s: string) => void;
  private readonly structFields = new Map<string, string[]>();

  /** Guard against runaway/infinite loops in the reference interpreter. */
  private static readonly STEP_LIMIT = 10_000_000;

  constructor(module: MirModule, options: MirInterpreterOptions = {}) {
    this.write = options.write ?? ((s: string) => process.stdout.write(s));
    for (const d of module.decls) {
      if (d.kind === 'fn' || d.kind === 'closure_fn') {
        if (this.fns.has(d.name)) throw new Error(`mir: duplicate function '${d.name}'`);
        this.fns.set(d.name, d);
      } else if (d.kind === 'struct') {
        this.structFields.set(d.name, d.fields.map((f) => f.name));
      }
    }
    // Shared native functions (same semantics as the HIR interpreter).
    defineNatives((name, _sig, call) => this.natives.set(name, call));
    // Route print/println through the injected sink so tests/CLI can capture.
    const printFn = (args: Value[]): Value => {
      this.write(args.map(stringify).join(' '));
      return null;
    };
    const printlnFn = (args: Value[]): Value => {
      this.write(args.map(stringify).join(' ') + '\n');
      return null;
    };
    this.natives.set('print', printFn);
    this.natives.set('println', printlnFn);
    // Top-level consts evaluate eagerly, in declaration order.
    const root = new Map<string, Value>();
    for (const d of module.decls) {
      if (d.kind === 'const') this.globals.set(d.name, this.evalValue(d.value, root));
    }
  }

  // --- entry points ---------------------------------------------------------

  /** Execute `entry()` (default `main`). Returns a process-style exit code. */
  run(entry = 'main'): number {
    if (!this.fns.has(entry)) {
      process.stderr.write(`mir: no '${entry}' function to run\n`);
      return 1;
    }
    try {
      this.callFunction(entry, []);
      return 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`mir runtime error: ${msg}\n`);
      return 1;
    }
  }

  /** Call a function (or native) by name with positional args. */
  callFunction(name: string, args: Value[]): Value {
    const fn = this.fns.get(name);
    if (!fn) {
      const native = this.natives.get(name);
      if (native) return native(args, null);
      throw new RuntimeError(`undefined function '${name}'`, null);
    }
    const locals = new Map<string, Value>();
    fn.params.forEach((p, i) => locals.set(p.name, args[i] ?? null));
    return this.runBlocks(fn, locals);
  }

  // --- execution ------------------------------------------------------------

  private runBlocks(fn: FnLike, locals: Map<string, Value>): Value {
    const byLabel = new Map<string, MirBlock>();
    for (const b of fn.blocks) byLabel.set(b.label, b);
    let block = fn.blocks[0]!;
    let steps = 0;
    for (;;) {
      if (++steps > MirInterpreter.STEP_LIMIT) {
        throw new RuntimeError(`execution step limit (${MirInterpreter.STEP_LIMIT}) exceeded`, null);
      }
      for (const instr of block.instrs) this.execInstr(instr, locals);
      const term = block.term;
      switch (term.kind) {
        case 'return':
          return term.value !== undefined ? this.evalValue(term.value, locals) : null;
        case 'jump':
          block = this.getBlock(byLabel, term.target);
          break;
        case 'branch': {
          const cond = this.evalValue(term.cond, locals);
          if (typeof cond !== 'boolean') {
            throw new RuntimeError(`branch condition must be Bool, found ${stringify(cond)}`, null);
          }
          block = this.getBlock(byLabel, cond ? term.thenLabel : term.elseLabel);
          break;
        }
        case 'unreachable':
          throw new RuntimeError('reached unreachable block', null);
      }
    }
  }

  private getBlock(byLabel: Map<string, MirBlock>, label: string): MirBlock {
    const b = byLabel.get(label);
    if (!b) throw new RuntimeError(`jump to unknown block '${label}'`, null);
    return b;
  }

  private execInstr(instr: MirInstr, locals: Map<string, Value>): void {
    switch (instr.kind) {
      case 'assign':
        locals.set(instr.name, this.evalValue(instr.value, locals));
        break;
      case 'store_field': {
        const obj = this.evalValue(instr.obj, locals);
        const value = this.evalValue(instr.value, locals);
        if (obj !== null && typeof obj === 'object') {
          if ((obj as StructValue).tag === 'struct') {
            (obj as StructValue).fields.set(instr.name, value);
            return;
          }
          if ((obj as MapValue).tag === 'map') {
            (obj as MapValue).entries.set(instr.name, value);
            return;
          }
        }
        throw new RuntimeError(`can only store fields on structs and maps, found ${stringify(obj)}`, null);
      }
      case 'store_index': {
        const obj = this.evalValue(instr.obj, locals);
        const value = this.evalValue(instr.value, locals);
        if (obj !== null && typeof obj === 'object' && (obj as ArrayValue).tag === 'array') {
          const idx = this.evalValue(instr.index, locals);
          if (typeof idx !== 'number' || !Number.isInteger(idx)) {
            throw new RuntimeError(`array index must be an integer, found ${stringify(idx)}`, null);
          }
          const items = (obj as ArrayValue).items;
          if (idx < 0 || idx >= items.length) {
            throw new RuntimeError(`array index ${idx} out of bounds (length ${items.length})`, null);
          }
          items[idx] = value;
          return;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          const key = this.evalValue(instr.index, locals);
          if (typeof key !== 'string') throw new RuntimeError(`map keys must be strings, found ${stringify(key)}`, null);
          (obj as MapValue).entries.set(key, value);
          return;
        }
        throw new RuntimeError(`can only index arrays and maps, found ${stringify(obj)}`, null);
      }
    }
  }

  // --- value evaluation -----------------------------------------------------

  private evalValue(v: MirValue, locals: Map<string, Value>): Value {
    switch (v.kind) {
      case 'lit': return (v.value ?? null) as Value;
      case 'ref': return this.lookup(v.name, locals);
      case 'bin': return this.evalBin(v.op, v.left, v.right, locals);
      case 'unary': {
        const val = this.evalValue(v.expr, locals);
        if (v.op === '-') {
          if (typeof val !== 'number') throw new RuntimeError(`unary '-' requires a number, found ${stringify(val)}`, null);
          return -val;
        }
        return !isTruthy(val);
      }
      case 'call': {
        const callee = this.evalValue(v.callee, locals);
        const args = v.args.map((a) => this.evalValue(a, locals));
        return this.invoke(callee, args);
      }
      case 'field': {
        const obj = this.evalValue(v.obj, locals);
        if (obj !== null && typeof obj === 'object') {
          if ((obj as StructValue).tag === 'struct') {
            const fields = (obj as StructValue).fields;
            if (!fields.has(v.name)) {
              throw new RuntimeError(`struct '${(obj as StructValue).structName}' has no field '${v.name}'`, null);
            }
            return fields.get(v.name)!;
          }
          if ((obj as MapValue).tag === 'map') return (obj as MapValue).entries.get(v.name) ?? null;
        }
        throw new RuntimeError(`cannot access field '${v.name}' on ${stringify(obj)}`, null);
      }
      case 'index': {
        const obj = this.evalValue(v.obj, locals);
        const idx = this.evalValue(v.index, locals);
        if (obj !== null && typeof obj === 'object' && (obj as ArrayValue).tag === 'array') {
          if (typeof idx !== 'number' || !Number.isInteger(idx)) {
            throw new RuntimeError(`array index must be an integer, found ${stringify(idx)}`, null);
          }
          const items = (obj as ArrayValue).items;
          if (idx < 0 || idx >= items.length) {
            throw new RuntimeError(`array index ${idx} out of bounds (length ${items.length})`, null);
          }
          return items[idx]!;
        }
        if (obj !== null && typeof obj === 'object' && (obj as MapValue).tag === 'map') {
          if (typeof idx !== 'string') throw new RuntimeError(`map keys must be strings, found ${stringify(idx)}`, null);
          return (obj as MapValue).entries.get(idx) ?? null;
        }
        throw new RuntimeError(`cannot index into ${stringify(obj)}`, null);
      }
      case 'struct_lit': {
        const fields = new Map<string, Value>();
        for (const f of v.fields) fields.set(f.name, this.evalValue(f.value, locals));
        return { tag: 'struct', structName: v.structName, fields } satisfies StructValue;
      }
      case 'array_lit':
        return { tag: 'array', items: v.elements.map((e) => this.evalValue(e, locals)) } satisfies ArrayValue;
      case 'map_lit': {
        const entries = new Map<string, Value>();
        for (const e of v.entries) {
          const key = this.evalValue(e.key, locals);
          if (typeof key !== 'string') throw new RuntimeError(`map keys must be strings, found ${stringify(key)}`, null);
          entries.set(key, this.evalValue(e.value, locals));
        }
        return { tag: 'map', entries } satisfies MapValue;
      }
      case 'enum_lit':
        return this.evalEnumLit(v.enumName, v.variant, v.data !== undefined ? this.evalValue(v.data, locals) : undefined);
      case 'closure_ref':
        return { tag: 'closure', fnName: v.fnName, captures: v.captures.map((c) => this.evalValue(c, locals)) } as unknown as Value;
      case 'intrinsic':
        return this.evalIntrinsic(v.op, this.evalValue(v.arg, locals));
    }
  }

  private evalEnumLit(enumName: string, variant: string, data?: Value): Value {
    if (enumName === '__Option__') {
      if (variant === 'some') return { tag: 'some', value: data ?? null } satisfies OptionValue;
      if (variant === 'none') return { tag: 'none' } satisfies OptionValue;
    }
    if (enumName === '__Result__') {
      if (variant === 'ok') return { tag: 'result', ok: true, value: data ?? null } satisfies ResultValue;
      if (variant === 'err') return { tag: 'result', ok: false, value: data ?? null } satisfies ResultValue;
    }
    return { tag: 'enum', enumName, variant, data } as unknown as Value;
  }

  private evalIntrinsic(op: string, arg: Value): Value {
    switch (op) {
      case 'is_some': return arg !== null && typeof arg === 'object' && (arg as OptionValue).tag === 'some';
      case 'is_none': return arg !== null && typeof arg === 'object' && (arg as OptionValue).tag === 'none';
      case 'is_ok': return arg !== null && typeof arg === 'object' && (arg as ResultValue).tag === 'result' && (arg as ResultValue).ok === true;
      case 'is_err': return arg !== null && typeof arg === 'object' && (arg as ResultValue).tag === 'result' && (arg as ResultValue).ok === false;
      case 'unwrap_some': {
        if (arg !== null && typeof arg === 'object' && (arg as OptionValue).tag === 'some') return (arg as OptionValue).value ?? null;
        throw new RuntimeError(`unwrap_some on non-Some value ${stringify(arg)}`, null);
      }
      case 'unwrap_ok': {
        if (arg !== null && typeof arg === 'object' && (arg as ResultValue).tag === 'result' && (arg as ResultValue).ok) return (arg as ResultValue).value;
        throw new RuntimeError(`unwrap_ok on non-Ok Result ${stringify(arg)}`, null);
      }
      case 'unwrap_err': {
        if (arg !== null && typeof arg === 'object' && (arg as ResultValue).tag === 'result' && !(arg as ResultValue).ok) return (arg as ResultValue).value;
        throw new RuntimeError(`unwrap_err on non-Err Result ${stringify(arg)}`, null);
      }
      default:
        throw new RuntimeError(`unknown intrinsic '${op}'`, null);
    }
  }

  private evalBin(
    op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or',
    left: MirValue, right: MirValue, locals: Map<string, Value>,
  ): Value {
    if (op === 'and') {
      if (!isTruthy(this.evalValue(left, locals))) return false;
      return isTruthy(this.evalValue(right, locals));
    }
    if (op === 'or') {
      if (isTruthy(this.evalValue(left, locals))) return true;
      return isTruthy(this.evalValue(right, locals));
    }
    const l = this.evalValue(left, locals);
    const r = this.evalValue(right, locals);
    switch (op) {
      case '+':
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        throw new RuntimeError(`'+' expects two numbers or two strings, found ${stringify(l)} and ${stringify(r)}`, null);
      case '-': case '*': case '/': case '%': {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new RuntimeError(`'${op}' requires numbers, found ${stringify(l)} and ${stringify(r)}`, null);
        }
        if ((op === '/' || op === '%') && r === 0) throw new RuntimeError('division by zero', null);
        switch (op) {
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
        }
        break;
      }
      case '==': return valuesEqual(l, r);
      case '!=': return !valuesEqual(l, r);
      case '<': case '<=': case '>': case '>=': {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new RuntimeError(`'${op}' requires numbers, found ${stringify(l)} and ${stringify(r)}`, null);
        }
        switch (op) {
          case '<': return l < r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '>=': return l >= r;
        }
        break;
      }
    }
    throw new RuntimeError(`unknown operator '${op}'`, null);
  }

  private lookup(name: string, locals: Map<string, Value>): Value {
    if (locals.has(name)) return locals.get(name)!;
    if (this.globals.has(name)) return this.globals.get(name)!;
    const native = this.natives.get(name);
    if (native) return { tag: 'native', name, call: native } as NativeFnValue;
    if (this.fns.has(name)) return { tag: 'closure', fnName: name, captures: [] } as unknown as Value;
    // Struct constructor: recognized by uppercase name registered in structFields.
    if (this.structFields.has(name)) return { tag: 'struct_constructor', structName: name } as unknown as Value;
    throw new RuntimeError(`undefined variable '${name}'`, null);
  }

  private invoke(callee: Value, args: Value[]): Value {
    if (callee !== null && typeof callee === 'object') {
      const tag = (callee as { tag: string }).tag;
      if (tag === 'native') return (callee as unknown as NativeFnValue).call(args, null);
      if (tag === 'closure') {
        const clo = callee as unknown as { fnName: string; captures: Value[] };
        return this.callFunction(clo.fnName, [...args, ...clo.captures]);
      }
      if (tag === 'struct_constructor') {
        const sc = callee as unknown as { structName: string };
        const fields = this.structFields.get(sc.structName);
        if (!fields) throw new RuntimeError(`unknown struct '${sc.structName}'`, null);
        if (args.length !== fields.length) {
          throw new RuntimeError(`struct '${sc.structName}' expects ${fields.length} field(s), got ${args.length}`, null);
        }
        const value = new Map<string, Value>();
        for (let i = 0; i < fields.length; i++) value.set(fields[i]!, args[i] ?? null);
        return { tag: 'struct', structName: sc.structName, fields: value } satisfies StructValue;
      }
    }
    throw new RuntimeError(`value ${stringify(callee)} is not callable`, null);
  }
}




