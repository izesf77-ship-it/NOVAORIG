/**
 * HIR → MIR lowering.
 *
 * Converts a backend-agnostic `HirModule` into MIR: an explicit basic-block
 * control-flow graph with typed SSA-able values and explicit terminators.
 *
 * Design:
 *  - Lowering is total and deterministic. It emits instructions into a `Cur`
 *    builder that owns the currently-open block.
 *  - Every HIR expression lowers to a `MirValue`; complex expressions are
 *    bound to a fresh temp via `assign`.
 *  - Control flow (if/else, while, for, match, break/continue, return, `?`-
 *    propagation) is lowered to `jump`/`branch`/`return`/`unreachable`
 *    terminators — there is no implicit fall-through.
 *  - `match` is lowered to a discriminant-test + branch cascade; it is NOT a
 *    MIR instruction. Enum path tests use `==` against enum literals;
 *    Some/None/Ok/Err patterns use `intrinsic` tag tests + unwrap intrinsics.
 *  - Closures are closure-converted: free (captured) locals become leading
 *    parameters of a synthetic MIR function; the closure value is a function
 *    reference plus the captured values.
 *
 * The pass never mutates the HIR.
 */
import type {
  HirModule, HirDecl, HirExpr, HirStmt, HirType,
  HirBlockExpr, HirIfExpr, HirMatchExpr, HirMatchArm, HirPattern,
  HirIdent, HirParam,
} from '../hir/hir.ts';
import type { Span2 } from '../lexer/token.ts';
import type { SymbolTables } from '../backend/backend.ts';
import type {
  MirModule, MirDecl, MirFunction, MirFunctionParam, MirClosureDecl,
  MirBlock, MirBlockParam, MirInstr, MirAssign, MirTerm,
  MirJumpTerm, MirBranchTerm, MirReturnTerm,
  MirValue, MirRef, MirLit,
} from './mir.ts';

const VOID: HirType = { kind: 'void' };
const INT: HirType = { kind: 'prim', name: 'Int' };
const BOOL: HirType = { kind: 'prim', name: 'Bool' };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function mirLowerModule(hir: HirModule, symbols: SymbolTables): MirModule {
  const ctx = new LowerCtx(symbols);
  for (const d of hir.decls) ctx.lowerTopDecl(d);
  return { name: hir.name, imports: hir.imports, decls: ctx.decls };
}

// ---------------------------------------------------------------------------
// Lowering context
// ---------------------------------------------------------------------------

class LowerCtx {
  readonly symbols: SymbolTables;
  readonly decls: MirDecl[] = [];
  private labelSeq = 0;
  private tempSeq = 0;
  private cloCallSeq = 0;

  // currently-lowered function state:
  private blocks: MirBlock[] = [];
  private cur: MirBlock | null = null;
  private localTypes = new Map<string, HirType>();
  private breakStack: string[] = [];
  private continueStack: string[] = [];

  constructor(symbols: SymbolTables) { this.symbols = symbols; }

  // ---- top-level decls ----------------------------------------------------

  lowerTopDecl(d: HirDecl): void {
    switch (d.kind) {
      case 'fn': {
        const fn = this.lowerFunction(d.name, d.typeParams, d.params, d.ret, d.body, d.span);
        this.decls.push(fn);
        break;
      }
      case 'struct':
        this.decls.push({
          kind: 'struct', name: d.name, typeParams: d.typeParams,
          fields: d.fields.map((f) => ({ name: f.name, type: f.type })),
          span: d.span,
        });
        break;
      case 'enum':
        this.decls.push({
          kind: 'enum', name: d.name, typeParams: d.typeParams,
          variants: d.variants.map((v) => ({ name: v.name, data: v.data })),
          span: d.span,
        });
        break;
      case 'const':
        this.decls.push({
          kind: 'const', name: d.name, type: d.type ?? d.value.type,
          value: this.withFunc([], VOID, () => this.lowerExpr(d.value)),
          span: d.span,
        });
        break;
      case 'nominal': break;
    }
  }

