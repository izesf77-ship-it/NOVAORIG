import { compileSources } from './src/compiler/driver.ts';
import { astToHir } from './src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from './src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from './src/compiler/mir/mir_verify.ts';
import { HirInterpreter } from './src/runtime/hir_interp.ts';

const src = process.argv[2] ?? 'fn main() { v = some(7)\n match v { some(n) => { print(n) } none => { print("none") } } }';
const result = compileSources([{ file: 'test.nova', source: src }]);
const errs = result.diagnostics.filter((d) => d.severity === 'error');
console.log('diags:', JSON.stringify(result.diagnostics, null, 1));
if (errs.length === 0) {
  const hir = astToHir(result.programs, result.symbols, result.exprTypes);
  const mir = mirLowerModule(hir, result.symbols);
  const verr = verifyMirModule(mir);
  console.log('mir verify:', JSON.stringify(verr));
  const interp = new HirInterpreter(hir, result.symbols);
  const code = interp.run();
  console.log('exit:', code);
}
