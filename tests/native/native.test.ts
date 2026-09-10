import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compile } from '../../src/compiler/driver.ts';
import { astToHir } from '../../src/compiler/hir/hir_lower.ts';
import { mirLowerModule } from '../../src/compiler/mir/mir_lower.ts';
import { verifyMirModule } from '../../src/compiler/mir/mir_verify.ts';
import { buildNative } from '../../src/compiler/backend/llvm_backend.ts';
import { detectNativeToolchain } from '../../src/compiler/target/toolchain.ts';

const fixture = path.join(import.meta.dirname, 'hello.nova');
const outputBase = path.join(import.meta.dirname, 'dist', 'hello');
const toolchain = detectNativeToolchain();

function buildVerifiedNative(sourceFile: string, base: string): string {
  const compiled = compile(sourceFile);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  assert.deepEqual(verifyMirModule(mir), []);
  const result = buildNative(mir, compiled.symbols, base, { release: true, emit: 'exe' });
  assert.ok(result.exePath && fs.existsSync(result.exePath));
  return result.exePath;
}

test('native hello builds and executes as PE/AMD64', { skip: !toolchain.available }, () => {
  try {
    const exePath = buildVerifiedNative(fixture, outputBase);

    const bytes = fs.readFileSync(exePath);
    assert.equal(bytes[0], 0x4d);
    assert.equal(bytes[1], 0x5a);
    const peOffset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString('ascii', peOffset, peOffset + 4), 'PE\0\0');
    assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664);
    const optionalHeader = peOffset + 24;
    assert.equal(bytes.readUInt16LE(optionalHeader), 0x20b);
    assert.notEqual(bytes.readUInt32LE(optionalHeader + 16), 0);

    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'Hello from NOVA!\n');
  } finally {
    fs.rmSync(path.dirname(outputBase), { recursive: true, force: true });
  }
});

test('native println formats signed Int values', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'print_int');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'print_int.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), '-42\n0\n2147483647\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native println formats Bool values', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'print_bool');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'print_bool.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'true\nfalse\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native println formats Float values', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'print_float');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'print_float.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), '3.140000\n-42.500000\n0.000000\n0.000001\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native input reads and trims one UTF-8 line', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'input');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'input.nova'), base);
    const run = spawnSync(exePath, [], { input: 'NOVA input\r\nsecond line\r\n', encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'NOVA input\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native struct field mutation updates and reads fields', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'struct_mutation');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'struct_mutation.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), '42\nKirill\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native exit terminates with the requested exit code', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'exit');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'exit.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.equal(run.status, 7, `expected exit code 7, got ${run.status}`);
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native panic writes the message to stderr and exits nonzero', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'panic');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'panic.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'panic must exit with a nonzero code');
    assert.ok(run.stderr.includes('something went wrong'), `stderr missing panic message: ${run.stderr}`);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'before\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native clock_ms and sleep_ms behave within relaxed bounds', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'time');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'time.nova'), base);
    const run = spawnSync(exePath, [], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'true\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native env_has/env_get read the process environment', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'env');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'env.nova'), base);
    const run = spawnSync(exePath, [], {
      encoding: 'utf8',
      env: { ...process.env, NOVA_TEST_ENV_VALUE: 'hello-nova-env' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'hello-nova-env\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test('native args exposes process arguments including Unicode', { skip: !toolchain.available }, () => {
  const base = path.join(import.meta.dirname, 'dist', 'args');
  try {
    const exePath = buildVerifiedNative(path.join(import.meta.dirname, 'args.nova'), base);
    const run = spawnSync(exePath, ['hello', 'мир'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.replace(/\r\n/g, '\n'), '2\nhello\nмир\n');
  } finally {
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});
