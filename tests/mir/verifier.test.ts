/**
 * Verifier negative tests: intentionally broken MIR must be caught.
 *
 * We build a valid module, hand-corrupt one aspect of its MIR, then assert
 * that `verifyMirModule` reports the expected kind of error. This proves the
 * verifier is a real gate, not a trivial pass-through.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMir } from './mir_helper.ts';
import { verifyMirModule } from '../../src/compiler/mir/mir_verify.ts';
import type { MirModule } from '../../src/compiler/mir/mir.ts';

/** Find the first fn/closure_fn block with the given label infix. */
function findBlock(module: MirModule, label: string) {
  for (const d of module.decls) {
    if (d.kind !== 'fn' && d.kind !== 'closure_fn') continue;
    for (const b of d.blocks) {
      if (b.label.includes(label)) return b;
    }
  }
  return undefined;
}

describe('mir-verifier', () => {
  test('missing terminator is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    (b as { term: null }).term = null;
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('no terminator') && e.block === b.label));
  });

  test('jump to non-existent block is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    b.term = { kind: 'jump', target: 'does_not_exist' };
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('missing block') && e.message.includes('does_not_exist')));
  });

  test('branch to non-existent block is caught', () => {
    const mir = buildMir('fn main() { x = 0\n if true { x = 1 } else { x = 2 }\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    b.term = { kind: 'branch', cond: { kind: 'lit', value: true, type: { kind: 'prim', name: 'Bool' } }, thenLabel: 'nope', elseLabel: 'b.block0' };
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('nope')));
  });

  test('use before definition is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    // Insert a use of an undefined local before any definition.
    b.instrs.unshift({ kind: 'assign', name: 'z', type: { kind: 'prim', name: 'Int' }, value: { kind: 'ref', name: 'undefined_local', type: { kind: 'prim', name: 'Int' } }, span: { start: 0, end: 0, line: 1, col: 1 } });
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('used before definition') && e.message.includes('undefined_local')));
  });

  test('duplicate block label is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    mir.decls[0].blocks.push({ ...b, instrs: [...b.instrs] });
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('duplicate block label')));
  });

  test('non-entry block with params is caught', () => {
    const mir = buildMir('fn main() { x = 0\n while true { x = 1 }\n print(x) }');
    const loop = findBlock(mir, 'while.body');
    if (loop) {
      loop.params = [{ name: 'p', type: { kind: 'prim', name: 'Int' }, span: { start: 0, end: 0, line: 1, col: 1 } }];
      const errs = verifyMirModule(mir);
      assert.ok(errs.some((e) => e.message.includes('params') && e.message.includes('not supported')));
    }
  });

  test('type mismatch in assign is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    // Corrupt the literal type to mismatch the declared local type.
    const instr = b.instrs[0] as { value: { type: object } };
    instr.value.type = { kind: 'prim', name: 'String' };
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('does not match value type')));
  });

  test('void function returning a value is caught', () => {
    const mir = buildMir('fn main() { x = 1\n print(x) }');
    const b = findBlock(mir, 'entry')!;
    b.term = { kind: 'return', value: { kind: 'lit', value: 42, type: { kind: 'prim', name: 'Int' } } };
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('void function returns a value')));
  });

  test('non-void function missing return value is caught', () => {
    const mir = buildMir('fn f() -> Int { 1 + 1 }\nfn main() { print(f()) }');
    const b = findBlock(mir, 'f.entry')!;
    b.term = { kind: 'return' };
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('must return a value')));
  });

  test('call arity mismatch is caught', () => {
    const mir = buildMir('fn f(a: Int, b: Int) -> Int { a + b }\nfn main() { print(f(1, 2)) }');
    const b = findBlock(mir, 'main.entry')!;
    // Find the call to f and drop an argument.
    for (const instr of b.instrs) {
      if (instr.kind === 'assign' && (instr.value as { kind?: string }).kind === 'call') {
        (instr.value as { args: unknown[] }).args = [(instr.value as { args: unknown[] }).args[0]];
        break;
      }
    }
    const errs = verifyMirModule(mir);
    assert.ok(errs.some((e) => e.message.includes('expected 2 argument(s), found 1')));
  });
});
