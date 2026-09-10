/**
 * MIR → LLVM IR lowering.
 *
 * This is the real native backend of NOVA. It consumes *MIR only* (never the
 * AST) and produces a `LlvmModule` — real LLVM IR that `llc` can compile to a
 * COFF object and `lld-link` can link into a PE executable.
 *
 * Lowering summary:
 *   - Every MIR basic block becomes an LLVM basic block; `jump`/`branch`/
 *     `return`/`unreachable` map to `br`/`br`/`ret`/`unreachable` terminators.
 *   - MIR locals are NOT SSA: the same name can be assigned several times
 *     (e.g. `i = i + 1`). This pass performs real SSA construction: it finds
 *     phi insertion points on the dominance frontier of each multi-defined
 *     local and renames definitions/uses so every LLVM register is defined
 *     exactly once.
 *   - Types come from the M4 ABI via `hirToLlvmType` (Int→i64, Float→double,
 *     Bool→i8, String→{i8*,i64}, Option/Result→tagged structs, ...).
 *   - Arrays lower to the ABI fat-pointer + the native runtime
 *     (`nova_array_new`/`nova_array_get`) for allocation and bounds checks.
 *
 * Deterministic: same input ⇒ same IR byte-for-byte.
 */

import type {
  MirModule, MirDecl, MirFunction, MirClosureDecl, MirStructDecl, MirEnumDecl,
  MirConstDecl, MirBlock, MirInstr, MirTerm, MirValue, MirLit,
} from '../../mir/mir.ts';
import type { HirType } from '../../hir/hir.ts';
import type { SymbolTables } from '../backend.ts';
import type { TargetSpec } from '../../target/target.ts';
import { WINDOWS_X64 } from '../../target/target.ts';
import { LlvmModule } from './llvm_ir.ts';
import { hirToLlvmType, isPtrLike, llvmIdent, llvmDoubleLiteral, llvmEscapeString, fnLLVMType } from './llvm_types.ts';
import { runtimeIr } from './llvm_runtime.ts';
import { NovaNativeError } from '../native_error.ts';

export interface LlvmCodegenOptions {
  moduleName?: string;
  target?: TargetSpec;
}

export interface LlvmCodegenResult {
  module: LlvmModule;
  /** LLVM name of the entry function (e.g. `@f0`), or null if no `main`. */
  entry: string | null;
}

type FnLike = MirFunction | MirClosureDecl;

/** Native builtins implemented by this backend. */
const NATIVE_SUPPORTED = new Set([
  'print', 'println', 'input', 'len', 'int', 'float', 'abs', 'min', 'max',
  'sqrt', 'pow', 'floor', 'ceil', 'round',
  'clock_ms', 'sleep_ms', 'exit', 'panic', 'env_has', 'env_get', 'args',
  'file_exists', 'file_read', 'file_write', 'file_delete',
]);

const INT: HirType = { kind: 'prim', name: 'Int' };
const FLOAT: HirType = { kind: 'prim', name: 'Float' };
const BOOL: HirType = { kind: 'prim', name: 'Bool' };
const VOID_T: HirType = { kind: 'void' };

/** MIR → LLVM. `symbols` is used for nominal resolution. */
export function mirToLlvm(mir: MirModule, symbols: SymbolTables, opts: LlvmCodegenOptions = {}): LlvmCodegenResult {
  return new LlvmCodegen(mir, symbols, opts).generate();
}

class LlvmCodegen {
  readonly mir: MirModule;
  readonly symbols: SymbolTables;
  readonly opts: LlvmCodegenOptions;
  readonly target: TargetSpec;
  readonly module = new LlvmModule();

  readonly fns = new Map<string, FnLike>();
  readonly structs = new Map<string, MirStructDecl>();
  readonly enums = new Map<string, MirEnumDecl>();
  readonly consts = new Map<string, MirConstDecl>();
  readonly fnId = new Map<string, string>();       // mir name → @fN
  readonly structId = new Map<string, string>();   // mir name → %sN
  readonly strGlobal = new Map<string, string>();  // literal → @.sN
  private strSeq = 0;
  private structSeq = 0;
  entry: string | null = null;

  constructor(mir: MirModule, symbols: SymbolTables, opts: LlvmCodegenOptions) {
    this.mir = mir;
    this.symbols = symbols;
    this.opts = opts;
    this.target = opts.target ?? WINDOWS_X64;
  }

  generate(): LlvmCodegenResult {
    this.collectDecls();
    if (this.target.triple !== WINDOWS_X64.triple) {
      throw new NovaNativeError('NOVA2001', `target '${this.target.triple}' is not implemented by the native LLVM runtime yet`);
    }
    this.module.addHeader(`target triple = "${this.target.triple}"`);
    this.module.addHeader(`target datalayout = "${this.target.dataLayout}"`);
    this.emitStructTypedefs();
    this.emitConsts();

    const rt = runtimeIr();
    for (const e of rt.externs) this.module.addExtern(e);
    for (const g of rt.globals) this.module.addGlobal(g);

    for (const d of this.mir.decls) {
      if (d.kind === 'fn' || d.kind === 'closure_fn') {
        const body = this.emitFunction(d);
        this.module.addFunc(body);
        if (d.name === 'main') this.entry = this.fnId.get(d.name) ?? 'f0';
      }
    }
    const mainFn = this.fns.get('main');
    if (mainFn && mainFn.params.length === 0 && mainFn.ret.kind === 'void' && this.entry) {
      this.module.addFunc([
        'define i32 @nova_entry() {',
        'entry:',
        `  call void ${this.entry}()`,
        '  call void @ExitProcess(i32 0)',
        '  unreachable',
        '}',
      ]);
      this.entry = '@nova_entry';
    }
    for (const f of rt.funcs) this.module.addFunc(f);
    return { module: this.module, entry: this.entry };
  }

  private collectDecls(): void {
    let fnSeq = 0;
    for (const d of this.mir.decls) {
      switch (d.kind) {
        case 'fn':
        case 'closure_fn':
          this.fns.set(d.name, d);
          this.fnId.set(d.name, `@f${fnSeq++}`);
          break;
        case 'struct':
          this.structs.set(d.name, d);
          this.structId.set(d.name, `%s${this.structSeq++}`);
          break;
        case 'enum': this.enums.set(d.name, d); break;
        case 'const': this.consts.set(d.name, d); break;
      }
    }
  }

  private emitStructTypedefs(): void {
    for (const [name, decl] of this.structs) {
      const fields = decl.fields.map((f) => this.llvmType(f.type)).join(', ');
      this.module.addTypedef(`${this.structId.get(name)} = type { ${fields} }`);
    }
  }

  llvmType(t: HirType): string {
    return hirToLlvmType(t, (name: string) => this.structId.get(name) ?? null);
  }

  /** String literal → constant name (`@.sN`), registering the global once. */
  private stringGlobal(s: string): string {
    const existing = this.strGlobal.get(s);
    if (existing) return existing;
    const name = `@.s${this.strSeq++}`;
    const bytes = llvmEscapeString(s);
    this.strGlobal.set(s, name);
    this.module.addGlobal(`${name} = private unnamed_addr constant [${bytes.length} x i8] c"${bytes}"`);
    return name;
  }

