import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const NOVA = path.join(ROOT, 'bin', 'nova.ts');
const NATIVE_DIR = path.join(__dirname, 'native');
const DIST_DIR = path.join(NATIVE_DIR, 'dist');

function compileNative(sourceFile, outputName) {
  const exePath = path.join(DIST_DIR, outputName + '.exe');
  if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
  execFileSync('node', [NOVA, 'build', sourceFile, '--native', '--release'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!fs.existsSync(exePath)) throw new Error('Native build failed');
  return exePath;
}

function runExe(exePath, args, input) {
  try {
    const stdout = execFileSync(exePath, args ?? [], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

function validatePE(exePath) {
  const bytes = fs.readFileSync(exePath);
  const mz = bytes[0] === 0x4D && bytes[1] === 0x5A;
  const peOffset = bytes.readUInt32LE(0x3C);
  const pe = bytes[peOffset] === 0x50 && bytes[peOffset + 1] === 0x45;
  const machine = bytes.readUInt16LE(peOffset + 4);
  return { mz, pe, amd64: machine === 0x8664 };
}

fs.mkdirSync(DIST_DIR, { recursive: true });

test('native hello.exe: String println', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'hello.nova'), 'hello');
  const pe = validatePE(exe);
  assert.ok(pe.mz, 'MZ header missing');
  assert.ok(pe.pe, 'PE header missing');
  assert.ok(pe.amd64, 'Not AMD64');
  const r = runExe(exe);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'Hello from NOVA!');
});

test('native float.exe: Float println', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'float.nova'), 'float');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '3.140000');
  assert.equal(lines[1], '-42.500000');
  assert.equal(lines[2], '0.000000');
});

test('native integer.exe: Int println', () => {
  const src = path.join(NATIVE_DIR, 'integer.nova');
  fs.writeFileSync(src, 'fn main() {\n    println(42)\n    println(-17)\n    println(0)\n}\n');
  const exe = compileNative(src, 'integer');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], '42');
  assert.equal(lines[1], '-17');
  assert.equal(lines[2], '0');
});

test('native bool.exe: Bool println', () => {
  const src = path.join(NATIVE_DIR, 'bool.nova');
  fs.writeFileSync(src, 'fn main() {\n    println(true)\n    println(false)\n}\n');
  const exe = compileNative(src, 'bool');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'true');
  assert.equal(lines[1], 'false');
});

test('native exit.exe: exit code', () => {
  const src = path.join(NATIVE_DIR, 'exit.nova');
  fs.writeFileSync(src, 'fn main() {\n    exit(7)\n}\n');
  const exe = compileNative(src, 'exit');
  const r = runExe(exe);
  assert.equal(r.status, 7);
});

test('native panic.exe: panic with message', () => {
  const src = path.join(NATIVE_DIR, 'panic.nova');
  fs.writeFileSync(src, 'fn main() {\n    panic("something went wrong")\n}\n');
  const exe = compileNative(src, 'panic');
  const r = runExe(exe);
  assert.notEqual(r.status, 0);
});

test('native env.exe: env_has and env_get', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'env.nova'), 'env');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().length > 0, 'PATH should not be empty');
});

test('native time.exe: clock_ms and sleep_ms', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'time.nova'), 'time');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe);
  assert.equal(r.status, 0);
  const ms = parseInt(r.stdout.trim(), 10);
  assert.ok(ms >= 50 && ms <= 5000, 'sleep should be approximately 100ms');
});

test('native args.exe: args() returns array', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'args.nova'), 'args');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe, ['hello', 'world']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '2');
});

test('native input.exe: input() reads from stdin', () => {
  const exe = compileNative(path.join(NATIVE_DIR, 'input.nova'), 'input');
  const pe = validatePE(exe);
  assert.ok(pe.mz); assert.ok(pe.pe); assert.ok(pe.amd64);
  const r = runExe(exe, [], 'test input\n');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'test input');
});
