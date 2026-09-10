/**
 * MIR verifier.
 *
 * Statically validates a `MirModule` before it is handed to any backend
 * (reference interpreter, future native backend, optimizer passes). It is part
 * of the compiler pipeline: `nova dump-mir`, `nova check-mir` and
 * `nova run-mir` all verify MIR before consuming it.
 *
 * Checks:
 *   1. Structure: unique block labels, non-empty CFG, valid instruction kinds.
 *   2. Terminators: every block has exactly one terminator; jump/branch
 *      targets reference existing blocks in the same function.
 *   3. Locals: every referenced local is defined before use along some CFG
 *      path (may-def union fixpoint), or is an external name (fn, closure,
 *      const, native).
 *   4. Block params: only the entry block may declare params (this IR version
 *      passes no block arguments on terminators; SSA/phi construction is a
 *      future mem2reg-style pass).
 *   5. Types: branch conditions are Bool, arithmetic operands numeric (or
 *      String for `+`), Option/Result intrinsics receive the right shapes,
 *      call arity matches the callee declaration, return values match the
 *      function return type.
 *
 * The verifier never mutates the module and reports errors deterministically
 * (declaration order, then block order, then instruction order).
 */
import type { HirType } from '../hir/hir.ts';
import type {
  MirModule, MirFunction, MirClosureDecl, MirBlock, MirInstr, MirTerm, MirValue,
} from './mir.ts';
import { mirTypeString } from './mir.ts';

export interface MirVerifyError {
  fn: string;
  block?: string;
  message: string;
}

/** Native builtin names callable as plain refs (kept in sync with defineNatives). */
const NATIVE_NAMES: ReadonlySet<string> = new Set([
  'print', 'println', 'len', 'str', 'int', 'float', 'abs', 'min', 'max', 'sqrt',
  'floor', 'ceil', 'round', 'pow', 'random', 'random_int', 'range', 'push', 'pop',
  'first', 'last', 'slice', 'contains', 'join', 'reverse', 'sort', 'keys',
  'values', 'has', 'remove', 'merge', 'expect', 'expect_eq', 'input', 'clock_ms', 'typeof',
  'sleep_ms', 'exit', 'panic', 'env_has', 'env_get', 'args',
  'file_exists', 'file_read', 'file_write', 'file_delete',
]);

type FnLike = MirFunction | MirClosureDecl;

export function verifyMirModule(module: MirModule): MirVerifyError[] {
  const errors: MirVerifyError[] = [];
  const fns = new Map<string, FnLike>();
  const consts = new Set<string>();
  const types = new Set<string>();
  for (const d of module.decls) {
    if (d.kind === 'fn' || d.kind === 'closure_fn') fns.set(d.name, d);
    else if (d.kind === 'const') consts.add(d.name);
    else if (d.kind === 'struct' || d.kind === 'enum') types.add(d.name);
  }
  for (const d of module.decls) {
    if (d.kind === 'fn' || d.kind === 'closure_fn') verifyFunction(d, fns, consts, types, errors);
  }
  return errors;
}

// ----------------------------------------------------------------------------
// Per-function verification
// ----------------------------------------------------------------------------

function verifyFunction(fn: FnLike, fns: Map<string, FnLike>, consts: Set<string>, types: Set<string>, errors: MirVerifyError[]): void {
  const fname = fn.name;
  const labelOf = new Map<string, MirBlock>();

  if (fn.blocks.length === 0) {
    errors.push({ fn: fname, message: 'function has no blocks' });
    return;
  }
  for (const b of fn.blocks) {
    if (labelOf.has(b.label)) {
      errors.push({ fn: fname, block: b.label, message: `duplicate block label '${b.label}'` });
    }
    labelOf.set(b.label, b);
  }

  // Only the entry block may declare params: terminators in this IR version
  // carry no block arguments (phi/SSA is a future pass).
  for (let i = 0; i < fn.blocks.length; i++) {
    const b = fn.blocks[i]!;
    if (i > 0 && b.params.length > 0) {
      errors.push({ fn: fname, block: b.label, message: `non-entry block '${b.label}' has params; block arguments are not supported yet` });
    }
  }

  // Terminator checks + predecessor map for the dataflow pass.
  const preds = new Map<string, Set<string>>();
  for (const b of fn.blocks) preds.set(b.label, new Set());
  for (const b of fn.blocks) {
    if (!b.term) {
      errors.push({ fn: fname, block: b.label, message: `block '${b.label}' has no terminator` });
      continue;
    }
    checkTerm(b.term, b, fn, labelOf, preds, errors);
    for (const instr of b.instrs) {
      if (isTerminatorKind(instr)) {
        errors.push({ fn: fname, block: b.label, message: `terminator-like instruction '${(instr as { kind: string }).kind}' found inside block instruction list` });
      }
    }
  }

  checkLocals(fn, preds, fns, consts, types, errors);

  for (const b of fn.blocks) {
    for (const instr of b.instrs) checkInstrTypes(instr, b, fn, fns, errors);
    if (b.term && b.term.kind === 'branch') {
      expectBool(b.term.cond.type, b, fn, 'branch condition must be Bool', errors);
    }
    if (b.term && b.term.kind === 'return') checkReturnType(b.term.value, b, fn, errors);
  }
}

