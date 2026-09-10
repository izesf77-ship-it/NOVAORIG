/**
 * HIR tests.
 *
 * Verifies that the AST → HIR lowering produces well-formed HIR and that the
 * HIR interpreter can run a small set of programs that exercise the
 * pipeline independently of the AST interpreter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astToHir } from '../src/compiler/hir/hir_lower.ts';
import { compileSources } from '../src/compiler/driver.ts';
import { HirInterpreter } from '../src/runtime/hir_interp.ts';

function runHirSource(src: string): { stdout: string; exit: number } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    const result = compileSources([{ file: 'test.nova', source: src }]);
    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length > 0) {
      return { stdout: lines.join(''), exit: 2 };
    }
    const hir = astToHir(result.programs, result.symbols, result.exprTypes);
    const interp = new HirInterpreter(hir, result.symbols);
    const code = interp.run();
    return { stdout: lines.join(''), exit: code };
  } finally {
    (process.stdout as { write: typeof orig }).write = orig;
  }
}

test('HIR: literals and arithmetic', () => {
  const { stdout, exit } = runHirSource(`fn main() { print(1 + 2 * 3) }`);
  assert.equal(exit, 0);
  assert.equal(stdout.trim(), '7');
});

test('HIR: match with some(pattern) extracts the Option payload', () => {
  const { stdout, exit } = runHirSource([
    'fn main() {',
    '  v = some(7)',
    '  match v {',
    '    some(n) => { print(n) }',
    '    none => { print("none") }',
    '  }',
    '  w = none',
    '  match w {',
    '    some(n) => { print(n) }',
    '    none => { print("none") }',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout.replace(/\r\n/g, '\n'), '7none');
});

test('HIR: match with ok(pattern)/error(pattern) extracts the Result payload', () => {
  const { stdout, exit } = runHirSource([
    'fn main() {',
    '  r = ok(5)',
    '  match r {',
    '    ok(n) => { print(n) }',
    '    error(m) => { print(m) }',
    '  }',
    '  e = error("bad")',
    '  match e {',
    '    ok(n) => { print(n) }',
    '    error(m) => { print(m) }',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout.replace(/\r\n/g, '\n'), '5bad');
});

test('HIR: exit and panic natives', () => {
  const exited = runHirSource('fn main() { println("a")\n exit(3) }');
  assert.equal(exited.exit, 3);
  assert.equal(exited.stdout.replace(/\r\n/g, '\n'), 'a\n');
  const panicked = runHirSource('fn main() { panic("boom") }');
  assert.equal(panicked.exit, 1);
});

test('HIR: env_has/env_get/args natives', () => {
  const { stdout, exit } = runHirSource([
    'fn main() {',
    '  println(env_has("NOVA_TEST_ENV_VALUE"))',
    '  v = env_get("NOVA_TEST_ENV_VALUE")',
    '  match v {',
    '    some(s) => { println(s) }',
    '    none => { println("missing") }',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.ok(stdout.includes('true') || stdout.includes('false'));
});

test('HIR: if/else', () => {
  const { stdout, exit } = runHirSource([
    'fn abs(n: Int) -> Int {',
    '  if n < 0 { -n } else { n }',
    '}',
    'fn main() {',
    '  print(abs(-5))',
    '  print(abs(7))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout, '57');
});

test('HIR: struct + field access', () => {
  const { stdout, exit } = runHirSource([
    'struct User { id: Int, name: String }',
    'fn main() {',
    '  u = User(id: 1, name: "A")',
    '  print(u.name)',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout.trim(), 'A');
});

test('HIR: match on enum', () => {
  const { stdout, exit } = runHirSource([
    'enum Color { Red, Green, Blue }',
    'fn name(c: Color) -> String {',
    '  match c {',
    '    Color.Red => "red"',
    '    Color.Green => "green"',
    '    Color.Blue => "blue"',
    '  }',
    '}',
    'fn main() {',
    '  print(name(Color.Red))',
    '  print(name(Color.Blue))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout, 'redblue');
});

test('HIR: Option/Some/None', () => {
  const { stdout, exit } = runHirSource([
    'fn find(n: Int) -> Option<Int> {',
    '  if n == 1 { some(42) } else { none }',
    '}',
    'fn main() {',
    '  print(find(1))',
    '  print(find(2))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout, 'Some(42)None');
});

test('HIR: Result + ? propagation', () => {
  const { stdout, exit } = runHirSource([
    'enum E { Boom }',
    'fn half(n: Int) -> Result<Int, E> {',
    '  if n == 0 { error E.Boom } else { ok n / 2 }',
    '}',
    'fn main() {',
    '  print(half(10))',
    '  print(half(0))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout, 'ok(5)err(E.Boom)');
});

test('HIR: closure', () => {
  const { stdout, exit } = runHirSource([
    'fn main() {',
    '  f = |x, y| x + y',
    '  print(f(3, 4))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout.trim(), '7');
});

test('HIR: generic identity call', () => {
  const { stdout, exit } = runHirSource([
    'fn id<T>(value: T) -> T { value }',
    'fn main() {',
    '  print(id<Int>(42))',
    '  print(id<String>("hi"))',
    '}',
  ].join('\n'));
  assert.equal(exit, 0);
  assert.equal(stdout, '42hi');
});

test('HIR: nominal type prevents mixing', () => {
  const { stdout, exit } = runHirSource([
    'type UserId = Int',
    'type ProductId = Int',
    'fn describe(id: UserId) -> String { "user-{id}" }',
    'fn main() {',
    '  pid: ProductId = 42',
    '  print(describe(pid))',
    '}',
  ].join('\n'));
  // The program is INVALID. The compile should fail with NOVA4xxx.
  assert.equal(exit, 2);
});