// M5 smoke test: compile NOVA sources → MIR → LLVM IR and print the IR.
import { compileSources } from '../src/compiler/driver.ts';
import { astToHir } from '../src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from '../src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from '../src/compiler/mir/mir_verify.ts';
import { lowerMirToLlvm } from '../src/compiler/backend/llvm_backend.ts';
import { NovaNativeError } from '../src/compiler/backend/native_error.ts';

const SOURCE = `fn add(a: Int, b: Int) -> Int {
    return a + b
}
fn main() {
    println("Hello from NOVA!")
}
`;

export function compileToLlvm(source: string, file = 'smoke.nova') {
  const res = compileSources([{ file, source }]);
  const errors = res.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    console.error('compile errors:', errors.map((e) => e.message).join('; '));
    process.exit(1);
  }
  const hir = astToHir(res.programs, res.symbols, res.exprTypes);
  const mir = mirLowerModule(hir, res.symbols);
  const verr = verifyMirModule(mir);
  if (verr.length > 0) {
    console.error('mir errors:', verr.map((e) => e.message).join('; '));
    process.exit(1);
  }
  return lowerMirToLlvm(mir, res.symbols);
}

const fs = await import('node:fs');
fs.writeFileSync('c:/Users/admin/Desktop/NOVA/_argv.txt', JSON.stringify(process.argv), 'utf8');
if (process.argv[1] === 'run') {
  const outFile = process.argv[2] ?? 'smoke_out.txt';
  const lines = [];
  const fs = await import('node:fs');
  try {
    const { text, entry } = compileToLlvm(SOURCE);
    lines.push('====== LLVM IR (entry=' + entry + ') ======');
    lines.push(text);
  } catch (e) {
    lines.push('ERROR: ' + ((e as { stack?: string; message?: string })?.stack ?? (e as Error).message));
  }
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log('wrote ' + outFile + ' (' + lines.length + ' lines)');
}