function isTerminatorKind(instr: MirInstr): boolean {
  const k = (instr as { kind: string }).kind;
  return k === 'jump' || k === 'branch' || k === 'return' || k === 'unreachable';
}

function checkTerm(
  term: MirTerm, b: MirBlock, fn: FnLike,
  labelOf: Map<string, MirBlock>, preds: Map<string, Set<string>>,
  errors: MirVerifyError[],
): void {
  const targets: string[] = [];
  switch (term.kind) {
    case 'jump': targets.push(term.target); break;
    case 'branch': targets.push(term.thenLabel, term.elseLabel); break;
    case 'return':
    case 'unreachable': break;
    default:
      errors.push({ fn: fn.name, block: b.label, message: `unknown terminator kind '${(term as { kind: string }).kind}'` });
      return;
  }
  for (const t of targets) {
    if (!labelOf.has(t)) {
      errors.push({ fn: fn.name, block: b.label, message: `terminator references missing block '${t}'` });
    } else {
      preds.get(t)!.add(b.label);
    }
  }
}

// ----------------------------------------------------------------------------
// Local def/use analysis
// ----------------------------------------------------------------------------

function collectValueUses(v: unknown, out: string[]): void {
  if (v === null || typeof v !== 'object') return;
  const val = v as MirValue;
  switch (val.kind) {
    case 'ref': out.push(val.name); break;
    case 'lit': break;
    case 'bin':
      collectValueUses((val as { left: MirValue }).left, out);
      collectValueUses((val as { right: MirValue }).right, out);
      break;
    case 'unary': collectValueUses((val as { expr: MirValue }).expr, out); break;
    case 'call': {
      const call = val as { callee: MirValue; args: MirValue[] };
      collectValueUses(call.callee, out);
      for (const a of call.args) collectValueUses(a, out);
      break;
    }
    case 'field': collectValueUses((val as { obj: MirValue }).obj, out); break;
    case 'index': {
      const ix = val as { obj: MirValue; index: MirValue };
      collectValueUses(ix.obj, out);
      collectValueUses(ix.index, out);
      break;
    }
    case 'struct_lit':
      for (const f of (val as { fields: Array<{ value: MirValue }> }).fields) collectValueUses(f.value, out);
      break;
    case 'array_lit':
      for (const e of (val as { elements: MirValue[] }).elements) collectValueUses(e, out);
      break;
    case 'map_lit':
      for (const e of (val as { entries: Array<{ key: MirValue; value: MirValue }> }).entries) {
        collectValueUses(e.key, out);
        collectValueUses(e.value, out);
      }
      break;
    case 'enum_lit': {
      const d = (val as { data?: MirValue }).data;
      if (d !== undefined) collectValueUses(d, out);
      break;
    }
    case 'closure_ref':
      for (const c of (val as { captures: MirValue[] }).captures) collectValueUses(c, out);
      break;
    case 'intrinsic': collectValueUses((val as { arg: MirValue }).arg, out); break;
  }
}

function instrUses(instr: MirInstr): string[] {
  const uses: string[] = [];
  switch (instr.kind) {
    case 'assign': collectValueUses(instr.value, uses); break;
    case 'store_field':
      collectValueUses(instr.obj, uses);
      collectValueUses(instr.value, uses);
      break;
    case 'store_index':
      collectValueUses(instr.obj, uses);
      collectValueUses(instr.index, uses);
      collectValueUses(instr.value, uses);
      break;
  }
  return uses;
}