  // ---- function isolation -------------------------------------------------

  private withFunc<T>(params: { name: string; type: HirType }[], ret: HirType, f: () => T): T {
    const saved = { blocks: this.blocks, cur: this.cur, localTypes: this.localTypes, breakStack: this.breakStack, continueStack: this.continueStack };
    this.blocks = [];
    this.cur = null;
    this.localTypes = new Map();
    this.breakStack = [];
    this.continueStack = [];
    try {
      for (const p of params) this.localTypes.set(p.name, p.type);
      return f();
    } finally {
      this.blocks = saved.blocks;
      this.cur = saved.cur;
      this.localTypes = saved.localTypes;
      this.breakStack = saved.breakStack;
      this.continueStack = saved.continueStack;
    }
  }

  private lowerFunction(
    name: string, typeParams: string[], params: HirParam[], ret: HirType, body: HirBlockExpr, span: Span2,
  ): MirFunction {
    return this.withFunc(params, ret, () => {
      const paramList: MirFunctionParam[] = params.map((p) => ({ name: p.name, type: p.type, span }));
      const entry = this.newBlock(this.uniqueLabel(`${name}.entry`), paramList);
      for (const s of body.stmts) this.lowerStmt(s);
      // Implicit return: tail expression or void.
      if (this.cur && !this.cur.term) {
        if (body.tail) {
          const v = this.lowerExpr(body.tail);
          this.setTerm({ kind: 'return', value: v });
        } else {
          this.setTerm({ kind: 'return', value: undefined });
        }
      }
      const blocks = this.blocks;
      if (!blocks[0].term) this.setTerm({ kind: 'return', value: undefined });
      return { kind: 'fn', name, typeParams, params: paramList, ret, blocks, span } as MirFunction;
    });
  }

  // ---- blocks & control flow ---------------------------------------------

  /**
   * Open a new block with an EXACT pre-allocated label and make it current.
   * The current block must already be terminated — control flow is explicit;
   * there is no implicit fall-through between blocks.
   */
  private newBlock(label: string, params: MirBlockParam[] = []): MirBlock {
    if (this.cur && !this.cur.term) {
      throw new Error(`mir: block '${this.cur.label}' has no terminator before opening block '${label}'`);
    }
    const b: MirBlock = { label, params, instrs: [], term: null as unknown as MirTerm };
    this.blocks.push(b);
    this.cur = b;
    return b;
  }

  private setTerm(term: MirTerm): void {
    if (!this.cur) throw new Error('mir: terminate with no current block');
    if (this.cur.term) throw new Error(`mir: block ${this.cur.label} already has a terminator`);
    this.cur.term = term;
  }

  private uniqueLabel(hint: string): string {
    return `${hint}.${this.labelSeq++}`;
  }

  private freshTemp(): string {
    return `__t${this.tempSeq++}`;
  }

  // ---- instruction emission ----------------------------------------------

  private emit(instr: MirInstr): void {
    this.cur!.instrs.push(instr);
  }

  private temp(type: HirType, value: MirValue, span: Span2): MirRef {
    const name = this.freshTemp();
    this.emit({ kind: 'assign', name, type, value, span });
    return { kind: 'ref', name, type };
  }

  private assignTo(name: string, type: HirType, value: MirValue, span: Span2): void {
    this.emit({ kind: 'assign', name, type, value, span });
    this.localTypes.set(name, type);
  }

  private intrinsic(op: string, arg: MirValue, type: HirType, span: Span2): MirValue {
    return { kind: 'intrinsic', op, arg, type } as unknown as MirValue;
  }

  // ---- expressions --------------------------------------------------------

