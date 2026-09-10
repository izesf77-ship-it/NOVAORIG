// M5 probe: NOVA -> MIR -> LLVM IR (mjs driver, dynamic .ts imports).
import * as fs from 'node:fs';

const outLines = [];
try {
  const driver = await import('../src/compiler/driver.ts');
  const hirLower = await import('../src/compiler/hir/hir_lower.ts');
  const mirLower = await import('../src/compiler/mir/mir_lower.ts');
  const mirVerify = await import('../src/compiler/mir/mir_verify.ts');
  const llvmBackend = await import('../src/compiler/backend/llvm_backend.ts');
  const err = await import('../src/compiler/backend/native_error.ts');

  outLines.push('imports OK');

  const source = `fn add(a: Int, b: Int) -> Int {
    return a + b
}
fn main() {
    println("Hello from NOVA!")
}
`;
  const res = driver.compileSources([{ file: 'probe.nova', source }]);
  const errors = res.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    outLines.push('compile errors: ' + errors.map((e) => e.message).join('; '));
  } else {
    outLines.push('frontend OK');
    const hir = hirLower.astToHir(res.programs, res.symbols, res.exprTypes);
    const mir = mirLower.mirLowerModule(hir, res.symbols);
    const verr = mirVerify.verifyMirModule(mir);
    if (verr.length > 0) outLines.push('mir errors: ' + verr.map((e) => e.message).join('; '));
    else {
      outLines.push('MIR OK');
      const { text, entry } = llvmBackend.lowerMirToLlvm(mir, res.symbols);
      outLines.push('===== LLVM IR (entry=' + entry + ') =====');
      outLines.push(text);
    }
  }
} catch (e) {
  outLines.push('THROWN: ' + ((e && e.stack) || String(e)));
}
fs.writeFileSync('c:/Users/admin/Desktop/NOVA/probe_out.txt', outLines.join('\n'), 'utf8');
console.log('probe done');