function termUses(term: MirTerm): string[] {
  const uses: string[] = [];
  if (term.kind === 'branch') collectValueUses(term.cond, uses);
  else if (term.kind === 'return' && term.value) collectValueUses(term.value, uses);
  return uses;
}

/**
 * May-def union fixpoint over the CFG, then a linear walk of each block:
 * a local use must be live (defined on entry along some path), defined
 * earlier in the same block, or external (fn/closure/const/native).
 */
function checkLocals(
  fn: FnLike, preds: Map<string, Set<string>>,
  fns: Map<string, FnLike>, consts: Set<string>, types: Set<string>,
  errors: MirVerifyError[],
): void {
  const blocks = fn.blocks;
  const entry = blocks[0]!;

  const mayDefs = new Map<string, Set<string>>();
  for (const b of blocks) {
    const s = new Set<string>();
    for (const p of b.params) s.add(p.name);
    for (const instr of b.instrs) if (instr.kind === 'assign') s.add(instr.name);
    mayDefs.set(b.label, s);
  }

  const defsIn = new Map<string, Set<string>>();
  for (const b of blocks) defsIn.set(b.label, new Set<string>());
  defsIn.set(entry.label, new Set<string>([
    ...entry.params.map((p) => p.name),
    ...mayDefs.get(entry.label)!,
  ]));
  const defsOut = new Map<string, Set<string>>();
  for (const b of blocks) defsOut.set(b.label, new Set<string>(mayDefs.get(b.label)!));
  defsOut.set(entry.label, new Set<string>(defsIn.get(entry.label)!));

  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (const b of blocks) {
      if (b.label === entry.label) continue;
      const inSet = defsIn.get(b.label)!;
      for (const p of preds.get(b.label) ?? []) {
        for (const d of defsOut.get(p) ?? []) {
          if (!inSet.has(d)) { inSet.add(d); changed = true; }
        }
      }
      const out = defsOut.get(b.label)!;
      for (const d of inSet) {
        if (!out.has(d)) { out.add(d); changed = true; }
      }
    }
    if (!changed) break;
  }

  const isExternal = (name: string): boolean =>
    fns.has(name) || consts.has(name) || types.has(name) || NATIVE_NAMES.has(name);

  for (const b of blocks) {
    const live = new Set<string>(defsIn.get(b.label)!);
    const reported = new Set<string>();
    const reportUse = (name: string): void => {
      if (live.has(name) || isExternal(name) || reported.has(name)) return;
      reported.add(name);
      errors.push({ fn: fn.name, block: b.label, message: `local '${name}' used before definition` });
    };
    for (const instr of b.instrs) {
      for (const u of instrUses(instr)) reportUse(u);
      if (instr.kind === 'assign') live.add(instr.name);
    }
    if (b.term) for (const u of termUses(b.term)) reportUse(u);
  }
}

// ----------------------------------------------------------------------------
// Type checks
// ----------------------------------------------------------------------------

function isVarType(t: HirType | undefined): boolean {
  return t === undefined || t.kind === 'var';
}

/**
 * The typechecker does not propagate an expected type into `ok/error/some/
 * none` literals (they are typed from their operands: `ok(1)` is
 * `Result<Int, Null>`, `none` is `Null?`), while annotations like
 * `Result<Int, String>` lower to a nominal type. At the MIR level those
 * shapes are compared laxly: any Result-shaped pair or any Option-shaped
 * pair is compatible; everything else must match exactly.
 */
function isResultShape(t: HirType): boolean {
  return t.kind === 'result' || ((t.kind === 'nominal' || t.kind === 'struct') && t.name === 'Result');
}

function isOptionShape(t: HirType): boolean {
  return t.kind === 'optional' || ((t.kind === 'nominal' || t.kind === 'struct') && t.name === 'Option');
}

/**
 * `Null` is the HIR placeholder for `unknown` (the typechecker's T_UNKNOWN,
 * e.g. an unannotated closure parameter). At the MIR level it is treated as
 * compatible with anything: it cannot be narrower than the real runtime type.
 */