  private lowerExpr(e: HirExpr): MirValue {
    const t = e.type;
    switch (e.kind) {
      case 'lit': return { kind: 'lit', value: e.value, type: t } as MirLit;
      case 'ident': return this.lowerIdent(e.ident);
      case 'binary': return this.temp(t, { kind: 'bin', op: e.op, left: this.lowerExpr(e.left), right: this.lowerExpr(e.right), type: t }, e.span);
      case 'unary': return this.temp(t, { kind: 'unary', op: e.op, expr: this.lowerExpr(e.expr), type: t }, e.span);
      case 'call': {
        const callee = this.lowerExpr(e.callee);
        const args = e.args.map((a) => this.lowerExpr(a.value));
        return this.temp(t, { kind: 'call', callee, args, type: t }, e.span);
      }
      case 'field': {
        // Enum variant construction: `Color.Green` is represented in HIR as a
        // field access on the enum's name (there is no dedicated enum-literal
        // expression in the AST/HIR), so lower it to a real MirEnumLit here.
        if (e.obj.kind === 'ident' && !this.localTypes.has(e.obj.ident.name) && this.symbols.enums.has(e.obj.ident.name)) {
          return { kind: 'enum_lit', enumName: e.obj.ident.name, variant: e.name, type: t } as MirValue;
        }
        return this.temp(t, { kind: 'field', obj: this.lowerExpr(e.obj), name: e.name, type: t }, e.span);
      }
      case 'index': return this.temp(t, { kind: 'index', obj: this.lowerExpr(e.obj), index: this.lowerExpr(e.index), type: t }, e.span);
      case 'array': return this.temp(t, { kind: 'array_lit', elements: e.elements.map((x) => this.lowerExpr(x)), type: t }, e.span);
      case 'map': return this.temp(t, { kind: 'map_lit', entries: e.entries.map((en) => ({ key: this.lowerExpr(en.key), value: this.lowerExpr(en.value) })), type: t }, e.span);
      case 'ok': return this.temp(t, { kind: 'enum_lit', enumName: '__Result__', variant: 'ok', data: e.value ? this.lowerExpr(e.value) : undefined, type: t }, e.span);
      case 'error': return this.temp(t, { kind: 'enum_lit', enumName: '__Result__', variant: 'err', data: e.value ? this.lowerExpr(e.value) : undefined, type: t }, e.span);
      case 'some': return this.temp(t, { kind: 'enum_lit', enumName: '__Option__', variant: 'some', data: e.value ? this.lowerExpr(e.value) : undefined, type: t }, e.span);
      case 'none': return { kind: 'enum_lit', enumName: '__Option__', variant: 'none', type: t } as MirLit;
      case 'block': return this.lowerBlockExpr(e);
      case 'if_expr': return this.lowerIfExpr(e);
      case 'match_expr': return this.lowerMatchExpr(e);
      case 'propagate': return this.lowerPropagate(e);
      case 'closure': return this.lowerClosure(e);
      case 'assign': {
        const value = this.lowerExpr(e.value);
        const target = e.target;
        if (target.ident.kind === 'local') {
          this.assignTo(target.ident.name, value.type, value, e.span);
          return { kind: 'ref', name: target.ident.name, type: value.type };
        }
        return value;
      }
      case 'return': {
        const v = e.value ? this.lowerExpr(e.value) : undefined;
        this.setTerm({ kind: 'return', value: v });
        return { kind: 'lit', value: null, type: VOID } as MirLit;
      }
    }
  }

  private lowerIdent(ident: HirIdent): MirValue {
    const type = this.localTypes.get(ident.name) ?? ident.type;
    return { kind: 'ref', name: ident.name, type };
  }

  private lowerBlockExpr(block: HirBlockExpr): MirValue {
    for (const s of block.stmts) this.lowerStmt(s);
    if (block.tail) return this.lowerExpr(block.tail);
    return { kind: 'lit', value: null, type: VOID } as MirLit;
  }

  // ---- statements ---------------------------------------------------------

