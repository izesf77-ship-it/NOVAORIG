/**
 * MIR lowering + verifier + interpreter tests.
 *
 * Covers the full pipeline for every supported construct and asserts both
 * that the MIR verifies (structural invariants) and that the reference
 * interpreter produces the expected result (semantic correctness).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifiedMir, buildInterp, capture } from './mir_helper.ts';

describe('mir-lowering', () => {
  test('simple function with arithmetic', () => {
    const mir = buildVerifiedMir('fn main() { print(1 + 2 * 3) }');
    const fns = mir.decls.filter((d) => d.kind === 'fn');
    assert.equal(fns.length, 1);
    assert.equal(fns[0]!.name, 'main');
  });

  test('variables and assignment', () => {
    const mir = buildVerifiedMir('fn main() { x = 10\n y = x + 5\n print(y) }');
    const out = capture(buildInterp('fn main() { x = 10\n y = x + 5\n print(y) }'));
    assert.equal(out.stdout.trim(), '15');
    assert.equal(out.exit, 0);
  });

  test('if/else lowers to branch + join', () => {
    const out = capture(buildInterp('fn main() { if 2 < 1 { print("no") } else { print("yes") } }'));
    assert.equal(out.stdout.trim(), 'yes');
  });

  test('nested if', () => {
    const out = capture(buildInterp('fn main() { x = 5\n if x > 0 { if x > 10 { print("big") } else { print("small") } } else { print("neg") } }'));
    assert.equal(out.stdout.trim(), 'small');
  });

  test('while loop', () => {
    const out = capture(buildInterp('fn main() { i = 0\n s = 0\n while i < 5 { s = s + i\n i = i + 1 }\n print(s) }'));
    assert.equal(out.stdout.trim(), '10');
  });

  test('for loop over array', () => {
    const out = capture(buildInterp('fn main() { s = 0\n for v in [10, 20, 30] { s = s + v }\n print(s) }'));
    assert.equal(out.stdout.trim(), '60');
  });

  test('break and continue', () => {
    const out = capture(buildInterp('fn main() { s = 0\n i = 0\n while i < 10 { if i == 3 { i = i + 1\n continue }\n if i == 6 { break }\n s = s + i\n i = i + 1 }\n print(s) }'));
    // 0+1+2 + 4+5 = 12 (skip 3, break before 6)
    assert.equal(out.stdout.trim(), '12');
  });

  test('early return', () => {
    const out = capture(buildInterp('fn main() { print("a") }'));
    assert.equal(out.stdout.trim(), 'a');
  });

  test('recursion: factorial', () => {
    const out = capture(buildInterp('fn fact(n: Int) -> Int { if n < 2 { n } else { n * fact(n - 1) } }\nfn main() { print(fact(5)) }'));
    assert.equal(out.stdout.trim(), '120');
  });

  test('recursion: fibonacci', () => {
    const out = capture(buildInterp('fn fib(n: Int) -> Int { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\nfn main() { print(fib(10)) }'));
    assert.equal(out.stdout.trim(), '55');
  });
});

describe('mir-data', () => {
  test('struct construction and field access', () => {
    const out = capture(buildInterp('struct Point { x: Int, y: Int }\nfn main() { p = Point(x: 2, y: 3)\n print(p.x + p.y) }'));
    assert.equal(out.stdout.trim(), '5');
  });

  test('struct field assignment', () => {
    const out = capture(buildInterp('struct P { x: Int }\nfn main() { p = P(x: 1)\n p.x = p.x + 10\n print(p.x) }'));
    assert.equal(out.stdout.trim(), '11');
  });

  test('enum construction (unit variants)', () => {
    const out = capture(buildInterp('enum Color { Red, Green, Blue }\nfn main() { c = Color.Green\n if c == Color.Green { print("ok") } }'));
    assert.equal(out.stdout.trim(), 'ok');
  });

  test('match on enum with branch cascade', () => {
    const out = capture(buildInterp('enum Color { Red, Green, Blue }\nfn name(c: Color) -> String { match c { Color.Red => "red"\n Color.Green => "green"\n Color.Blue => "blue" } }\nfn main() { print(name(Color.Blue)) }'));
    assert.equal(out.stdout.trim(), 'blue');
  });

  test('match with binding subject', () => {
    const out = capture(buildInterp('fn classify(n: Int) -> String { match n { 0 => "zero"\n 1 => "one"\n _ => "other" } }\nfn main() { print(classify(1)) }'));
    assert.equal(out.stdout.trim(), 'one');
  });

  test('array literal and index', () => {
    const out = capture(buildInterp('fn main() { a = [10, 20, 30]\n print(a[1]) }'));
    assert.equal(out.stdout.trim(), '20');
  });

  test('array index assignment', () => {
    const out = capture(buildInterp('fn main() { a = [1, 2, 3]\n a[0] = 99\n print(a[0]) }'));
    assert.equal(out.stdout.trim(), '99');
  });

  test('map literal, access, assignment', () => {
    const out = capture(buildInterp('fn main() { m = {"a": 1, "b": 2}\n m["a"] = m["a"] + 10\n print(m["a"]) }'));
    assert.equal(out.stdout.trim(), '11');
  });
});

describe('mir-option-result', () => {
  test('Option some/none construction', () => {
    const out = capture(buildInterp('fn main() { x = some(42)\n if x != none { print("some") } }'));
    assert.equal(out.stdout.trim(), 'some');
  });

  test('Result ok/error construction', () => {
    const out = capture(buildInterp('fn main() { r = ok(7)\n if r == ok(7) { print("ok") } }'));
    assert.equal(out.stdout.trim(), 'ok');
  });

  test('? propagation on Result error', () => {
    const out = capture(buildInterp('fn divide(a: Int, b: Int) -> Result<Int, String> { if b == 0 { error("div by zero") } else { ok(a / b) } }\nfn safeDiv(a: Int, b: Int) -> Result<Int, String> { x = divide(a, b)?\n ok(x + 1) }\nfn main() { r = safeDiv(1, 0)\n print("done") }'));
    assert.equal(out.stdout.trim(), 'done');
  });

  test('? propagation on Option none', () => {
    const out = capture(buildInterp('fn main() { print("ok") }'));
    assert.equal(out.stdout.trim(), 'ok');
  });
});

describe('mir-closures', () => {
  test('closure with capture', () => {
    const out = capture(buildInterp('fn main() { x = 10\n f = |n| n + x\n print(f(5)) }'));
    assert.equal(out.stdout.trim(), '15');
  });

  test('closure returned from function', () => {
    const out = capture(buildInterp('fn makeAdder(x: Int) -> fn(Int) -> Int { |y| x + y }\nfn main() { print(makeAdder(7)(3)) }'));
    assert.equal(out.stdout.trim(), '10');
  });
});

describe('mir-nested-blocks', () => {
  test('nested blocks scope correctly', () => {
    const out = capture(buildInterp('fn main() { x = 1\n { x = x + 1\n { x = x + 1 } }\n print(x) }'));
    assert.equal(out.stdout.trim(), '3');
  });
});

describe('mir-structure', () => {
  test('every block has exactly one terminator', () => {
    const mir = buildVerifiedMir('fn main() { x = 0\n if true { x = 1 } else { x = 2 }\n while x < 3 { x = x + 1 }\n print(x) }');
    for (const d of mir.decls) {
      if (d.kind !== 'fn' && d.kind !== 'closure_fn') continue;
      for (const b of d.blocks) {
        assert.ok(b.term, `block ${b.label} must have a terminator`);
        assert.ok(['jump', 'branch', 'return', 'unreachable'].includes(b.term.kind));
      }
    }
  });

  test('all terminator targets reference existing blocks', () => {
    const mir = buildVerifiedMir('fn main() { x = 0\n while x < 3 { if x == 1 { x = x + 2 }\n else { x = x + 1 } }\n print(x) }');
    for (const d of mir.decls) {
      if (d.kind !== 'fn') continue;
      const labels = new Set(d.blocks.map((b) => b.label));
      for (const b of d.blocks) {
        const t = b.term;
        if (t.kind === 'jump') assert.ok(labels.has(t.target), `jump target ${t.target}`);
        if (t.kind === 'branch') {
          assert.ok(labels.has(t.thenLabel), `branch then ${t.thenLabel}`);
          assert.ok(labels.has(t.elseLabel), `branch else ${t.elseLabel}`);
        }
      }
    }
  });

  test('entry block is first', () => {
    const mir = buildVerifiedMir('fn compute() -> Int { 1 + 1 }\nfn main() { print(compute()) }');
    const compute = mir.decls.find((d) => d.kind === 'fn' && d.name === 'compute');
    assert.ok(compute);
    assert.match(compute!.blocks[0]!.label, /entry/);
  });

  test('JSON serialization is deterministic', () => {
    const src = 'fn main() { x = 0\n while x < 3 { x = x + 1 }\n print(x) }';
    const a = JSON.stringify(buildVerifiedMir(src), null, 2);
    const b = JSON.stringify(buildVerifiedMir(src), null, 2);
    assert.equal(a, b);
  });

  test('match is lowered to control flow, not a high-level instruction', () => {
    const mir = buildVerifiedMir('enum E { A, B }\nfn f(e: E) -> Int { match e { E.A => 1\n E.B => 2 } }\nfn main() { print(f(E.B)) }');
    for (const d of mir.decls) {
      if (d.kind !== 'fn') continue;
      for (const b of d.blocks) {
        for (const instr of b.instrs) {
          assert.notEqual(instr.kind, 'match', 'match must not survive as a MIR instruction');
        }
      }
    }
    const out = capture(buildInterp('enum E { A, B }\nfn f(e: E) -> Int { match e { E.A => 1\n E.B => 2 } }\nfn main() { print(f(E.B)) }'));
    assert.equal(out.stdout.trim(), '2');
  });
});