function isNullShape(t: HirType): boolean {
  return t.kind === 'prim' && t.name === 'Null';
}

/**
 * Function types are compatible when they have the same arity: a `Null`
 * parameter (the HIR placeholder for an unannotated closure parameter) is
 * treated as compatible with any parameter type.
 */
function fnTypesCompatible(a: HirType, b: HirType): boolean {
  if (a.kind !== 'fn' || b.kind !== 'fn') return false;
  if (a.params.length !== b.params.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (!typesCompatible(a.params[i]!.type, b.params[i]!.type)) return false;
  }
  return typesCompatible(a.ret, b.ret);
}

function typesCompatible(a: HirType, b: HirType): boolean {
  if (isVarType(a) || isVarType(b)) return true;
  if (isNullShape(a) || isNullShape(b)) return true;
  if (mirTypeString(a) === mirTypeString(b)) return true;
  if (isNumericStr(mirTypeString(a)) && isNumericStr(mirTypeString(b))) return true;
  if (isResultShape(a) && isResultShape(b)) return true;
  if (isOptionShape(a) && isOptionShape(b)) return true;
  if (fnTypesCompatible(a, b)) return true;
  return false;
}

function isNumericStr(t: string): boolean {
  return t === 'Int' || t === 'Float';
}

function expectBool(actual: HirType, b: MirBlock, fn: FnLike, what: string, errors: MirVerifyError[]): void {
  if (isVarType(actual)) return;
  const s = mirTypeString(actual);
  if (s !== 'Bool') {
    errors.push({ fn: fn.name, block: b.label, message: `${what}: found ${s}` });
  }
}

function checkInstrTypes(instr: MirInstr, b: MirBlock, fn: FnLike, fns: Map<string, FnLike>, errors: MirVerifyError[]): void {
  const push = (message: string): void => errors.push({ fn: fn.name, block: b.label, message });
  switch (instr.kind) {
    case 'assign': {
      if (instr.value.type && !typesCompatible(instr.value.type, instr.type)) {
        push(`assign to '${instr.name}': type ${mirTypeString(instr.type)} does not match value type ${mirTypeString(instr.value.type)}`);
      }
      checkValueType(instr.value, b, fn, fns, errors);
      break;
    }
    case 'store_field':
      checkValueType(instr.obj, b, fn, fns, errors);
      checkValueType(instr.value, b, fn, fns, errors);
      break;
    case 'store_index':
      checkValueType(instr.obj, b, fn, fns, errors);
      checkValueType(instr.index, b, fn, fns, errors);
      checkValueType(instr.value, b, fn, fns, errors);
      break;
  }
}

