/**
 * Typechecker tests.
 *
 * Exercises error reporting and type system features that go beyond
 * end-to-end runs: nominal type safety, generic call-site inference,
 * exhaustiveness warnings, unknown names, type mismatches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../src/compiler/driver.ts';

function diags(src: string) {
  const r = compileSources([{ file: 't.nova', source: src }]);
  return r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message }));
}

test('nominal types reject cross-assignment', () => {
  const out = diags([
    'type UserId = Int',
    'type ProductId = Int',
    'fn load(id: UserId) -> Int { id }',
    'fn main() {',
    '  pid: ProductId = 1',
    '  print(load(pid))',
    '}',
  ].join('\n'));
  // Should emit a type mismatch error (NOVA4xxx).
  const errs = out.filter((d) => d.severity === 'error');
  assert.ok(errs.length > 0, 'expected at least one type error');
  assert.ok(errs.some((d) => d.code.startsWith('NOVA4')), `unexpected code: ${errs.map(e => e.code).join(',')}`);
});

test('exhaustiveness warning on missing enum variant', () => {
  const out = diags([
    'enum Color { Red, Green, Blue }',
    'fn name(c: Color) -> String {',
    '  match c {',
    '    Color.Red => "r"',
    '    Color.Green => "g"',
    '  }',
    '}',
    'fn main() { name(Color.Red) }',
  ].join('\n'));
  const warns = out.filter((d) => d.severity === 'warning' && d.code === 'NOVA4008');
  assert.equal(warns.length, 1, `expected 1 exhaustiveness warning, got: ${JSON.stringify(out)}`);
});

test('wildcard silences exhaustiveness warning', () => {
  const out = diags([
    'enum Color { Red, Green, Blue }',
    'fn name(c: Color) -> String {',
    '  match c {',
    '    Color.Red => "r"',
    '    _ => "other"',
    '  }',
    '}',
    'fn main() { name(Color.Red) }',
  ].join('\n'));
  const warns = out.filter((d) => d.severity === 'warning' && d.code === 'NOVA4008');
  assert.equal(warns.length, 0);
});

test('unknown name reports NOVA3002', () => {
  const out = diags([
    'fn main() { print(undefined_thing) }',
  ].join('\n'));
  assert.ok(out.some((d) => d.severity === 'error' && d.code === 'NOVA3002'));
});

test('if condition must be Bool', () => {
  const out = diags([
    'fn main() {',
    '  if 42 { print("x") }',
    '}',
  ].join('\n'));
  assert.ok(out.some((d) => d.severity === 'error' && d.code === 'NOVA4001'));
});

test('assignment type mismatch', () => {
  const out = diags([
    'fn main() {',
    '  x: Int = "hello"',
    '}',
  ].join('\n'));
  assert.ok(out.some((d) => d.severity === 'error' && d.code === 'NOVA4002'));
});

test('return type mismatch', () => {
  const out = diags([
    'fn foo() -> Int { "not an int" }',
    'fn main() { foo() }',
  ].join('\n'));
  assert.ok(out.some((d) => d.severity === 'error' && d.code === 'NOVA4003'));
});

test('duplicate struct field', () => {
  const out = diags([
    'struct S { a: Int, a: Int }',
    'fn main() { }',
  ].join('\n'));
  assert.ok(out.some((d) => d.severity === 'error' && d.code === 'NOVA3001'));
});