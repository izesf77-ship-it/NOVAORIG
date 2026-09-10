/** Golden / snapshot tests for the NOVA compiler.
 *
 * Each `.nova` file in `tests/golden/` is compiled and its output is compared
 * against `*.expected.txt` siblings.  Run `UPDATE_GOLDEN=1 node --test` to
 * regenerate expected files.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileSources } from '../src/compiler/driver.ts';
import { astToHir } from '../src/compiler/hir/hir_lower.ts';
import { HirInterpreter } from '../src/runtime/hir_interp.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLD === '1' || process.env.UPDATE_GOLDEN === '1';

function run(src: string): { stdout: string; exit: number } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true; };
  try {
    const result = compileSources([{ file: 'golden.nova', source: src }]);
    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length > 0) {
      return { stdout: 'COMPILE_ERRORS\n' + errs.map((e) => `${e.code}: ${e.message}`).join('\n'), exit: 1 };
    }
    const hir = astToHir(result.programs, result.symbols, result.exprTypes);
    const interp = new HirInterpreter(hir, result.symbols);
    const code = interp.run();
    return { stdout: lines.join(''), exit: code };
  } finally {
    (process.stdout as { write: typeof orig }).write = orig;
  }
}

describe('golden', () => {
  if (!fs.existsSync(GOLDEN_DIR)) return;
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.nova'));
  if (files.length === 0) { test('golden: no cases'); return; }
  for (const file of files) {
    test(file, () => {
      const src = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
      const expectedFile = path.join(GOLDEN_DIR, file.replace(/\.nova$/, '.expected.txt'));
      const { stdout, exit } = run(src);
      const actual = `exit=${exit}\n${stdout.trimEnd()}\n`;
      if (UPDATE) {
        fs.writeFileSync(expectedFile, actual);
        return;
      }
      const expected = fs.existsSync(expectedFile)
        ? fs.readFileSync(expectedFile, 'utf8')
        : '<missing expected file>';
      assert.equal(actual, expected, `\n--- ${file} ---\n${actual}`);
    });
  }
});
