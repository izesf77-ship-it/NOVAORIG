/**
 * HIR structural / golden tests.
 *
 * Verifies the .nova -> AST -> HIR pipeline produces well-formed, stable HIR.
 * Golden fixtures live in tests/hir_fixtures/ and are regenerated with
 * UPDATE_GOLDEN=1. Structural assertions check invariants that golden files
 * are too noisy for (field uniqueness of the `kind` discriminator, tail
 * promotion, let/assign distinction).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileSources } from '../src/compiler/driver.ts';
import { astToHir } from '../src/compiler/hir/hir_lower.ts';
import { hirToJson } from '../src/compiler/hir/hir_serialize.ts';
import type { HirModule } from '../src/compiler/hir/hir.ts';
import type { HirExpr } from '../src/compiler/hir/hir.ts';

const FIXTURES = path.join(import.meta.dirname, 'hir_fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function hirFor(src: string): HirModule {
  const r = compileSources([{ file: 't.nova', source: src }]);
  return astToHir(r.programs, r.symbols, r.exprTypes);
}

describe('hir-structure', () => {
  test('if/else as tail promotes to if_expr', () => {
    const hir = hirFor('fn abs(n: Int) -> Int {\n  if n < 0 { -n } else { n }\n}\nfn main() {}');
    const abs = hir.decls.find((d) => d.kind === 'fn' && d.name === 'abs');
    assert.ok(abs, 'fn abs should exist');
    const body = (abs as { body: { stmts: unknown[]; tail?: HirExpr } }).body;
    assert.equal(body.stmts.length, 0, 'no statement stmts for an if-tail body');
    assert.ok(body.tail, 'if must promote to a tail expression');
    assert.equal(body.tail!.kind, 'if_expr');
  });

  test('let vs assign distinction', () => {
    const hir = hirFor([
      'fn main() {',
      '  age = 25',
      '  age = age + 1',
      '}',
    ].join('\n'));
    const main = hir.decls.find((d) => d.kind === 'fn' && d.name === 'main');
    const stmts = (main as { body: { stmts: Array<{ kind: string }> } }).body.stmts;
    assert.equal(stmts[0]!.kind, 'let');
    assert.equal(stmts[1]!.kind, 'assign');
  });

  test('string interpolation lowers to concat', () => {
    const hir = hirFor([
      'fn main() {',
      '  name = "a"',
      '  print("hi {name}!")',
      '}',
    ].join('\n'));
    const main = hir.decls.find((d) => d.kind === 'fn' && d.name === 'main');
    const tail = (main as { body: { tail?: HirExpr } }).body.tail;
    assert.ok(tail, 'print call should be the tail');
    assert.equal(tail!.kind, 'call');
    const arg = (tail! as { args: Array<{ value: HirExpr }> }).args[0]!.value;
    assert.equal(arg.kind, 'binary');
    assert.equal((arg as { op: string }).op, '+');
  });

  test('match lowers to match expr with arms', () => {
    const hir = hirFor([
      'enum E { A, B }',
      'fn f(e: E) -> Int {',
      '  match e {',
      '    E.A => 1',
      '    E.B => 2',
      '  }',
      '}',
      'fn main() {}',
    ].join('\n'));
    const f = hir.decls.find((d) => d.kind === 'fn' && d.name === 'f');
    const body = (f as { body: { tail?: HirExpr } }).body;
    assert.equal(body.tail!.kind, 'match_expr');
    const arms = (body.tail! as { arms: unknown[] }).arms;
    assert.equal(arms.length, 2);
  });
});

describe('hir-golden', () => {
  if (!fs.existsSync(FIXTURES)) return;
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.nova'));
  if (files.length === 0) { test('hir-golden: no cases'); return; }
  for (const file of files) {
    test(`golden ${file}`, () => {
      const src = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
      const hir = hirFor(src);
      const jsonName = file.replace(/\.nova$/, '.expected.json');
      const expectedPath = path.join(FIXTURES, jsonName);
      const actual = JSON.stringify(hirToJson(hir), null, 2);
      if (UPDATE) {
        fs.writeFileSync(expectedPath, actual + '\n');
        return;
      }
      const expected = fs.readFileSync(expectedPath, 'utf8');
      assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
    });
  }
});
