/** Lint rule tests (src/lint/lint.ts). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../src/compiler/driver.ts';
import { lintProgram } from '../src/lint/lint.ts';

function lint(src: string) {
  const r = compileSources([{ file: 't.nova', source: src }]);
  const lints = lintProgram({ programs: r.programs, source: (f) => r.sources.get(f) });
  return [...r.diagnostics, ...lints]
    .filter((d) => d.code.startsWith('NOVA7'))
    .map((d) => ({ code: d.code, message: d.message }));
}

describe('lint', () => {
  test('NOVA7004 empty block', () => {
    const out = lint([
      'fn main() {',
      '  if true {',
      '    if true { }',
      '  }',
      '}',
    ].join('\n'));
    assert.ok(out.some((d) => d.code === 'NOVA7004'), `expected NOVA7004, got ${JSON.stringify(out)}`);
  });

  test('NOVA7002 unreachable statement', () => {
    const out = lint([
      'fn main() {',
      '  print("a")',
      '  print("b")',
      '  return 0',
      '  print("unreachable")',
      '}',
    ].join('\n'));
    assert.ok(out.some((d) => d.code === 'NOVA7002'), `expected NOVA7002, got ${JSON.stringify(out)}`);
  });

  test('NOVA7003 suspicious comparison', () => {
    const out = lint([
      'fn main() {',
      '  x = 1',
      '  if x == x { print("same") }',
      '}',
    ].join('\n'));
    assert.ok(out.some((d) => d.code === 'NOVA7003'), `expected NOVA7003, got ${JSON.stringify(out)}`);
  });

  test('NOVA7005 unnecessary condition', () => {
    const out = lint([
      'fn main() {',
      '  if true { print("yes") }',
      '}',
    ].join('\n'));
    assert.ok(out.some((d) => d.code === 'NOVA7005'), `expected NOVA7005, got ${JSON.stringify(out)}`);
  });

  test('no lints on clean code', () => {
    const out = lint([
      'fn main() {',
      '  x = 1',
      '  print(x)',
      '}',
    ].join('\n'));
    assert.equal(out.filter((d) => d.code.startsWith('NOVA7')).length, 0);
  });

  test('while false marks following unreachable', () => {
    const out = lint([
      'fn main() {',
      '  while false { print("x") }',
      '  print("after")',
      '}',
    ].join('\n'));
    assert.ok(out.some((d) => d.code === 'NOVA7002'), `expected NOVA7002, got ${JSON.stringify(out)}`);
  });
});