  private lowerStmt(s: HirStmt): void {
    if (this.cur && this.cur.term) {
      // Unreachable trailing code: drop into a dead block so lowering stays total.
      this.newBlock(this.uniqueLabel('unreachable'));
      this.setTerm({ kind: 'unreachable' });
      return;
    }
    switch (s.kind) {
      case 'expr': this.lowerExpr(s.expr); return;
      case 'let': this.lowerLet(s); return;
      case 'assign': this.lowerAssign(s); return;
      case 'field_assign': {
        const obj = this.lowerExpr(s.obj); const v = this.lowerExpr(s.value);
        this.emit({ kind: 'store_field', obj, name: s.name, value: v, span: s.span });
        return;
      }
      case 'index_assign': {
        const obj = this.lowerExpr(s.obj); const idx = this.lowerExpr(s.index); const v = this.lowerExpr(s.value);
        this.emit({ kind: 'store_index', obj, index: idx, value: v, span: s.span });
        return;
      }
      case 'if': this.lowerIfStmt(s); return;
      case 'while': this.lowerWhile(s); return;
      case 'for': this.lowerFor(s); return;
      case 'return': {
        const v = s.value ? this.lowerExpr(s.value) : undefined;
        this.setTerm({ kind: 'return', value: v });
        return;
      }
      case 'match': this.lowerMatchStmt(s); return;
      case 'block': {
        for (const inner of s.stmts) this.lowerStmt(inner);
        if (s.tail) this.lowerExpr(s.tail);
        return;
      }
      case 'break': {
        const target = this.breakStack[this.breakStack.length - 1];
        if (!target) throw new Error('mir: break outside loop');
        this.setTerm({ kind: 'jump', target });
        return;
      }
      case 'continue': {
        const target = this.continueStack[this.continueStack.length - 1];
        if (!target) throw new Error('mir: continue outside loop');
        this.setTerm({ kind: 'jump', target });
        return;
      }
    }
  }

  private lowerLet(s: HirLetStmt): void {
    const value = this.lowerExpr(s.value);
    this.assignTo(s.name, s.type ?? value.type, value, s.span);
  }

  private lowerAssign(s: HirAssignStmt): void {
    const value = this.lowerExpr(s.value);
    this.assignTo(s.target.ident.name, value.type, value, s.span);
  }

  // ---- if -----------------------------------------------------------------

  private lowerIfStmt(s: HirIfStmt): void {
    const condVal = this.lowerExpr(s.cond);
    const thenBB = this.uniqueLabel('if.then');
    const joinBB = this.uniqueLabel('if.join');
    const elseBB = s.else ? this.uniqueLabel('if.else') : joinBB;
    this.setTerm({ kind: 'branch', cond: condVal, thenLabel: thenBB, elseLabel: elseBB });
    this.newBlock(thenBB);
    for (const st of s.then.stmts) this.lowerStmt(st);
    if (s.then.tail) this.lowerExpr(s.then.tail);
    if (!this.cur!.term) this.setTerm({ kind: 'jump', target: joinBB });
    if (s.else) {
      this.newBlock(elseBB);
      for (const st of s.else.stmts) this.lowerStmt(st);
      if (s.else.tail) this.lowerExpr(s.else.tail);
      if (!this.cur!.term) this.setTerm({ kind: 'jump', target: joinBB });
    }
    this.newBlock(joinBB);
  }

  private lowerIfExpr(e: HirIfExpr): MirValue {
    const rt = this.freshTemp();
    const rtType = e.type;
    const condVal = this.lowerExpr(e.cond);
    const thenBB = this.uniqueLabel('ife.then');
    const joinBB = this.uniqueLabel('ife.join');
    const elseBB = this.uniqueLabel('ife.else');
    this.setTerm({ kind: 'branch', cond: condVal, thenLabel: thenBB, elseLabel: elseBB });
    this.newBlock(thenBB);
    const thenVal = this.lowerCondExpr(e.then);
    this.assignTo(rt, rtType, thenVal, e.span);
    if (!this.cur!.term) this.setTerm({ kind: 'jump', target: joinBB });
    this.newBlock(elseBB);
    const elseVal = e.else ? this.lowerCondExpr(e.else) : { kind: 'lit', value: null, type: rtType } as MirLit;
    this.assignTo(rt, rtType, elseVal, e.span);
    if (!this.cur!.term) this.setTerm({ kind: 'jump', target: joinBB });
    this.newBlock(joinBB);
    return { kind: 'ref', name: rt, type: rtType };
  }

