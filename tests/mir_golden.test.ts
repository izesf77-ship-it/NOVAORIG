/**
 * MIR golden tests.
 *
 * Each fixture in tests/mir_golden/ has input.nova + expected.mir.json.
 * The lowering is deterministic, so a byte-identical JSON comparison holds.
 * Regenerate with UPDATE_MIR_GOLDEN=1.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildVerifiedMir, mirToJson } from './mir/mir_helper.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, 'mir_golden');
const UPDATE = process.env.UPDATE_MIR_GOLDEN === '1';

describe('mir-golden', () => {
  if (!fs.existsSync(GOLDEN_DIR)) return;
  const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.nova'));
  if (files.length === 0) { test('mir-golden: no cases'); return; }
  for (const file of files) {
    test(`golden ${file}`, () => {
      const src = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
      const jsonName = file.replace(/\.nova$/, '.expected.mir.json');
      const expectedPath = path.join(GOLDEN_DIR, jsonName);
      const mir = buildVerifiedMir(src);
      const actual = JSON.stringify(mirToJson(mir), null, 2);
      if (UPDATE) {
        fs.writeFileSync(expectedPath, actual + '\n');
        return;
      }
      const expected = fs.readFileSync(expectedPath, 'utf8');
      assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
    });
  }
});