function checkValueType(v: MirValue, b: MirBlock, fn: FnLike, fns: Map<string, FnLike>, errors: MirVerifyError[]): void {
  const push = (message: string): void => errors.push({ fn: fn.name, block: b.label, message });
  switch (v.kind) {
    case 'lit':
    case 'ref':
      break;
    case 'bin': {
      const bin = v as { op: string; left: MirValue; right: MirValue; type: HirType };
      checkValueType(bin.left, b, fn, fns, errors);
      checkValueType(bin.right, b, fn, fns, errors);
      if (isVarType(bin.left.type) || isVarType(bin.right.type)) break;
      const lt = mirTypeString(bin.left.type);
      const rt = mirTypeString(bin.right.type);
      const numOps = ['+', '-', '*', '/', '%', '<', '<=', '>', '>='];
      if (bin.op === 'and' || bin.op === 'or') {
        if ((lt !== 'Bool' || rt !== 'Bool') && !isNullShape(bin.left.type) && !isNullShape(bin.right.type)) {
          push(`'${bin.op}' requires Bool operands, found ${lt} and ${rt}`);
        }
      } else if (numOps.includes(bin.op)) {
        const lOk = isNumericStr(lt) || isNullShape(bin.left.type);
        const rOk = isNumericStr(rt) || isNullShape(bin.right.type);
        if (!(lOk && rOk) && !(bin.op === '+' && lt === 'String' && rt === 'String')) {
          push(`'${bin.op}' requires numeric operands, found ${lt} and ${rt}`);
        }
      } else if (bin.op === '==' || bin.op === '!=') {
        if (!typesCompatible(bin.left.type, bin.right.type)) {
          push(`'${bin.op}' requires same operand types, found ${lt} and ${rt}`);
        }
      }
      break;
    }
    case 'unary': {
      const u = v as { op: string; expr: MirValue };
      checkValueType(u.expr, b, fn, fns, errors);
      if (!isVarType(u.expr.type)) {
        const t = mirTypeString(u.expr.type);
        if (u.op === '-' && !isNumericStr(t) && !isNullShape(u.expr.type)) {
          push(`unary '-' requires a numeric operand, found ${t}`);
        }
        if ((u.op === '!' || u.op === 'not') && t !== 'Bool' && !isNullShape(u.expr.type)) {
          push(`unary '${u.op}' requires Bool, found ${t}`);
        }
      }
      break;
    }
    case 'call': {
      const call = v as { callee: MirValue; args: MirValue[] };
      checkValueType(call.callee, b, fn, fns, errors);
      for (const a of call.args) checkValueType(a, b, fn, fns, errors);
      if (call.callee.kind === 'ref' && fns.has(call.callee.name)) {
        const target = fns.get(call.callee.name)!;
        const expected = target.params.length - (target.kind === 'closure_fn' ? target.captured.length : 0);
        if (call.args.length !== expected) {
          push(`call to '${target.name}': expected ${expected} argument(s), found ${call.args.length}`);
        }
      }
      break;
    }
    case 'field': checkValueType((v as { obj: MirValue }).obj, b, fn, fns, errors); break;
    case 'index': {
      const ix = v as { obj: MirValue; index: MirValue };
      checkValueType(ix.obj, b, fn, fns, errors);
      checkValueType(ix.index, b, fn, fns, errors);
      break;
    }
    case 'struct_lit':
      for (const f of (v as { fields: Array<{ value: MirValue }> }).fields) checkValueType(f.value, b, fn, fns, errors);
      break;
    case 'array_lit':
      for (const e of (v as { elements: MirValue[] }).elements) checkValueType(e, b, fn, fns, errors);
      break;
    case 'map_lit':
      for (const e of (v as { entries: Array<{ key: MirValue; value: MirValue }> }).entries) {
        checkValueType(e.key, b, fn, fns, errors);
        checkValueType(e.value, b, fn, fns, errors);
      }
      break;
    case 'enum_lit': {
      const d = (v as { data?: MirValue }).data;
      if (d !== undefined) checkValueType(d, b, fn, fns, errors);
      break;
    }
    case 'closure_ref':
      for (const c of (v as { captures: MirValue[] }).captures) checkValueType(c, b, fn, fns, errors);
      break;
    case 'intrinsic': {
      const intr = v as { op: string; arg: MirValue; type: HirType };
      checkValueType(intr.arg, b, fn, fns, errors);
      if (!isVarType(intr.arg.type)) {
        const isOpt = intr.op === 'is_some' || intr.op === 'is_none' || intr.op === 'unwrap_some';
        const isRes = intr.op === 'is_ok' || intr.op === 'is_err' || intr.op === 'unwrap_ok' || intr.op === 'unwrap_err';
        if (isOpt && !isOptionShape(intr.arg.type)) {
          push(`intrinsic '${intr.op}' expects an Option, found ${mirTypeString(intr.arg.type)}`);
        }
        if (isRes && !isResultShape(intr.arg.type)) {
          push(`intrinsic '${intr.op}' expects a Result, found ${mirTypeString(intr.arg.type)}`);
        }
      }
      break;
    }
  }
}

function checkReturnType(value: MirValue | undefined, b: MirBlock, fn: FnLike, errors: MirVerifyError[]): void {
  const ret = fn.ret;
  if (ret.kind === 'void') {
    if (value && !isVarType(value.type) && mirTypeString(value.type) !== 'Void') {
      errors.push({ fn: fn.name, block: b.label, message: `void function returns a value of type ${mirTypeString(value.type)}` });
    }
    return;
  }
  if (!value) {
    errors.push({ fn: fn.name, block: b.label, message: `function '${fn.name}' must return a value of type ${mirTypeString(ret)}` });
    return;
  }
  if (!typesCompatible(value.type, ret)) {
    errors.push({
      fn: fn.name, block: b.label,
      message: `return type mismatch: expected ${mirTypeString(ret)}, found ${mirTypeString(value.type)}`,
    });
  }
}



