/**
 * Tests for target ABI type representations.
 *
 * These tests verify that NOVA types have the correct native ABI layout
 * (size, alignment, ownership, paramCC) for the Windows x64 target.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { HirType } from '../src/compiler/hir/hir.ts';
import { WINDOWS_X64 } from '../src/compiler/target/target.ts';
import { AbiMapper, alignUp, abiTypeSizeAndAlign } from '../src/compiler/target/abi.ts';
import { LayoutEngine } from '../src/compiler/target/layout.ts';

/** Helper to build HirType primitives */
const T = {
  int: (): HirType => ({ kind: 'prim', name: 'Int' }),
  float: (): HirType => ({ kind: 'prim', name: 'Float' }),
  bool: (): HirType => ({ kind: 'prim', name: 'Bool' }),
  string: (): HirType => ({ kind: 'prim', name: 'String' }),
  void: (): HirType => ({ kind: 'void' }),
  struct: (name: string): HirType => ({ kind: 'struct', name }),
  enum: (name: string): HirType => ({ kind: 'enum', name }),
  array: (el: HirType): HirType => ({ kind: 'array', element: el }),
  map: (k: HirType, v: HirType): HirType => ({ kind: 'map', key: k, value: v }),
  optional: (inner: HirType): HirType => ({ kind: 'optional', inner }),
  result: (ok: HirType, err: HirType): HirType => ({ kind: 'result', ok, err }),
  fn: (): HirType => ({ kind: 'fn', params: [], ret: { kind: 'void' } }),
};

/** Create an AbiMapper with predefined struct/enum info */
function makeMapper(structs: Record<string, string[]> = {}, enums: Record<string, string[]> = {}) {
  return new AbiMapper(
    WINDOWS_X64,
    new Map(Object.entries(structs)),
    new Map(Object.entries(enums)),
    new Map(),
  );
}

describe('M4 ABI — Primitives', () => {
  test('Int maps to i64', () => {
    const r = makeMapper().map(T.int());
    assert.equal(r.type.kind, 'i64');
    assert.equal(r.size, 8);
    assert.equal(r.align, 8);
    assert.equal(r.ownership, 'value');
    assert.equal(r.paramCC, 'in_register');
  });

  test('Float maps to f64', () => {
    const r = makeMapper().map(T.float());
    assert.equal(r.type.kind, 'f64');
    assert.equal(r.size, 8);
    assert.equal(r.ownership, 'value');
    assert.equal(r.paramCC, 'in_register');
  });

  test('Bool maps to i8', () => {
    const r = makeMapper().map(T.bool());
    assert.equal(r.type.kind, 'i8');
    assert.equal(r.size, 1);
    assert.equal(r.align, 1);
  });

  test('String maps to i8_slice (fat pointer)', () => {
    const r = makeMapper().map(T.string());
    assert.equal(r.type.kind, 'i8_slice');
    assert.equal(r.size, 16);
    assert.equal(r.align, 8);
    assert.equal(r.ownership, 'boxed');
    assert.equal(r.paramCC, 'by_reference');
  });

    test('Void maps to void', () => {
    const r = makeMapper().map(T.void());
    assert.equal(r.type.kind, 'void');
    assert.equal(r.size, 0);
  });
});

describe('M4 ABI — Aggregates', () => {
  test('Unknown struct is opaque ptr', () => {
    const r = makeMapper().map(T.struct('Unknown'));
    assert.equal(r.type.kind, 'ptr');
    assert.equal(r.ownership, 'boxed');
  });

  test('Known struct with 2 fields has correct size', () => {
    const r = makeMapper({ Point: ['x', 'y'] }).map(T.struct('Point'));
    assert.equal(r.type.kind, 'struct');
    assert.equal(r.size, 16);
    assert.equal(r.align, 8);
    assert.equal(r.ownership, 'value');
  });

  test('Known enum has i64 discriminant', () => {
    const r = makeMapper({}, { Color: ['Red', 'Green', 'Blue'] }).map(T.enum('Color'));
    assert.equal(r.type.kind, 'i64');
    assert.equal(r.size, 8);
    assert.equal(r.align, 8);
  });

  test('Unknown enum is opaque ptr', () => {
    const r = makeMapper().map(T.enum('Unknown'));
    assert.equal(r.type.kind, 'ptr');
  });

  test('Array<Int> is boxed i8_slice', () => {
    const r = makeMapper().map(T.array(T.int()));
    assert.equal(r.type.kind, 'i8_slice');
    assert.equal(r.ownership, 'boxed');
    assert.equal(r.paramCC, 'by_reference');
  });

  test('Map<Int, Int> is boxed i8_slice', () => {
    const r = makeMapper().map(T.map(T.int(), T.int()));
    assert.equal(r.type.kind, 'i8_slice');
    assert.equal(r.ownership, 'boxed');
  });

  test('Function type is a ptr', () => {
    const r = makeMapper().map(T.fn());
    assert.equal(r.type.kind, 'ptr');
    assert.equal(r.size, 8);
    assert.equal(r.ownership, 'reference');
  });
});