  /** Emit a string literal as an operand `{ i8* gep(...), i64 len }`. */
  private stringOperand(s: string): string {
    const g = this.stringGlobal(s);
    const len = new TextEncoder().encode(s).length;
    return `{ i8* getelementptr ([${len} x i8], [${len} x i8]* ${g}, i64 0, i64 0), i64 ${len} }`;
  }

  // -- constants -------------------------------------------------------------

  private emitConsts(): void {
    for (const [name, decl] of this.consts) {
      const [typeStr, valStr] = this.constantIr(decl);
      const gname = `@c${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
      this.module.addGlobal(`${gname} = private global ${typeStr} ${valStr}`);
    }
  }

  /** Value + type for a const decl; only literal/tag-free constants supported. */
  private constantIr(decl: MirConstDecl): [string, string] {
    const t = decl.type;
    const v = decl.value;
    if (v.kind === 'lit') {
      const typeStr = this.llvmType(t);
      return [typeStr, this.litOperand(v, t)];
    }
    // Complex const values (calls, bins) are not supported at M5 — the same
    // sources compile fine through the JS/interpreter backends.
    throw new NovaNativeError('NOVA2001', `const '${decl.name}' has a non-literal value; not supported by the native backend yet`);
  }

  // --------------------------------------------------------------------------
  // Function emission
  // --------------------------------------------------------------------------

  private emitFunction(fn: FnLike): string[] {
    const fb = new FnBuilder(this, fn);
    return fb.build();
  }

  /** LLVM operand for a literal, in the context of `asType`. */
  litOperand(v: MirLit, asType: HirType): string {
    switch (asType.kind) {
      case 'prim':
        switch (asType.name) {
          case 'Int': return `${litInt(v.value)}`;
          case 'Float': return llvmDoubleLiteral(litNum(v.value));
          case 'Bool': return v.value === true ? '1' : '0';
          case 'String': {
            if (typeof v.value !== 'string') return 'zeroinitializer';
            return this.stringOperand(v.value);
          }
          case 'Null': return '0';
        }
        break;
      case 'enum': return `${litInt(v.value)}`;
      case 'void': return 'void';
      case 'array': case 'map': return 'zeroinitializer';
      case 'optional': case 'result': case 'struct': return 'zeroinitializer';
      case 'fn': return 'null';
      case 'nominal': return this.litOperand(v, asType.inner);
      case 'var': return '0';
    }
    return 'zeroinitializer';
  }

  /** Size in bytes of a value of `t` (via the M4 ABI sizes). */
  abiSizeBytes(t: HirType): number {
    // Map the small subset of M5 types directly; mirrors ABI sizes.
    switch (t.kind) {
      case 'prim':
        switch (t.name) {
          case 'Int': case 'Float': return 8;
          case 'Bool': return 1;
          case 'String': return 16;
          case 'Null': return 0;
        }
        break;
      case 'enum': return 8;
      case 'fn': return 8;
      case 'array': case 'map': return 16;
      case 'optional': return isPtrLike(t) ? 16 : 9 + 7;
    }
    return 8;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function litInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

function litNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return 0;
}

// ----------------------------------------------------------------------------
// Per-function MIR → LLVM builder (SSA construction + emission)
// ----------------------------------------------------------------------------

interface PhiEntry { name: string; reg: string; type: string; }

class FnBuilder {
  readonly gen: LlvmCodegen;
  readonly fn: FnLike;
  readonly llvmName: string;
  readonly blocks: MirBlock[];
  readonly paramRegs: string[] = [];
  readonly localTypes = new Map<string, HirType>();

  readonly preds = new Map<string, string[]>();
  readonly succs = new Map<string, string[]>();
  readonly reachable = new Set<string>();
  readonly dom = new Map<string, Set<string>>();
  readonly domChildren = new Map<string, string[]>();

  private regSeq = 0;
  private versions = new Map<string, string[]>();
  private phiDefs = new Map<string, Set<string>>();
  private phiRegs = new Map<string, Map<string, string>>();  // block → name → φ reg
  private phiArgs = new Map<string, Map<string, Map<string, string | null>>>();
  private instrLines = new Map<string, string[]>();
  private termLines = new Map<string, string>();

  constructor(gen: LlvmCodegen, fn: FnLike) {
    this.gen = gen;
    this.fn = fn;
    this.llvmName = gen.fnId.get(fn.name)!;
    this.blocks = fn.blocks;
  }

  private abort(msg: string): never {
    throw new NovaNativeError('NOVA2001', `in fn '${this.fn.name}': ${msg}`);
  }

  private fresh(): string { return `%t${this.regSeq++}`; }

  private localType(name: string): HirType {
    const t = this.localTypes.get(name);
    if (t) return t;
    this.abort(`unknown local '${name}'`);
  }

  build(): string[] {
    this.buildCfg();
    this.computeDominators();
    this.collectLocals();
    this.computePhis();
    this.renameAndEmit();
    return this.assemble();
  }

  // -- CFG -------------------------------------------------------------------

  private termSuccs(t: MirTerm): string[] {
    switch (t.kind) {
      case 'jump': return [t.target];
      case 'branch': return [t.thenLabel, t.elseLabel];
      case 'return': case 'unreachable': return [];
    }
  }

  private buildCfg(): void {
    for (const b of this.blocks) {
      const succ = this.termSuccs(b.term);
      this.succs.set(b.label, succ);
      for (const s of succ) {
        const list = this.preds.get(s);
        if (list) list.push(b.label);
        else this.preds.set(s, [b.label]);
      }
    }
    const order = new Map<string, number>();
    this.blocks.forEach((b, i) => order.set(b.label, i));
    for (const ps of this.preds.values()) {
      ps.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }
    const stack = [this.blocks[0]?.label].filter((l) => l !== undefined);
    while (stack.length > 0) {
      const l = stack.pop()!;
      if (this.reachable.has(l)) continue;
      this.reachable.add(l);
      for (const s of this.succs.get(l) ?? []) stack.push(s);
    }
  }

  private computeDominators(): void {
    const ids = new Map<string, number>();
    const labels: string[] = [];
    this.blocks.forEach((b, i) => { ids.set(b.label, i); labels.push(b.label); });
    const n = labels.length;
    const entry = labels[0];
    const domBits = new Array<Set<number>>(n);
    for (let i = 0; i < n; i++) domBits[i] = new Set<number>();
    domBits[ids.get(entry)!] = new Set([ids.get(entry)!]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 1; i < n; i++) {
        const label = labels[i]!;
        const preds = this.preds.get(label) ?? [];
        if (preds.length === 0) continue;
        let inter: Set<number> | null = null;
        for (const p of preds) {
          const pset = domBits[ids.get(p)!]!;
          inter = inter === null ? new Set(pset)
            : new Set([...inter].filter((x) => pset.has(x)));
        }
        if (inter === null) continue;
        const next = inter;
        next.add(i);
        const old = domBits[i]!;
        if (old.size !== next.size || [...next].some((x) => !old.has(x))) {
          domBits[i] = next;
          changed = true;
        }
      }
    }
    const domSet = new Map<string, Set<string>>();
    for (let i = 0; i < n; i++) {
      domSet.set(labels[i]!, new Set([...domBits[i]!].map((j) => labels[j]!)));
    }
    for (let i = 0; i < n; i++) {
      const label = labels[i]!;
      const dset = domSet.get(label)!;
      if (dset.size === 0) continue;
      if (i === 0) { this.dom.set(label, dset); continue; }
      const cands = [...dset].filter((l) => l !== label);
      let best: string | null = null;
      for (const c of cands) {
        if (cands.every((x) => x === c || (domSet.get(x)?.has(c) ?? false))) { best = c; break; }
      }
      if (best) {
        const kids = this.domChildren.get(best);
        if (kids) kids.push(label);
        else this.domChildren.set(best, [label]);
      }
    }
  }

  // -- locals & phi placement -------------------------------------------------

  private collectLocals(): void {
    for (const p of this.fn.params) this.localTypes.set(p.name, p.type);
    for (const b of this.blocks) {
      for (const ins of b.instrs) {
        if (ins.kind === 'assign') this.localTypes.set(ins.name, ins.type);
      }
    }
  }

  /** Find multi-defined locals and their phi insertion blocks. */
  private computePhis(): void {
    const defSites = new Map<string, Set<string>>();
    for (const b of this.blocks) {
      for (const ins of b.instrs) {
        if (ins.kind !== 'assign') continue;
        const s = defSites.get(ins.name);
        if (s) s.add(b.label);
        else defSites.set(ins.name, new Set([b.label]));
      }
    }
    const order = new Map<string, number>();
    this.blocks.forEach((b, i) => order.set(b.label, i));
    for (const [name, sites] of defSites) {
      if (sites.size < 2) continue;
      const work = [...sites];
      const seen = new Set<string>();
      while (work.length > 0) {
        const d = work.pop()!;
        for (const s of this.succs.get(d) ?? []) {
          if ((this.preds.get(s)?.length ?? 0) < 2) continue; // single pred: no join
          if (sites.has(s)) continue;                          // defined in s — no φ
          if (seen.has(s)) continue;
          seen.add(s);
          const phis = this.phiDefs.get(s);
          if (phis) phis.add(name);
          else this.phiDefs.set(s, new Set([name]));
          sites.add(s); // φ is a definition too (for further joins)
          work.push(s);
        }
      }
    }
    // Deterministic order for phi names per block (same as function block order).
    void order;
  }

  // -- renaming (SSA construction) --------------------------------------------

  private renameAndEmit(): void {
    const entry = this.blocks[0]?.label;
    if (!entry) return;
    // Pre-create phiArg maps for every reachable block (preds record into them
    // before the block itself is visited).
    for (const b of this.blocks) {
      if (this.reachable.has(b.label)) this.phiArgs.set(b.label, new Map());
    }
    // Parameters define entry versions.
    const argNames: string[] = [];
    for (let i = 0; i < this.fn.params.length; i++) {
      const p = this.fn.params[i]!;
      const reg = `%arg${i}`;
      argNames.push(reg);
      this.versions.set(p.name, [reg]);
    }
    this.paramRegs.push(...argNames);
    this.visitBlock(entry, new Set());
    for (const b of this.blocks) {
      if (this.reachable.has(b.label) && !this.instrLines.has(b.label)) this.visitIsolated(b.label);
    }
  }

  private visitBlock(label: string, seen: Set<string>): void {
    if (seen.has(label)) return;
    seen.add(label);
    const instrs: string[] = [];
    this.instrLines.set(label, instrs);
    this.phiArgs.set(label, new Map());
    this.pushPhis(label);
    for (const ins of this.blocks[this.index(label)]!.instrs) {
      this.emitInstr(ins, instrs);
    }
    this.termLines.set(label, this.emitTerm(this.blocks[this.index(label)]!.term, instrs));
    for (const child of this.domChildren.get(label) ?? []) {
      if (this.reachable.has(child)) this.visitBlock(child, seen);
    }
    this.popPhis(label);
  }

  /** Visit a reachable block outside the dom-tree (defensive fallback). */
  private visitIsolated(label: string): void {
    const instrs: string[] = [];
    this.instrLines.set(label, instrs);
    this.phiArgs.set(label, new Map());
    this.pushPhis(label);
    for (const ins of this.blocks[this.index(label)]!.instrs) {
      this.emitInstr(ins, instrs);
    }
    this.termLines.set(label, this.emitTerm(this.blocks[this.index(label)]!.term, instrs));
    this.popPhis(label);
  }

  private index(label: string): number {
    for (let i = 0; i < this.blocks.length; i++) {
      if (this.blocks[i]!.label === label) return i;
    }
    this.abort(`missing block '${label}'`);
  }

  private pushPhis(label: string): void {
    const names = this.phiDefs.get(label);
    if (!names) return;
    const sorted = [...names].sort();
    const map = this.phiRegs.get(label) ?? new Map<string, string>();
    for (const name of sorted) {
      const reg = this.fresh();
      map.set(name, reg);
      const stack = this.versions.get(name) ?? [];
      stack.push(reg);
      this.versions.set(name, stack);
    }
    this.phiRegs.set(label, map);
  }

  private popPhis(label: string): void {
    const names = this.phiDefs.get(label);
    if (!names) return;
    const sorted = [...names].sort();
    for (const name of sorted) this.versions.get(name)!.pop();
  }

  /** Current version of a local (or null when never defined on this path). */
  private currentVersion(name: string): string | null {
    const stack = this.versions.get(name);
    if (stack && stack.length > 0) return stack[stack.length - 1]!;
    if (this.gen.fns.has(name)) return this.gen.fnId.get(name)!;
    if (this.gen.consts.has(name)) return `@c${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
    return null; // native/external names resolved by call sites
  }

  private recordPhiArgs(fromLabel: string, succs: string[]): void {
    for (const s of succs) {
      const phis = this.phiDefs.get(s);
      if (!phis) continue;
      const argMap = this.phiArgs.get(s)!;
      for (const name of phis) {
        const byPred = argMap.get(name);
        const predMap = byPred ?? new Map<string, string | null>();
        predMap.set(fromLabel, this.currentVersion(name));
        argMap.set(name, predMap);
      }
    }
  }

  // -- final assembly ---------------------------------------------------------

  private assemble(): string[] {
    const params: string[] = [];
    for (let i = 0; i < this.fn.params.length; i++) {
      const p = this.fn.params[i]!;
      params.push(`${this.llvmType(this.localType(p.name))} ${this.paramRegs[i]}`);
    }
    const retType = this.llvmType(this.fn.ret);
    const out: string[] = [];
    out.push(`define ${retType} ${this.llvmName}(${params.join(', ')}) {`);
    for (const b of this.blocks) {
      if (!this.reachable.has(b.label)) {
        out.push(`${b.label}:`);
        out.push('  unreachable');
        continue;
      }
      const label = b === this.blocks[0] ? 'entry' : b.label;
      out.push(`${label}:`);
      const phis = this.phiDefs.get(b.label);
      if (phis) {
        const sorted = [...phis].sort();
        const argMap = this.phiArgs.get(b.label)!;
        const predList = this.preds.get(b.label) ?? [];
        const regs = this.phiRegs.get(b.label)!;
        for (const name of sorted) {
          const reg = regs.get(name)!;
          const type = this.llvmType(this.localType(name));
          const byPred = argMap.get(name) ?? new Map<string, string | null>();
          const incoming = predList.map((p) => `[${byPred.get(p) ?? 'undef'}, %${p}]`);
          out.push(`  ${reg} = phi ${type} ${incoming.join(', ')}`);
        }
      }
      for (const line of this.instrLines.get(b.label) ?? []) out.push(`  ${line}`);
      out.push(`  ${this.termLines.get(b.label) ?? 'unreachable'}`);
    }
    out.push('}');
    return out;
  }

  // -- instructions -----------------------------------------------------------

  private emitInstr(ins: MirInstr, out: string[]): void {
    switch (ins.kind) {
      case 'assign': {
        const t = this.localType(ins.name);
        const operand = this.value(ins.value, out);
        if (operand === '$void$') return;
        const stack = this.versions.get(ins.name) ?? [];
        // MIR locals are bindings, not LLVM instructions. Reusing an existing
        // operand must not emit an invalid pseudo-move such as `%x = %y`.
        stack.push(operand);
        this.versions.set(ins.name, stack);
        return;
      }
      case 'store_field': {
        // Structs are LLVM first-class values here: a field store rebuilds the
        // struct value (`insertvalue`) and re-binds the local that owns it.
        // MIR lowering guarantees `obj` is a ref to a local binding.
        const objType = ins.obj.type;
        if (objType.kind !== 'struct') this.abort('store_field on a non-struct value');
        const decl = this.gen.structs.get(objType.name);
        if (!decl) this.abort(`unknown struct '${objType.name}'`);
        const fieldIndex = decl.fields.findIndex((f) => f.name === ins.name);
        if (fieldIndex < 0) this.abort(`struct '${objType.name}' has no field '${ins.name}'`);
        if (ins.obj.kind !== 'ref') this.abort('store_field target is not a local binding');
        const objVal = this.value(ins.obj, out);
        const val = this.value(ins.value, out);
        const st = this.llvmType(objType);
        const reg = this.fresh();
        out.push(`${reg} = insertvalue ${st} ${objVal}, ${val}, ${fieldIndex}`);
        const stack = this.versions.get(ins.obj.name) ?? [];
        stack.push(reg);
        this.versions.set(ins.obj.name, stack);
        return;
      }
      case 'store_index': {
        const arr = this.value(ins.obj, out);
        const idx = this.value(ins.index, out);
        const val = this.value(ins.value, out);
        this.emitStoreIndex(arr, idx, val, ins, out);
        return;
      }
    }
  }

  private emitStoreIndex(arr: string, idx: string, val: string, ins: Extract<MirInstr, { kind: 'store_index' }>, out: string[]): void {
    const elemType = ins.obj.type.kind === 'array' ? ins.obj.type.element : null;
    if (!elemType) this.abort('store_index on a non-array container (maps are not supported yet)');
    const hd = this.fresh();
    out.push(`${hd} = extractvalue { i8*, i64 } ${arr}, 0`);
    const ln = this.fresh();
    out.push(`${ln} = extractvalue { i8*, i64 } ${arr}, 1`);
    const dp = this.fresh();
    out.push(`${dp} = call i8* @nova_array_get(i8* ${hd}, i64 ${idx}, i64 ${ln}, i64 ${this.gen.abiSizeBytes(elemType)})`);
    const tp = this.fresh();
    out.push(`${tp} = bitcast i8* ${dp} to ${this.llvmType(elemType)}*`);
    out.push(`store ${this.llvmType(elemType)} ${val}, ${this.llvmType(elemType)}* ${tp}`);
  }

  // -- terminators ------------------------------------------------------------

  private emitTerm(term: MirTerm, out: string[]): string {
    switch (term.kind) {
      case 'jump':
        this.recordPhiArgs(term.target, [term.target]);
        return `br label %${term.target}`;
      case 'branch': {
        const c = this.value(term.cond, out);
        const c1 = this.fresh();
        out.push(`${c1} = trunc i8 ${c} to i1`);
        this.recordPhiArgs(term.thenLabel, [term.thenLabel]);
        this.recordPhiArgs(term.elseLabel, [term.elseLabel]);
        return `br i1 ${c1}, label %${term.thenLabel}, label %${term.elseLabel}`;
      }
      case 'return': {
        const t = this.fn.ret;
        if (t.kind === 'void') return 'ret void';
        const lit: MirLit = { kind: 'lit', value: 0, type: t };
        const v = term.value ? this.value(term.value, out) : this.gen.litOperand(lit, t);
        return `ret ${this.llvmType(t)} ${v}`;
      }
      case 'unreachable':
        return 'unreachable';
    }
  }

  private llvmType(t: HirType): string {
    return this.gen.llvmType(t);
  }

  // -- values ----------------------------------------------------------------

  /**
   * Lower a `MirValue` to an LLVM operand (register or constant), appending
   * any required instructions to `out`.
   */
  private value(v: MirValue, out: string[]): string {
    switch (v.kind) {
      case 'lit': return this.gen.litOperand(v, v.type);
      case 'ref': return this.refOperand(v.name, v.type, out);
      case 'bin': return this.emitBin(v, out);
      case 'unary': return this.emitUnary(v, out);
      case 'call': return this.emitCall(v, out);
      case 'field': return this.emitField(v, out);
      case 'index': return this.emitIndex(v, out);
      case 'struct_lit': return this.emitStructLit(v, out);
      case 'array_lit': return this.emitArrayLit(v, out);
      case 'map_lit':
        this.abort('map literals are not supported by the native backend yet (M6)');
      case 'enum_lit': return this.emitEnumLit(v, out);
      case 'closure_ref': return this.emitClosureRef(v, out);
      case 'intrinsic': return this.emitIntrinsic(v, out);
    }
    this.abort(`cannot lower value kind '${(v as { kind: string }).kind}'`);
  }

  private refOperand(name: string, type: HirType, out: string[]): string {
    if (type.kind === 'void') return '$void$';
    const t = this.localTypes.get(name);
    if (t || this.fn.params.some((p) => p.name === name)) {
      // Local: use current SSA version.
      const ver = this.currentVersion(name);
      if (ver !== null && !ver.startsWith('@')) return ver;
      this.abort(`local '${name}' referenced before definition on this path`);
    }
    // Global names.
    if (this.gen.fns.has(name)) {
      const reg = this.fresh();
      out.push(`${reg} = bitcast ${this.gen.fnId.get(name)} to i8*`);
      return reg;
    }
    if (this.gen.consts.has(name)) return `@c${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
    this.abort(`cannot resolve reference to '${name}'`);
  }

  private emitBin(v: Extract<MirValue, { kind: 'bin' }>, out: string[]): string {
    // Comparison ops: result is Bool (i8).
    switch (v.op) {
      case '==': case '!=': case '<': case '<=': case '>': case '>=': {
        const reg = this.cmp(v, out);
        const z = this.fresh();
        out.push(`${z} = zext i1 ${reg} to i8`);
        return z;
      }
      case 'and': case 'or': {
        const a = this.value(v.left, out);
        const b = this.value(v.right, out);
        const a1 = this.fresh(); out.push(`${a1} = trunc i8 ${a} to i1`);
        const b1 = this.fresh(); out.push(`${b1} = trunc i8 ${b} to i1`);
        const r1 = this.fresh();
        out.push(`${r1} = ${v.op === 'and' ? 'and' : 'or'} i1 ${a1}, ${b1}`);
        const z = this.fresh();
        out.push(`${z} = zext i1 ${r1} to i8`);
        return z;
      }
    }
    // Arithmetic.
    if (v.type.kind !== 'prim') this.abort(`arithmetic on non-primitive type`);
    const l = this.value(v.left, out);
    const r = this.value(v.right, out);
    const name = v.type.name;
    const reg = this.fresh();
    const op = this.arithOp(v.op, name);
    const tdesc = name === 'Int' ? 'i64' : name === 'Float' ? 'double' : null;
    if (!tdesc) this.abort(`unsupported arithmetic type '${name}' (${v.op})`);
    out.push(`${reg} = ${op} ${tdesc} ${l}, ${r}`);
    return reg;
  }

  private arithOp(op: string, type: string): string {
    if (type === 'Float') {
      switch (op) {
        case '+': return 'fadd'; case '-': return 'fsub';
        case '*': return 'fmul'; case '/': return 'fdiv';
        case '%': this.abort('Float % is not supported by the native backend yet');
      }
    }
    switch (op) {
      case '+': return 'add'; case '-': return 'sub';
      case '*': return 'mul'; case '/': return 'sdiv'; case '%': return 'srem';
    }
    this.abort(`unknown binary operator '${op}'`);
  }

  private cmp(v: Extract<MirValue, { kind: 'bin' }>, out: string[]): string {
    const l = this.value(v.left, out);
    const r = this.value(v.right, out);
    const lt = v.left.type;
    const reg = this.fresh();
    if (lt.kind === 'prim' && lt.name === 'Float') {
      const op = v.op === '==' ? 'oeq' : v.op === '!=' ? 'one'
        : v.op === '<' ? 'olt' : v.op === '<=' ? 'ole'
        : v.op === '>' ? 'ogt' : 'oge';
      out.push(`${reg} = fcmp ${op} double ${l}, ${r}`);
      return reg;
    }
    // int-ish: signed compares
    const base = this.llvmType(lt);
    const op = v.op === '==' ? 'eq' : v.op === '!=' ? 'ne'
      : v.op === '<' ? 'slt' : v.op === '<=' ? 'sle'
      : v.op === '>' ? 'sgt' : 'sge';
    out.push(`${reg} = icmp ${op} ${base} ${l}, ${r}`);
    return reg;
  }

  private emitUnary(v: Extract<MirValue, { kind: 'unary' }>, out: string[]): string {
    const e = this.value(v.expr, out);
    const reg = this.fresh();
    if (v.op === '-' || v.op === '!') {
      const name = v.expr.type.kind === 'prim' ? v.expr.type.name : null;
      if (v.op === '-') {
        if (name === 'Int') { out.push(`${reg} = sub i64 0, ${e}`); return reg; }
        if (name === 'Float') { out.push(`${reg} = fsub double 0.0, ${e}`); return reg; }
      } else {
        out.push(`${reg} = xor i8 ${e}, 1`);
        return reg;
      }
    }
    if (v.op === 'not') { out.push(`${reg} = xor i8 ${e}, 1`); return reg; }
    this.abort(`unsupported unary '${v.op}'`);
  }

  // -- calls ------------------------------------------------------------------

  private emitCall(v: Extract<MirValue, { kind: 'call' }>, out: string[]): string {
    const args = v.args.map((a) => this.value(a, out));
    if (v.callee.kind === 'ref' && NATIVE_SUPPORTED.has(v.callee.name)) {
      return this.nativeCall(v.callee.name, v, args, out);
    }
    if (v.callee.kind === 'ref' && this.gen.structs.has(v.callee.name)) {
      const decl = this.gen.structs.get(v.callee.name)!;
      if (decl.fields.length !== args.length) this.abort(`struct '${v.callee.name}' expects ${decl.fields.length} field(s), found ${args.length}`);
      let current = 'undef';
      const structType = this.llvmType(v.type);
      for (let i = 0; i < decl.fields.length; i++) {
        const reg = this.fresh();
        out.push(`${reg} = insertvalue ${structType} ${current}, ${args[i]}, ${i}`);
        current = reg;
      }
      return current;
    }
    if (v.callee.kind === 'ref' && this.gen.fns.has(v.callee.name)) {
      return this.emitDirectCall(this.gen.fnId.get(v.callee.name)!, v, args, out);
    }
    // Closure: captured values become leading arguments.
    if (v.callee.kind === 'closure_ref') {
      const target = this.gen.fnId.get(v.callee.fnName)!;
      const capArgs = v.callee.captures.map((c) => this.value(c, out));
      return this.emitDirectCall(target, v, [...capArgs, ...args], out);
    }
    // Dynamic call through a function value (fn-typed local / higher-order).
    const fp = this.value(v.callee, out);
    const fnSig = this.fnSignature(v.callee.type);
    const fpTyped = this.fresh();
    out.push(`${fpTyped} = bitcast i8* ${fp} to ${fnSig}`);
    if (v.type.kind === 'void') {
      out.push(`call ${fnSig} ${fpTyped}(${this.argList(fnSig, args)})`);
      return '$void$';
    }
    const reg = this.fresh();
    out.push(`${reg} = call ${this.llvmType(v.type)} ${fpTyped}(${this.argList(fnSig, args)})`);
    return reg;
  }

  private emitDirectCall(target: string, v: Extract<MirValue, { kind: 'call' }>, argOperands: string[], out: string[]): string {
    const fname = this.fnTargetName(target);
    const fn = this.gen.fns.get(fname)!;
    const params = fn.params.map((p) => this.llvmType(p.type));
    const hasAllTypes = params.length === argOperands.length;
    if (!hasAllTypes) {
      this.abort(`call to '${fname}': expected ${params.length} argument(s), found ${argOperands.length}`);
    }
    const argText = argOperands.map((a, i) => `${params[i] ?? 'i8*'} ${a}`).join(', ');
    if (v.type.kind === 'void') {
      out.push(`call void ${target}(${argText})`);
      return '$void$';
    }
    const reg = this.fresh();
    out.push(`${reg} = call ${this.llvmType(v.type)} ${target}(${argText})`);
    return reg;
  }

  private fnTargetName(target: string): string {
    for (const [name, id] of this.gen.fnId) {
      if (id === target) return name;
    }
    this.abort(`unknown function target '${target}'`);
  }

  private fnSignature(t: HirType): string {
    if (t.kind !== 'fn') this.abort(`call needs a function-typed value`);
    const params = t.params.map((p) => this.llvmType(p.type));
    return fnLLVMType(params, this.llvmType(t.ret));
  }

  private argList(sig: string, args: string[]): string {
    const open = sig.indexOf('(');
    const close = sig.lastIndexOf(')');
    const inner = open >= 0 && close >= 0 ? sig.slice(open + 1, close) : '';
    const parts = inner.trim() === '' ? [] : inner.split(',').map((s) => s.trim());
    return args.map((a, i) => `${parts[i] ?? 'i8*'} ${a}`).join(', ');
  }

  /** Extract ptr and len from a `{ i8*, i64 }` operand. */
  private sliceFields(operand: string, out: string[]): [string, string] {
    const p = this.fresh();
    out.push(`${p} = extractvalue { i8*, i64 } ${operand}, 0`);
    const l = this.fresh();
    out.push(`${l} = extractvalue { i8*, i64 } ${operand}, 1`);
    return [p, l];
  }

  private isStringType(t: HirType): boolean {
    return t.kind === 'prim' && t.name === 'String';
  }

  private isPrimitive(t: HirType, name: 'Int' | 'Float' | 'Bool'): boolean {
    return t.kind === 'prim' && t.name === name;
  }

  private isOptionalStringType(t: HirType): boolean {
    if (t.kind !== 'optional') return false;
    return t.inner.kind === 'prim' && t.inner.name === 'String';
  }

  // -- native builtins ---------------------------------------------------------

  private nativeCall(name: string, v: Extract<MirValue, { kind: 'call' }>, args: string[], out: string[]): string {
    switch (name) {
      case 'input': {
        if (args.length > 1) this.abort('input accepts at most one String prompt');
        if (args.length === 1) {
          if (!this.isStringType(v.args[0]!.type)) this.abort('input prompt must be String');
          const [p, l] = this.sliceFields(args[0]!, out);
          out.push(`call void @nova_print(i8* ${p}, i64 ${l})`);
        }
        const reg = this.fresh();
        out.push(`${reg} = call { i8*, i64 } @nova_input()`);
        return reg;
      }
      case 'exit': {
        if (args.length !== 1 || !this.isPrimitive(v.args[0]!.type, 'Int')) {
          this.abort('exit expects exactly one Int exit code');
        }
        const code32 = this.fresh();
        out.push(`${code32} = trunc i64 ${args[0]!} to i32`);
        out.push(`call void @ExitProcess(i32 ${code32})`);
        return '$void$';
      }
      case 'panic': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('panic expects exactly one String message');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        out.push(`call void @nova_panic(i8* ${p}, i64 ${l})`);
        return '$void$';
      }
      case 'clock_ms': {
        if (args.length !== 0) this.abort('clock_ms expects no arguments');
        const reg = this.fresh();
        out.push(`${reg} = call i64 @nova_clock_ms()`);
        return reg;
      }
      case 'sleep_ms': {
        if (args.length !== 1 || !this.isPrimitive(v.args[0]!.type, 'Int')) {
          this.abort('sleep_ms expects exactly one Int duration');
        }
        out.push(`call void @nova_sleep_ms(i64 ${args[0]!})`);
        return '$void$';
      }
      case 'env_has': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('env_has expects exactly one String name');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        const reg = this.fresh();
        out.push(`${reg} = call i8 @nova_env_has(i8* ${p}, i64 ${l})`);
        return reg;
      }
      case 'env_get': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('env_get expects exactly one String name');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        const reg = this.fresh();
        // Option<String> ABI: nullable fat pointer (null ptr = None).
        out.push(`${reg} = call { i8*, i64 } @nova_env_get(i8* ${p}, i64 ${l})`);
        return reg;
      }
      case 'args': {
        if (args.length !== 0) this.abort('args expects no arguments');
        const reg = this.fresh();
        out.push(`${reg} = call { i8*, i64 } @nova_args()`);
        return reg;
      }
      case 'file_exists': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('file_exists expects exactly one String path');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        const reg = this.fresh();
        out.push(`${reg} = call i8 @nova_file_exists(i8* ${p}, i64 ${l})`);
        return reg;
      }
      case 'file_read': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('file_read expects exactly one String path');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        const reg = this.fresh();
        // Result<String, String> ABI: { { i8*, i64 } payload, i64 discriminant }.
        out.push(`${reg} = call { { i8*, i64 }, i64 } @nova_file_read(i8* ${p}, i64 ${l})`);
        return reg;
      }
      case 'file_write': {
        if (args.length !== 2 || !this.isStringType(v.args[0]!.type) || !this.isStringType(v.args[1]!.type)) {
          this.abort('file_write expects exactly two String arguments (path, data)');
        }
        const [p, pl] = this.sliceFields(args[0]!, out);
        const [d, dl] = this.sliceFields(args[1]!, out);
        const reg = this.fresh();
        out.push(`${reg} = call i8 @nova_file_write(i8* ${p}, i64 ${pl}, i8* ${d}, i64 ${dl})`);
        return reg;
      }
      case 'file_delete': {
        if (args.length !== 1 || !this.isStringType(v.args[0]!.type)) {
          this.abort('file_delete expects exactly one String path');
        }
        const [p, l] = this.sliceFields(args[0]!, out);
        const reg = this.fresh();
        out.push(`${reg} = call i8 @nova_file_delete(i8* ${p}, i64 ${l})`);
        return reg;
      }
      case 'println': {
        if (args.length === 0) {
          out.push('call void @nova_println_nl()');
          return '$void$';
        }
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Int')) {
          out.push(`call void @nova_println_int(i64 ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Bool')) {
          out.push(`call void @nova_println_bool(i8 ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Float')) {
          out.push(`call void @nova_println_float(double ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isStringType(v.args[0]!.type)) {
          const [p, l] = this.sliceFields(args[0]!, out);
          out.push(`call void @nova_println(i8* ${p}, i64 ${l})`);
          return '$void$';
        }
        if (args.length === 1 && this.isOptionalStringType(v.args[0]!.type)) {
          const [p, l] = this.sliceFields(args[0]!, out);
          const reg0 = this.fresh();
          const reg1 = this.fresh();
          out.push(`${reg0} = insertvalue { i8*, i64 } undef, i8* ${p}, 0`);
          out.push(`${reg1} = insertvalue { i8*, i64 } ${reg0}, i64 ${l}, 1`);
          out.push(`call void @nova_println_option_string({ i8*, i64 } ${reg1})`);
          return '$void$';
        }
        this.abort(`println() with a non-String argument is not supported by the native backend yet`);
      }
      case 'print': {
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Int')) {
          out.push(`call void @nova_print_int(i64 ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Bool')) {
          out.push(`call void @nova_print_bool(i8 ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isPrimitive(v.args[0]!.type, 'Float')) {
          out.push(`call void @nova_print_float(double ${args[0]})`);
          return '$void$';
        }
        if (args.length === 1 && this.isStringType(v.args[0]!.type)) {
          const [p, l] = this.sliceFields(args[0]!, out);
          out.push(`call void @nova_print(i8* ${p}, i64 ${l})`);
          return '$void$';
        }
        if (args.length === 1 && this.isOptionalStringType(v.args[0]!.type)) {
          const [p, l] = this.sliceFields(args[0]!, out);
          const reg0 = this.fresh();
          const reg1 = this.fresh();
          out.push(`${reg0} = insertvalue { i8*, i64 } undef, i8* ${p}, 0`);
          out.push(`${reg1} = insertvalue { i8*, i64 } ${reg0}, i64 ${l}, 1`);
          out.push(`call void @nova_print_option_string({ i8*, i64 } ${reg1})`);
          return '$void$';
        }
        this.abort(`print() with a non-String argument is not supported by the native backend yet`);
      }
      case 'len': {
        if (args.length !== 1) this.abort('len expects 1 argument');
        const t = v.args[0]!.type;
        if (t.kind === 'array' || t.kind === 'map' || this.isStringType(t)) {
          const [, l] = this.sliceFields(args[0]!, out);
          return l;
        }
        this.abort(`len is not supported for type '${t.kind}' by the native backend yet`);
      }
      case 'int': {
        if (args.length !== 1) this.abort('int expects 1 argument');
        const at = v.args[0]!.type;
        if (at.kind === 'prim' && at.name === 'Float') {
          const reg = this.fresh();
          out.push(`${reg} = fptosi double ${args[0]} to i64`);
          return reg;
        }
        if (at.kind === 'prim' && at.name === 'Int') return args[0]!;
        if (at.kind === 'prim' && at.name === 'Bool') {
          const reg = this.fresh();
          out.push(`${reg} = zext i8 ${args[0]} to i64`);
          return reg;
        }
        this.abort('int() from String is not supported by the native backend yet');
      }
      case 'float': {
        if (args.length !== 1) this.abort('float expects 1 argument');
        const at = v.args[0]!.type;
        if (at.kind === 'prim' && at.name === 'Int') {
          const reg = this.fresh();
          out.push(`${reg} = sitofp i64 ${args[0]} to double`);
          return reg;
        }
        if (at.kind === 'prim' && at.name === 'Bool') {
          const widened = this.fresh();
          out.push(`${widened} = zext i8 ${args[0]} to i64`);
          const reg = this.fresh();
          out.push(`${reg} = sitofp i64 ${widened} to double`);
          return reg;
        }
        if (at.kind === 'prim' && at.name === 'Float') return args[0]!;
        this.abort('float() from String is not supported by the native backend yet');
      }
      case 'abs': {
        const at = v.args[0]!.type;
        if (at.kind === 'prim' && at.name === 'Int') {
          const neg = this.fresh();
          out.push(`${neg} = sub i64 0, ${args[0]}`);
          const cnd = this.fresh();
          out.push(`${cnd} = icmp slt i64 ${args[0]}, 0`);
          const reg = this.fresh();
          out.push(`${reg} = select i1 ${cnd}, i64 ${neg}, i64 ${args[0]}`);
          return reg;
        }
        const reg = this.fresh();
        out.push(`${reg} = call double @llvm.fabs.f64(double ${args[0]})`);
        return reg;
      }
      case 'min': case 'max': {
        const at = v.args[0]!.type;
        const isFloat = at.kind === 'prim' && at.name === 'Float';
        const tdesc = isFloat ? 'double' : 'i64';
        const cnd = this.fresh();
        if (isFloat) out.push(`${cnd} = fcmp olt double ${args[0]}, ${args[1]}`);
        else out.push(`${cnd} = icmp slt i64 ${args[0]}, ${args[1]}`);
        const reg = this.fresh();
        if (name === 'min') out.push(`${reg} = select i1 ${cnd}, ${tdesc} ${args[0]}, ${tdesc} ${args[1]}`);
        else out.push(`${reg} = select i1 ${cnd}, ${tdesc} ${args[1]}, ${tdesc} ${args[0]}`);
        return reg;
      }
      case 'sqrt': {
        const reg = this.fresh();
        out.push(`${reg} = call double @llvm.sqrt.f64(double ${args[0]})`);
        return reg;
      }
      case 'pow': {
        const reg = this.fresh();
        out.push(`${reg} = call double @llvm.pow.f64(double ${args[0]}, double ${args[1]})`);
        return reg;
      }
      case 'floor': case 'ceil': case 'round': {
        const reg = this.fresh();
        out.push(`${reg} = call double @llvm.${name}.f64(double ${args[0]})`);
        return reg;
      }
      default:
        this.abort(`native '${name}' is not supported by the native backend yet (M6)`);
    }
  }

  // -- compound values ---------------------------------------------------------

  private emitField(v: Extract<MirValue, { kind: 'field' }>, out: string[]): string {
    const obj = this.value(v.obj, out);
    if (v.obj.type.kind !== 'struct') {
      this.abort(`field access on a non-struct value`);
    }
    const decl = this.gen.structs.get(v.obj.type.name);
    if (!decl) this.abort(`unknown struct '${v.obj.type.name}'`);
    const idx = decl.fields.findIndex((f) => f.name === v.name);
    if (idx < 0) this.abort(`unknown field '${v.obj.type.name}.${v.name}'`);
    const reg = this.fresh();
    out.push(`${reg} = extractvalue ${this.llvmType(v.obj.type)} ${obj}, ${idx}`);
    return reg;
  }

  private emitIndex(v: Extract<MirValue, { kind: 'index' }>, out: string[]): string {
    const obj = this.value(v.obj, out);
    const idx = this.value(v.index, out);
    const elemType = v.type;
    const isString = this.isStringType(v.obj.type);
    if (!isString && v.obj.type.kind !== 'array') {
      this.abort('index on a non-array/non-String container (maps not supported yet)');
    }
    const hd = this.fresh();
    out.push(`${hd} = extractvalue { i8*, i64 } ${obj}, 0`);
    const ln = this.fresh();
    out.push(`${ln} = extractvalue { i8*, i64 } ${obj}, 1`);
    const dp = this.fresh();
    out.push(`${dp} = call i8* @nova_array_get(i8* ${hd}, i64 ${idx}, i64 ${ln}, i64 ${this.gen.abiSizeBytes(elemType)})`);
    const tp = this.fresh();
    out.push(`${tp} = bitcast i8* ${dp} to ${this.llvmType(elemType)}*`);
    const reg = this.fresh();
    out.push(`${reg} = load ${this.llvmType(elemType)}, ${this.llvmType(elemType)}* ${tp}`);
    return reg;
  }

  private emitStructLit(v: Extract<MirValue, { kind: 'struct_lit' }>, out: string[]): string {
    const decl = this.gen.structs.get(v.structName);
    if (!decl) this.abort(`unknown struct '${v.structName}'`);
    const st = this.llvmType(v.type);
    let cur = 'undef';
    for (let i = 0; i < decl.fields.length; i++) {
      const fv = v.fields.find((f) => f.name === decl.fields[i]!.name);
      if (fv === undefined) this.abort(`struct literal missing field '${decl.fields[i]!.name}'`);
      const operand = this.value(fv.value, out);
      const reg = this.fresh();
      out.push(`${reg} = insertvalue ${st} ${cur}, ${operand}, ${i}`);
      cur = reg;
    }
    return cur;
  }

  private emitArrayLit(v: Extract<MirValue, { kind: 'array_lit' }>, out: string[]): string {
    if (v.type.kind !== 'array') this.abort('array literal with non-array type');
    const elem = v.type.element;
    const elemSize = this.gen.abiSizeBytes(elem);
    const count = v.elements.length;
    const hd = this.fresh();
    out.push(`${hd} = call i8* @nova_array_new(i64 ${elemSize}, i64 ${count})`);
    for (let i = 0; i < count; i++) {
      const dp = this.fresh();
      out.push(`${dp} = call i8* @nova_array_get(i8* ${hd}, i64 ${i}, i64 ${count}, i64 ${elemSize})`);
      const tp = this.fresh();
      out.push(`${tp} = bitcast i8* ${dp} to ${this.llvmType(elem)}*`);
      const val = this.value(v.elements[i]!, out);
      out.push(`store ${this.llvmType(elem)} ${val}, ${this.llvmType(elem)}* ${tp}`);
    }
    const u0 = this.fresh();
    out.push(`${u0} = insertvalue { i8*, i64 } undef, i8* ${hd}, 0`);
    const u1 = this.fresh();
    out.push(`${u1} = insertvalue { i8*, i64 } ${u0}, i64 ${count}, 1`);
    return u1;
  }

  private emitEnumLit(v: Extract<MirValue, { kind: 'enum_lit' }>, out: string[]): string {
    if (v.enumName === '__Option__' || v.enumName === '__Result__') {
      return this.emitTaggedLit(v, out);
    }
    const decl = this.gen.enums.get(v.enumName);
    if (!decl) this.abort(`unknown enum '${v.enumName}'`);
    const idx = decl.variants.findIndex((x) => x.name === v.variant);
    if (idx < 0) this.abort(`unknown variant '${v.enumName}.${v.variant}'`);
    return `${idx}`; // i64 discriminant
  }

  /** Option/Result literal → tagged struct (payload + discriminant). */
  private emitTaggedLit(v: Extract<MirValue, { kind: 'enum_lit' }>, out: string[]): string {
    const isOption = v.enumName === '__Option__';
    const discrVal = isOption ? (v.variant === 'some' ? 1 : 0) : (v.variant === 'ok' ? 0 : 1);
    const inner = isOption
      ? (v.type.kind === 'optional' ? v.type.inner : v.type)
      : (v.type.kind === 'result' ? v.type.ok : v.type);
    if (isPtrLike(inner)) {
      // Nullable-pointer optimization: Some(x) = x; None = { null, 0 }.
      if (v.data === undefined || discrVal === 0) return `{ i8* null, i64 0 }`;
      return this.value(v.data, out);
    }
    if (isOption) {
      const st = `{ ${this.llvmType(inner)}, i8 }`;
      const payload = v.data === undefined
        ? this.gen.litOperand({ kind: 'lit', value: 0, type: inner }, inner)
        : this.value(v.data, out);
      const r0 = this.fresh();
      out.push(`${r0} = insertvalue ${st} undef, ${payload}, 0`);
      const r1 = this.fresh();
      out.push(`${r1} = insertvalue ${st} ${r0}, i8 ${discrVal}, 1`);
      return r1;
    }
    const st = `{ ${this.llvmType(inner)}, i64 }`;
    const payload = v.data === undefined
      ? this.gen.litOperand({ kind: 'lit', value: 0, type: inner }, inner)
      : this.value(v.data, out);
    if (v.type.kind === 'result' && this.llvmType(v.type.ok) !== this.llvmType(v.type.err)) {
      this.abort(`Result<${'…'}> with differing payload types is not supported yet (payload union)`);
    }
    const r0 = this.fresh();
    out.push(`${r0} = insertvalue ${st} undef, ${payload}, 0`);
    const r1 = this.fresh();
    out.push(`${r1} = insertvalue ${st} ${r0}, i64 ${discrVal}, 1`);
    return r1;
  }

  private emitClosureRef(v: Extract<MirValue, { kind: 'closure_ref' }>, out: string[]): string {
    const target = this.gen.fnId.get(v.fnName);
    if (!target) this.abort(`unknown closure target '${v.fnName}'`);
    const reg = this.fresh();
    out.push(`${reg} = bitcast ${target} to i8*`);
    return reg;
  }

  private emitIntrinsic(v: Extract<MirValue, { kind: 'intrinsic' }>, out: string[]): string {
    const arg = this.value(v.arg, out);
    const t = v.arg.type;
    switch (v.op) {
      case 'is_some': case 'is_none': {
        const discr = this.tagDiscriminant(t, arg, out);
        const reg = this.fresh();
        if (v.op === 'is_some') {
          const c = this.fresh();
          out.push(`${c} = icmp ne i8 ${discr}, 0`);
          out.push(`${reg} = zext i1 ${c} to i8`);
        } else {
          const c = this.fresh();
          out.push(`${c} = icmp eq i8 ${discr}, 0`);
          out.push(`${reg} = zext i1 ${c} to i8`);
        }
        return reg;
      }
      case 'unwrap_some': {
        const inner = t.kind === 'optional' ? t.inner : t;
        if (isPtrLike(inner)) return arg; // nullable-ptr option: identity
        const reg = this.fresh();
        out.push(`${reg} = extractvalue { ${this.llvmType(inner)}, i8 } ${arg}, 0`);
        return reg;
      }
      case 'is_ok': case 'is_err': {
        const inner = t.kind === 'result' ? t.ok : t;
        const discr = this.fresh();
        out.push(`${discr} = extractvalue { ${this.llvmType(inner)}, i64 } ${arg}, 1`);
        const c = this.fresh();
        if (v.op === 'is_ok') out.push(`${c} = icmp eq i64 ${discr}, 0`);
        else out.push(`${c} = icmp ne i64 ${discr}, 0`);
        const z = this.fresh();
        out.push(`${z} = zext i1 ${c} to i8`);
        return z;
      }
      case 'unwrap_ok': case 'unwrap_err': {
        const inner = t.kind === 'result' ? (v.op === 'unwrap_ok' ? t.ok : t.err) : t;
        const reg = this.fresh();
        out.push(`${reg} = extractvalue { ${this.llvmType(inner)}, i64 } ${arg}, 0`);
        return reg;
      }
    }
    this.abort(`unsupported intrinsic '${v.op}'`);
  }

  /** Discriminant of an Option<T> value, as i8. */
  private tagDiscriminant(t: HirType, arg: string, out: string[]): string {
    if (t.kind !== 'optional') this.abort('expected an Option value');
    if (isPtrLike(t.inner)) {
      const p = this.fresh();
      out.push(`${p} = extractvalue { i8*, i64 } ${arg}, 0`);
      const c = this.fresh();
      out.push(`${c} = icmp ne i8* ${p}, null`);
      const b = this.fresh();
      out.push(`${b} = zext i1 ${c} to i8`);
      return b;
    }
    const d = this.fresh();
    out.push(`${d} = extractvalue { ${this.llvmType(t.inner)}, i8 } ${arg}, 1`);
    return d;
  }
}