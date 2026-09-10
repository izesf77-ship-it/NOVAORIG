import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compile, compileSources } from '../../src/compiler/driver.ts';
import { astToHir } from '../../src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from '../../src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from '../../src/compiler/mir/mir_verify.ts';
import { lowerMirToLlvm } from '../../src/compiler/backend/llvm_backend.ts';
import { canonicalizeLlvm } from '../../src/compiler/backend/llvm/llvm_ir.ts';
import { NovaNativeError } from '../../src/compiler/backend/native_error.ts';
import { detectNativeToolchain } from '../../src/compiler/target/toolchain.ts';

const DIR = path.join(import.meta.dirname, '.');
const FIXTURE = path.join(DIR, 'add.nova');
const EXPECTED = path.join(DIR, 'add.expected.ll');

function lowerFixture(): string {
  const compiled = compile(FIXTURE);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  assert.deepEqual(verifyMirModule(mir), []);
  return canonicalizeLlvm(lowerMirToLlvm(mir, compiled.symbols).text);
}

function lowerSource(source: string): string {
  const compiled = compileSources([{ file: 'llvm-matrix.nova', source }]);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  assert.deepEqual(verifyMirModule(mir), []);
  return lowerMirToLlvm(mir, compiled.symbols).text;
}

describe('LLVM backend', () => {
  test('lowers MIR to deterministic real LLVM IR', () => {
    const actual = lowerFixture();
    const expected = fs.readFileSync(EXPECTED, 'utf8').replace(/\r\n/g, '\n').trim();
    const addFunction = actual.match(/define i64 @f0\([\s\S]*?\n\}/)?.[0];
    assert.equal(addFunction, expected);
    assert.match(actual, /target triple = "x86_64-pc-windows-msvc"/);
    assert.match(actual, /define i64 @f0\(i64 %arg0, i64 %arg1\)/);
    assert.match(actual, /add i64 %arg0, %arg1/);
    assert.match(actual, /ret i64/);
  });

  test('reports native toolchain availability without mutating the system', () => {
    const toolchain = detectNativeToolchain();
    assert.equal(typeof toolchain.available, 'boolean');
    assert.equal(typeof toolchain.message, 'string');
  });

  test('lowers the supported MIR coverage matrix', () => {
    const cases: Array<[string, string]> = [
      ['sub', 'fn sub(a: Int, b: Int) -> Int { a - b }\nfn main() {}'],
      ['mul', 'fn mul(a: Int, b: Int) -> Int { a * b }\nfn main() {}'],
      ['div', 'fn div(a: Int, b: Int) -> Int { a / b }\nfn main() {}'],
      ['float', 'fn add(a: Float, b: Float) -> Float { a + b }\nfn main() {}'],
      ['bool comparison', 'fn main() { if 2 < 3 { print("yes") } }'],
      ['if_else', 'fn main() { if false { print("no") } else { print("yes") } }'],
      ['while', 'fn main() { i = 0\n while i < 2 { i = i + 1 } }'],
      ['for', 'fn main() { s = 0\n for x in [1, 2] { s = s + x } }'],
      ['break_continue', 'fn main() { i = 0\n while i < 3 { i = i + 1\n if i == 1 { continue }\n if i == 2 { break } } }'],
      ['function_call', 'fn add(a: Int, b: Int) -> Int { a + b }\nfn main() { x = add(1, 2) }'],
      ['recursion', 'fn fact(n: Int) -> Int { if n < 2 { n } else { n * fact(n - 1) } }\nfn main() { x = fact(3) }'],
      ['struct', 'struct P { x: Int, y: Int }\nfn main() { p = P(x: 1, y: 2)\n x = p.x + p.y }'],
      ['enum', 'enum E { A, B }\nfn main() { e = E.B\n if e == E.B { print("ok") } }'],
      ['option', 'fn main() { x = some(1)\n if x != none { y = 1 } }'],
      ['string', 'fn main() { println("hello") }'],
      ['integer print', 'fn main() { println(42) }'],
      ['bool print', 'fn main() { println(true) }'],
      ['array', 'fn main() { a = [1, 2]\n x = a[0] }'],
      ['closure', 'fn main() { x = 1\n f = |n| n + x\n y = f(2) }'],
    ];
    for (const [name, source] of cases) {
      assert.doesNotThrow(() => lowerSource(source), name);
    }
  });

  test('rejects unsupported differing-payload Result lowering explicitly', () => {
    assert.throws(
      () => lowerSource('fn main() { x = ok(1) }'),
      (error: unknown) => error instanceof NovaNativeError && error.code === 'NOVA2001',
    );
  });
});