describe('M4 ABI — Option/Result', () => {
  test('Option<Int> uses tagged struct', () => {
    const r = makeMapper().map(T.optional(T.int()));
    assert.equal(r.size, 16);
    assert.equal(r.align, 8);
    assert.equal(r.ownership, 'value');
  });

  test('Option<String> uses nullable pointer', () => {
    const r = makeMapper().map(T.optional(T.string()));
    assert.equal(r.type.kind, 'ptr');
    assert.equal(r.size, 8);
    assert.equal(r.paramCC, 'in_register');
  });

  test('Result<Int, String> has correct size', () => {
    const r = makeMapper().map(T.result(T.int(), T.string()));
    assert.equal(r.type.kind, 'struct');
    assert.equal(r.size, 24);
    assert.equal(r.align, 8);
  });

  test('Nominal<Int> unwraps to inner type', () => {
    const r = makeMapper().map({ kind: 'nominal', name: 'MyInt', inner: T.int() });
    assert.equal(r.type.kind, 'i64');
    assert.equal(r.ownership, 'value');
  });
});

describe('M4 ABI — Layout utilities', () => {
  test('alignUp works correctly', () => {
    assert.equal(alignUp(0, 8), 0);
    assert.equal(alignUp(1, 8), 8);
    assert.equal(alignUp(7, 8), 8);
    assert.equal(alignUp(8, 8), 8);
    assert.equal(alignUp(9, 8), 16);
    assert.equal(alignUp(15, 16), 16);
    assert.equal(alignUp(17, 16), 32);
  });

  test('abiTypeSizeAndAlign for primitives', () => {
    assert.deepEqual(abiTypeSizeAndAlign({ kind: 'i8' }), { size: 1, align: 1 });
    assert.deepEqual(abiTypeSizeAndAlign({ kind: 'i64' }), { size: 8, align: 8 });
    assert.deepEqual(abiTypeSizeAndAlign({ kind: 'i8_slice' }), { size: 16, align: 8 });
  });

  test('abiTypeSizeAndAlign for structs with padding', () => {
    const s2 = { kind: 'struct' as const, fields: [
      { name: 'a', type: { kind: 'i8' as const } },
      { name: 'b', type: { kind: 'i64' as const } },
    ]};
    assert.deepEqual(abiTypeSizeAndAlign(s2), { size: 16, align: 8 });
  });

  test('Windows x64 target has correct values', () => {
    assert.equal(WINDOWS_X64.triple, 'x86_64-pc-windows-msvc');
    assert.equal(WINDOWS_X64.architecture, 'x86_64');
    assert.equal(WINDOWS_X64.pointerWidth, 64);
    assert.equal(WINDOWS_X64.endianness, 'little');
    assert.equal(WINDOWS_X64.callingConvention, 'win64');
  });
});

describe('M4 ABI — LayoutEngine', () => {
  test('computeStructLayout returns field offsets', () => {
    const engine = new LayoutEngine(makeMapper());
    const layout = engine.computeStructLayout('Point', ['x', 'y']);
    assert.equal(layout.size, 16);
    assert.equal(layout.align, 8);
    assert.deepEqual(layout.fieldOffsets?.get('x'), 0);
    assert.deepEqual(layout.fieldOffsets?.get('y'), 8);
  });

  test('fieldOffset returns offset for known field', () => {
    const engine = new LayoutEngine(makeMapper({ Point: ['x', 'y'] }));
    const off = engine.fieldOffset(T.struct('Point'), 'y');
    assert.equal(off, 8);
  });

  test('fieldOffset returns undefined for unknown field or non-struct', () => {
    const engine = new LayoutEngine(makeMapper({ Point: ['x', 'y'] }));
    assert.equal(engine.fieldOffset(T.struct('Point'), 'z'), undefined);
    assert.equal(engine.fieldOffset(T.int(), 'x'), undefined);
  });

  test('formatLayout is deterministic', () => {
    const engine = new LayoutEngine(makeMapper());
    const a = engine.formatLayout(T.optional(T.int()));
    const b = engine.formatLayout(T.optional(T.int()));
    assert.equal(a, b);
    assert.ok(a.includes('size: 16'));
  });
});