  /** Lower a conditional branch operand that may be a HirBlockExpr or HirIfExpr. */
  private lowerCondExpr(e: HirBlockExpr | HirIfExpr): MirValue {
    if (e.kind === 'if_expr') {
      return this.lowerIfExpr(e);
    }
    for (const s of e.stmts) this.lowerStmt(s);
    if (e.tail) return this.lowerExpr(e.tail);
    return { kind: 'lit', value: null, type: VOID } as MirLit;
  }

  /** Lower a block's statements then its tail, returning the tail value. */
  private lowerBlockTail(block: HirBlockExpr): MirValue {
    for (const s of block.stmts) this.lowerStmt(s);
    if (block.tail) return this.lowerExpr(block.tail);
    return { kind: 'lit', value: null, type: VOID } as MirLit;
  }

  // ---- loops --------------------------------------------------------------

  private lowerWhile(s: HirWhileStmt): void {
    const condBB = this.uniqueLabel('while.cond');
    const bodyBB = this.uniqueLabel('while.body');
    const exitBB = this.uniqueLabel('while.exit');
    this.breakStack.push(exitBB);
    this.continueStack.push(condBB);
    this.setTerm({ kind: 'jump', target: condBB });
    this.newBlock(condBB);
    const condVal = this.lowerExpr(s.cond);
    this.setTerm({ kind: 'branch', cond: condVal, thenLabel: bodyBB, elseLabel: exitBB });
    this.newBlock(bodyBB);
    for (const st of s.body.stmts) this.lowerStmt(st);
    if (s.body.tail) this.lowerExpr(s.body.tail);
    if (!this.cur!.term) this.setTerm({ kind: 'jump', target: condBB });
    this.continueStack.pop();
    this.breakStack.pop();
    this.newBlock(exitBB);
  }

  private lowerFor(s: HirForStmt): void {
    const iterVal = this.lowerExpr(s.iter);
    const elemType = iterVal.type.kind === 'array' ? iterVal.type.element : { kind: 'prim', name: 'Null' };
    const arrName = this.freshTemp();
    this.assignTo(arrName, iterVal.type, iterVal, s.iter.span);
    const idxName = this.freshTemp();
    this.assignTo(idxName, INT, { kind: 'lit', value: 0, type: INT } as MirLit, s.span);
    const lenName = this.freshTemp();
    this.assignTo(lenName, INT, {
      kind: 'call',
      callee: { kind: 'ref', name: 'len', type: { kind: 'fn', params: [], ret: INT } },
      args: [{ kind: 'ref', name: arrName, type: iterVal.type }],
      type: INT,
    }, s.span);
    const condBB = this.uniqueLabel('for.cond');
    const bodyBB = this.uniqueLabel('for.body');
    const incrBB = this.uniqueLabel('for.incr');
    const exitBB = this.uniqueLabel('for.exit');
    this.breakStack.push(exitBB);
    this.continueStack.push(incrBB);
    this.setTerm({ kind: 'jump', target: condBB });
    this.newBlock(condBB);
    this.setTerm({
      kind: 'branch',
      cond: { kind: 'bin', op: '<', left: { kind: 'ref', name: idxName, type: INT }, right: { kind: 'ref', name: lenName, type: INT }, type: BOOL },
      thenLabel: bodyBB,
      elseLabel: exitBB,
    });
    this.newBlock(bodyBB);
    this.assignTo(s.name, elemType, {
      kind: 'index',
      obj: { kind: 'ref', name: arrName, type: iterVal.type },
      index: { kind: 'ref', name: idxName, type: INT },
      type: elemType,
    }, s.span);
    for (const st of s.body.stmts) this.lowerStmt(st);
    if (s.body.tail) this.lowerExpr(s.body.tail);
    if (!this.cur!.term) this.setTerm({ kind: 'jump', target: incrBB });
    this.newBlock(incrBB);
    this.assignTo(idxName, INT, {
      kind: 'bin', op: '+',
      left: { kind: 'ref', name: idxName, type: INT },
      right: { kind: 'lit', value: 1, type: INT } as MirLit,
      type: INT,
    }, s.span);
    this.setTerm({ kind: 'jump', target: condBB });
    this.continueStack.pop();
    this.breakStack.pop();
    this.newBlock(exitBB);
  }

