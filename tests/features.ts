/**
 * Feature tests: native functions, modules, closures, pattern matching.
 * Runs multiple mini-programs and asserts expected output.
 */
import { Interpreter } from '../src/runtime/interpreter.ts';
import { compileSources } from '../src/compiler/driver.ts';

let passed = 0;
let failed = 0;

function run(name: string, src: string, expected: string[]): void {
  const result = compileSources([{ file: `${name}.nova`, source: src }]);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    console.log(`  ✗ ${name}: compile errors`);
    for (const e of errors) console.log(`      ${e.code}: ${e.message}`);
    failed++;
    return;
  }
  const interp = new Interpreter(result.programs, result.symbols);
  // Capture stdout
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    lines.push(s.toString().trim());
    return true;
  };
  try {
    interp.run();
  } finally {
    process.stdout.write = orig;
  }
  const actual = lines.filter((l) => l.length > 0);
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('Native function tests:');

run(
  'math_ops',
  `fn main() {
     print(abs(-5))
     print(min(3, 7, 2))
     print(max(3, 7, 2))
     print(floor(3.7))
     print(ceil(3.2))
     print(round(3.5))
     print(pow(2, 10))
     print(sqrt(16))
     print(typeof(42))
     print(typeof("hello"))
     print(typeof([1,2]))
     print(typeof(true))
     print(typeof(null))
   }`,
  ['5', '2', '7', '3', '4', '4', '1024', '4', 'Int', 'String', 'Array', 'Bool', 'null'],
);

run(
  'array_ops',
  `fn main() {
     a = [1, 2, 3]
     print(first(a))
     print(last(a))
     push(a, 4)
     print(a)
     print(pop(a))
     print(a)
     print(slice(a, 0, 2))
     print(join(a, "-"))
     print(contains(a, 2))
     print(contains(a, 99))
     print(reverse(a))
     print(sort([3, 1, 2]))
   }`,
  ['1', '3', '[1, 2, 3, 4]', '4', '[1, 2, 3]', '[1, 2]', '1-2-3', 'true', 'false', '[3, 2, 1]', '[1, 2, 3]'],
);

run(
  'map_ops',
  `fn main() {
     m = {"a": 1, "b": 2}
     print(has(m, "a"))
     print(has(m, "z"))
     remove(m, "a")
     print(has(m, "a"))
     m2 = {"c": 3}
     merged = merge(m, m2)
     print(merged)
     print(keys(merged))
     print(values(merged))
   }`,
  ['true', 'false', 'false', '{b: 2, c: 3}', '[b, c]', '[2, 3]'],
);

run(
  'string_slice',
  `fn main() {
     s = "hello world"
     print(slice(s, 0, 5))
     print(contains(s, "world"))
     print(join(["a", "b", "c"], ","))
   }`,
  ['hello', 'true', 'a,b,c'],
);

run(
  'fib_match',
  `fn fib(n: Int) -> Int {
     if n <= 1 {
       n
     } else {
       fib(n - 1) + fib(n - 2)
     }
   }

   fn main() {
     print(fib(0))
     print(fib(1))
     print(fib(5))
     print(fib(10))
   }`,
  ['0', '1', '5', '55'],
);



run(
  'enum_simple',
  `enum Color {
     Red
     Green
     Blue
   }

   fn to_string(c: Color) -> String {
     result: String = ""
     match c {
       Color.Red => { result = "red" }
       Color.Green => { result = "green" }
       Color.Blue => { result = "blue" }
     }
     result
   }

   fn main() {
     print(to_string(Color.Red))
     print(to_string(Color.Green))
     print(to_string(Color.Blue))
   }`,
  ['red', 'green', 'blue'],
);

console.log('\nModule tests:');

function runModule(name: string, sources: Array<{ file: string; source: string }>, expected: string[]): void {
  const result = compileSources(sources);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    console.log(`  ✗ ${name}: compile errors`);
    for (const e of errors) console.log(`      ${e.code}: ${e.message}`);
    failed++;
    return;
  }
  const interp = new Interpreter(result.programs, result.symbols);
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    lines.push(s.toString().trim());
    return true;
  };
  try {
    interp.run();
  } finally {
    process.stdout.write = orig;
  }
  const actual = lines.filter((l) => l.length > 0);
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

runModule(
  'use_module',
  [
    { file: 'math.nova', source: `fn add(a: Int, b: Int) -> Int { a + b }` },
    { file: 'main.nova', source: `use "math.nova"\nfn main() { print(add(2, 3)) }` },
  ],
  ['5'],
);

run(
  'nominal_types',
  `type UserId = Int
   type ProductId = Int

   fn loadUser(id: UserId) -> String {
     "user-{id}"
   }

   fn main() {
     uid: UserId = 42
     print(loadUser(uid))
   }`,
  ['user-42'],
);

run(
  'option_type',
  `fn findUser(id: Int) -> Option<String> {
     if id == 1 {
       some("Alice")
     } else {
       none
     }
   }

   fn main() {
     print(findUser(1))
     print(findUser(2))
   }`,
  ['Some(Alice)', 'None'],
);

run(
  'result_type',
  `enum MathError {
     DivisionByZero
   }

   fn divide(a: Int, b: Int) -> Result<Int, MathError> {
     if b == 0 {
       return error MathError.DivisionByZero
     }
     ok a / b
   }

   fn main() {
     print(divide(10, 2))
     print(divide(10, 0))
   }`,
  ['ok(5)', 'err(MathError.DivisionByZero)'],
);

run(
  'generic_identity',
  `fn identity<T>(value: T) -> T {
     value
   }

   fn main() {
     print(identity<Int>(42))
     print(identity<String>("hello"))
   }`,
  ['42', 'hello'],
);

run(
  'result_propagate',
  `enum MathError {
     DivisionByZero
   }

   fn divide(a: Int, b: Int) -> Result<Int, MathError> {
     if b == 0 {
       return error MathError.DivisionByZero
     }
     ok a / b
   }

   fn doubleDiv(a: Int, b: Int) -> Result<Int, MathError> {
     q = divide(a, b)?
     ok q * 2
   }

   fn main() {
     print(doubleDiv(10, 2))
     print(doubleDiv(10, 0))
   }`,
  ['ok(10)', 'err(MathError.DivisionByZero)'],
);

console.log(`\n${passed}/${passed + failed} feature tests passed`);
process.exit(failed > 0 ? 1 : 0);
