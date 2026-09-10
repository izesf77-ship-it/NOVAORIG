/**
 * Shared helpers for MIR tests.
 *
 * Every MIR test goes through the real pipeline:
 *
 *   .nova source -> parse -> resolve -> typecheck -> astToHir -> mirLowerModule
 *
 * then either verifies the MIR (verifyMirModule) or runs it on the reference
 * interpreter (MirInterpreter). No fakes, no skipped lowering steps.
 */
import { compileSources } from '../../src/compiler/driver.ts';
import { astToHir } from '../../src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from '../../src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from '../../src/compiler/mir/mir_verify.ts';
import { mirToJson, mirToString } from '../../src/compiler/mir/mir_serialize.ts';
import { MirInterpreter } from '../../src/compiler/mir/mir_interp.ts';

export function buildMir(src: string) {
  const r = compileSources([{ file: 't.nova', source: src }]);
  const errs = r.diagnostics.filter((d) => d.severity === 'error');
  if (errs.length > 0) {
    throw new Error('compile failed: ' + errs.map((e) => e.code + ': ' + e.message).join('; '));
  }
  const hir = astToHir(r.programs, r.symbols, r.exprTypes);
  const mir = mirLowerModule(hir, r.symbols);
  return mir;
}

/** Build MIR and assert it verifies cleanly. */
export function buildVerifiedMir(src: string) {
  const mir = buildMir(src);
  const errors = verifyMirModule(mir);
  if (errors.length > 0) {
    throw new Error('MIR verification failed:\n' + errors.map((e) => `  [${e.fn}${e.block ? `/${e.block}` : ''}] ${e.message}`).join('\n'));
  }
  return mir;
}

/** Build MIR, verify it, and return a fresh interpreter. */
export function buildInterp(src: string, write?: (s: string) => void): MirInterpreter {
  const mir = buildVerifiedMir(src);
  return new MirInterpreter(mir, { write });
}

/** Capture stdout from a MirInterpreter run. */
export function capture(interp: MirInterpreter, entry = 'main'): { stdout: string; exit: number } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  try {
    const exit = interp.run(entry);
    return { stdout: out, exit };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

export { mirToJson, mirToString };