  // ---- match --------------------------------------------------------------

  private lowerMatchStmt(s: HirMatchStmt): void {
    const subj = this.lowerExpr(s.subject);
    const exitBB = this.uniqueLabel('match.exit');
    this.lowerMatchArms(s.arms, subj, exitBB, false, undefined, s.subject.type, s.span);
    this.newBlock(exitBB);
  }

  private lowerMatchExpr(e: HirMatchExpr): MirValue {
    const rt = this.freshTemp();
    const subj = this.lowerExpr(e.subject);
    const exitBB = this.uniqueLabel('match.exit');
    this.lowerMatchArms(e.arms, subj, exitBB, true, rt, e.type, e.span);
    this.newBlock(exitBB);
    return { kind: 'ref', name: rt, type: e.type };
  }

  private lowerMatchArms(
    arms: HirMatchArm[], subj: MirValue, exitBB: string,
    produceValue: boolean, valueTemp: string | undefined, resultType: HirType, span: Span2,
  ): void {
    // Pre-allocate every test-block label so that a failed arm-i branch can
    // target arm-(i+1)'s test block exactly.
    const testLabels = arms.map((_, i) => this.uniqueLabel(`match.arm${i}.test`));
    const last = arms.length - 1;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!;
      const isLast = i === last;
      const bodyBB = this.uniqueLabel(`match.arm${i}.body`);
      if (i > 0) this.newBlock(testLabels[i]!);
      const test = this.lowerPatternTest(arm.pattern, subj, span);
      if (test === 'unconditional') {
        this.setTerm({ kind: 'jump', target: bodyBB });
      } else {
        const nextTest = isLast ? exitBB : testLabels[i + 1]!;
        this.setTerm({ kind: 'branch', cond: test, thenLabel: bodyBB, elseLabel: nextTest });
      }
      this.newBlock(bodyBB);
      this.applyPatternBindings(arm.pattern, subj, span);
      for (const st of arm.body.stmts) this.lowerStmt(st);
      if (produceValue && arm.body.tail) {
        const v = this.lowerExpr(arm.body.tail);
        this.assignTo(valueTemp!, resultType, v, span);
      }
      if (!this.cur!.term) this.setTerm({ kind: 'jump', target: exitBB });
    }
  }

  private lowerPatternTest(pattern: HirPattern, subj: MirValue, span: Span2): MirValue | 'unconditional' {
    switch (pattern.kind) {
      case 'wildcard': return 'unconditional';
      case 'binding': return 'unconditional';
      case 'path':
        return {
          kind: 'bin', op: '==',
          left: subj,
          right: { kind: 'enum_lit', enumName: pattern.enumName, variant: pattern.variant, type: subj.type },
          type: BOOL,
        } as unknown as MirValue;
      case 'literal': {
        const lv: MirValue = { kind: 'lit', value: pattern.value.value, type: pattern.value.type };
        return { kind: 'bin', op: '==', left: subj, right: lv, type: BOOL } as unknown as MirValue;
      }
      case 'some': return this.intrinsic('is_some', subj, BOOL, span);
      case 'none': return this.intrinsic('is_none', subj, BOOL, span);
      case 'ok': return this.intrinsic('is_ok', subj, BOOL, span);
      case 'err': return this.intrinsic('is_err', subj, BOOL, span);
    }
  }

  private applyPatternBindings(pattern: HirPattern, subj: MirValue, span: Span2): void {
    switch (pattern.kind) {
      case 'binding':
        this.assignTo(pattern.name, subj.type, subj, span);
        break;
      case 'some': {
        const innerType = subj.type.kind === 'optional' ? subj.type.inner : subj.type;
        const inner = this.intrinsic('unwrap_some', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
        break;
      }
      case 'ok': {
        const innerType = subj.type.kind === 'result' ? subj.type.ok : subj.type;
        const inner = this.intrinsic('unwrap_ok', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
        break;
      }
      case 'err': {
        const innerType = subj.type.kind === 'result' ? subj.type.err : subj.type;
        const inner = this.intrinsic('unwrap_err', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
        break;
      }
      default: break;
    }
  }

  private bindPattern(pattern: HirPattern, subj: MirValue, span: Span2): void {
    if (pattern.kind === 'binding') {
      this.assignTo(pattern.name, subj.type, subj, span);
    } else if (pattern.kind === 'wildcard') {
      // no binding
    } else {
      // Nested: some/ok/err/literal/path — unwrap recursively
      if (pattern.kind === 'some') {
        const innerType = subj.type.kind === 'optional' ? subj.type.inner : subj.type;
        const inner = this.intrinsic('unwrap_some', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
      } else if (pattern.kind === 'ok') {
        const innerType = subj.type.kind === 'result' ? subj.type.ok : subj.type;
        const inner = this.intrinsic('unwrap_ok', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
      } else if (pattern.kind === 'err') {
        const innerType = subj.type.kind === 'result' ? subj.type.err : subj.type;
        const inner = this.intrinsic('unwrap_err', subj, innerType, span);
        this.bindPattern(pattern.inner, inner, span);
      }
    }
  }

  // ---- option/result propagation (?) ---------------------------------------

  private lowerPropagate(e: HirPropagateExpr): MirValue {
    const ev = this.lowerExpr(e.expr);
    const ty = e.type;
    const src = e.expr.type;
    const okBB = this.uniqueLabel('prop.ok');
    const retBB = this.uniqueLabel('prop.err');
    const isOk: MirValue = src.kind === 'result'
      ? this.intrinsic('is_ok', ev, BOOL, e.span)
      : src.kind === 'optional'
        ? this.intrinsic('is_some', ev, BOOL, e.span)
        : { kind: 'lit', value: true, type: BOOL } as MirLit;
    this.setTerm({ kind: 'branch', cond: isOk, thenLabel: okBB, elseLabel: retBB });
    // Error path: `?` returns the Err value / None from the enclosing function.
    // Emitted as a detached block — the label must exist for the verifier, and
    // the current block (the Ok continuation) must stay open.
    const errTerm: MirTerm = src.kind === 'result'
      ? {
          kind: 'return',
          value: {
            kind: 'enum_lit', enumName: '__Result__', variant: 'err',
            data: this.intrinsic('unwrap_err', ev, src.err, e.span),
            type: src,
          },
        }
      : src.kind === 'optional'
        ? { kind: 'return', value: { kind: 'enum_lit', enumName: '__Option__', variant: 'none', type: src } }
        : { kind: 'unreachable' };
    this.blocks.push({ label: retBB, params: [], instrs: [], term: errTerm });
    this.newBlock(okBB);
    const unwrapped: MirValue = src.kind === 'result'
      ? this.intrinsic('unwrap_ok', ev, ty, e.span)
      : this.intrinsic('unwrap_some', ev, ty, e.span);
    const t = this.freshTemp();
    this.assignTo(t, ty, unwrapped, e.span);
    return { kind: 'ref', name: t, type: ty };
  }

  // ---- closures -----------------------------------------------------------

  private lowerClosure(e: HirClosureExpr): MirValue {
    const paramNames = e.params.map((p) => p.name);
    const free = this.findFreeVars(e.body, paramNames);
    const closureName = `__closure_${this.cloCallSeq++}`;
    const params: MirFunctionParam[] = e.params.map((p) => ({ name: p.name, type: p.type, span: e.span }));
    const captured: MirFunctionParam[] = free.map((f) => ({ name: f, type: this.localTypes.get(f) ?? VOID, span: e.span }));
    const fullParams = [...params, ...captured];
    const clo = this.lowerFunction(closureName, [], fullParams, e.ret, e.body, e.span);
    const closureDecl: MirClosureDecl = {
      kind: 'closure_fn', name: closureName, params: fullParams, ret: e.ret,
      blocks: clo.blocks, captured: free, span: e.span,
    };
    this.decls.push(closureDecl);
    const captures: MirRef[] = free.map((f) => ({ kind: 'ref', name: f, type: this.localTypes.get(f) ?? VOID }));
    return { kind: 'closure_ref', fnName: closureName, captures, type: e.type };
  }

  /**
   * Find free variables: local identifiers referenced in the closure body
   * that are NOT defined within the closure (i.e. they come from an enclosing
   * scope and must be captured).
   */
  private findFreeVars(body: HirBlockExpr, paramNames: string[]): string[] {
    const defined = new Set(paramNames);
    const free = new Set<string>();

    const collectBindings = (p: HirPattern): void => {
      if (p.kind === 'binding') defined.add(p.name);
      else if (p.kind === 'some' || p.kind === 'ok' || p.kind === 'err') collectBindings(p.inner);
    };

    const walkBlock = (b: { stmts: HirStmt[]; tail?: HirExpr }): void => {
      for (const s of b.stmts) walkStmt(s);
      if (b.tail) walkExpr(b.tail);
    };

    const walkStmt = (s: HirStmt): void => {
      switch (s.kind) {
        case 'expr': walkExpr(s.expr); break;
        case 'let': defined.add(s.name); walkExpr(s.value); break;
        case 'assign': walkExpr(s.value); break;
        case 'field_assign': walkExpr(s.obj); walkExpr(s.value); break;
        case 'index_assign': walkExpr(s.obj); walkExpr(s.index); walkExpr(s.value); break;
        case 'if': walkExpr(s.cond); walkBlock(s.then); if (s.else) walkBlock(s.else); break;
        case 'while': walkExpr(s.cond); walkBlock(s.body); break;
        case 'for': defined.add(s.name); walkExpr(s.iter); walkBlock(s.body); break;
        case 'return': if (s.value) walkExpr(s.value); break;
        case 'match': {
          walkExpr(s.subject);
          for (const arm of s.arms) {
            collectBindings(arm.pattern);
            walkBlock(arm.body);
          }
          break;
        }
        case 'block': walkBlock(s); break;
        case 'break':
        case 'continue': break;
      }
    };

    const walkExpr = (e: HirExpr): void => {
      switch (e.kind) {
        case 'ident':
          if (e.ident.kind === 'local' && !defined.has(e.ident.name) && this.localTypes.has(e.ident.name)) {
            free.add(e.ident.name);
          }
          break;
        case 'binary': walkExpr(e.left); walkExpr(e.right); break;
        case 'unary': walkExpr(e.expr); break;
        case 'call': walkExpr(e.callee); for (const a of e.args) walkExpr(a.value); break;
        case 'field': walkExpr(e.obj); break;
        case 'index': walkExpr(e.obj); walkExpr(e.index); break;
        case 'array': for (const el of e.elements) walkExpr(el); break;
        case 'map': for (const en of e.entries) { walkExpr(en.key); walkExpr(en.value); } break;
        case 'block': walkBlock(e); break;
        case 'if_expr': walkExpr(e.cond); walkBlock(e.then); if (e.else) { if (e.else.kind === 'if_expr') walkExpr(e.else); else walkBlock(e.else); } break;
        case 'match_expr': walkExpr(e.subject); for (const a of e.arms) { collectBindings(a.pattern); walkBlock(a.body); } break;
        case 'propagate': walkExpr(e.expr); break;
        case 'ok': case 'error': case 'some': if (e.value) walkExpr(e.value); break;
        case 'assign': walkExpr(e.value); break;
        case 'return': if (e.value) walkExpr(e.value); break;
        case 'closure': break;
        case 'lit': break;
      }
    };

    walkBlock(body);
    return [...free];
  }
}
