import { Parser } from '../src/compiler/parser/parser.ts';
import { Checker } from '../src/compiler/typechecker/checker.ts';
import { Interpreter } from '../src/runtime/interpreter.ts';
import { compileSources } from '../src/compiler/driver.ts';

const src = `struct User {
  id: Int
  name: String
}

fn greet(user: User) -> String {
  "Hello, {user.name}!"
}

fn main() {
  user = User(id: 1, name: "Kirill")
  print(greet(user))
  nums = [1, 2, 3]
  total = 0
  for n in nums {
    total = total + n
  }
  print(total)
  match total {
    6 => print("six")
    _ => print("other")
  }
  m = {a: 1, "b": 2}
  print(m.a + m["b"])
  x: Int = 5
  if x > 3 and not false {
    print("big")
  }
}
`;

// 1. Parse
const prog = new Parser(src, 'test.nova').parseProgram();
console.log('decls:', prog.decls.map((d) => d.kind + (d.kind === 'fn' ? ':' + d.name : '')).join(', '));

// 2. Type check
const checker = new Checker([prog]);
const { diagnostics } = checker.check();
const errors = diagnostics.filter((d) => d.severity === 'error');
if (errors.length > 0) {
  for (const e of errors) console.log(`CHECK ERROR: ${e.code} ${e.message}`);
  process.exit(1);
}
console.log('type check: OK');

// 3. Interpret
const result = compileSources([{ file: 'test.nova', source: src }]);
const compileErrors = result.diagnostics.filter((d) => d.severity === 'error');
if (compileErrors.length > 0) {
  console.log('compile diagnostics:');
  for (const d of compileErrors) {
    console.log(`  ${d.code}: ${d.message}`);
  }
  process.exit(1);
}
const interp = new Interpreter(result.programs, result.symbols);
const code = interp.run();
console.log('exit code:', code);
const runtimeDiagnostics = interp.getDiagnostics();
if (runtimeDiagnostics.length > 0) {
  console.log('runtime diagnostics:');
  for (const d of runtimeDiagnostics) {
    console.log(`  ${d.code}: ${d.message}`);
  }
}
