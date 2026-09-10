/**
 * Diagnostics tests.
 *
 * Verifies structured diagnostics: error codes, spans, help text, and JSON
 * output from `nova check --json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources, loadProgram } from '../src/compiler/driver.ts';
import type { NovaCompileError } from '../src/compiler/diagnostics/diagnostics.ts';
import { diagnosticsToJson } from '../src/compiler/diagnostics/diagnostics.ts';

function safeCompile(src: string): { diagnostics: ReturnType<typeof compileSources>['diagnostics'] } {
  try {
    return compileSources([{ file: 't.nova', source: src }]);
  } catch (e) {
    const ne = e as NovaCompileError;
    return { diagnostics: ne.diagnostics };
  }
}

test('NOVA1001: unexpected character', () => {
  const r = safeCompile('fn main() { print(@) }');
  assert.ok(r.diagnostics.some((d) => d.code === 'NOVA1001'));
});

test('NOVA2001: well-formed input has no errors', () => {
  const r = safeCompile('fn main() { }');
  assert.equal(r.diagnostics.filter((d) => d.severity === 'error').length, 0);
});

test('diagnostics JSON output is structured', () => {
  const r = safeCompile('fn main() { x: Int = "s" }');
  const json = diagnosticsToJson(r.diagnostics);
  const parsed = JSON.parse(json);
  assert.ok(parsed.diagnostics);
  const err = parsed.diagnostics.find((d: { code: string }) => d.code === 'NOVA4002');
  assert.ok(err, `NOVA4002 not found in ${json}`);
  assert.ok(err.message);
  assert.ok(err.severity === 'error');
  assert.ok(err.span.line);
  assert.ok(err.span.col);
});

test('deterministic diagnostic code + span', () => {
  // Same error in two separate compilations should have identical JSON.
  const a = diagnosticsToJson(safeCompile('fn main() { x: Int = "s" }').diagnostics);
  const b = diagnosticsToJson(safeCompile('fn main() { x: Int = "s" }').diagnostics);
  assert.equal(a, b);
});

test('NOVA2003: non-exhaustive match arm on int subject is not an error', () => {
  // NOVA match arms can have a binding; this should compile (with a
  // possible unused-variable warning) rather than a parse error.
  const r = safeCompile('fn main() { match 1 { x => 0 } }');
  const errs = r.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(errs.length, 0, `unexpected errors: ${r.diagnostics.map((d) => d.code).join(',')}`);
});

test('NOVA4006: ? operator on non-Result', () => {
  const r = safeCompile('fn main() { print(1?) }');
  assert.ok(r.diagnostics.some((d) => d.code === 'NOVA4006'));
});

test('NOVA4001: type mismatch on operator', () => {
  const r = safeCompile('fn main() { 1 + "s" }');
  assert.ok(r.diagnostics.some((d) => d.code === 'NOVA4001'));
});

test('NOVA6002: cannot read file', () => {
  try {
    loadProgram('C:\\does-not-exist.nova');
    assert.fail('expected throw');
  } catch (e: any) {
    assert.ok(e.diagnostics.some((d: { code: string }) => d.code === 'NOVA6002'));
  }
});