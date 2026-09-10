/**
 * NOVA Native ABI Types and Helpers.
 *
 * Defines the native representation types for NOVA types at the ABI boundary.
 * See docs/NATIVE_ABI.md for full documentation.
 */

import type { TargetSpec } from './target.ts';
import type { HirType } from '../hir/hir.ts';

/** Native ABI type. Each NOVA type maps to one AbiType. */
export type AbiType =
  | { kind: 'i8' }
  | { kind: 'i16' }
  | { kind: 'i32' }
  | { kind: 'i64' }
  | { kind: 'f32' }
  | { kind: 'f64' }
  | { kind: 'ptr' }
  | { kind: 'bool' }
  | { kind: 'void' }
  | { kind: 'i8_slice' }
  | { kind: 'struct'; fields: AbiField[] }
  | { kind: 'array'; element: AbiType; count: number };

export interface AbiField { name: string; type: AbiType; }
export type Ownership = 'value' | 'reference' | 'boxed' | 'rc' | 'copy';
export type ParamCC = 'in_register' | 'on_stack' | 'by_reference';

export interface AbiRepr {
  type: AbiType;
  size: number;
  align: number;
  ownership: Ownership;
  paramCC: ParamCC;
  fields?: AbiField[];
  discriminant?: number;
}

/**
 * Round up `value` to the nearest multiple of `alignment`.
 */
export function alignUp(value: number, alignment: number): number {
  if (alignment === 0) return value;
  const mask = alignment - 1;
  return (value + mask) & ~mask;
}

/** Get size and alignment for an AbiType. */
export function abiTypeSizeAndAlign(t: AbiType): { size: number; align: number } {
  switch (t.kind) {
    case 'i8':    return { size: 1, align: 1 };
    case 'i16':   return { size: 2, align: 2 };
    case 'i32':   return { size: 4, align: 4 };
    case 'i64':   return { size: 8, align: 8 };
    case 'f32':   return { size: 4, align: 4 };
    case 'f64':   return { size: 8, align: 8 };
    case 'ptr':   return { size: 8, align: 8 };
    case 'bool':  return { size: 1, align: 1 };
    case 'void':  return { size: 0, align: 1 };
    case 'i8_slice': return { size: 16, align: 8 };
    case 'struct': {
      let offset = 0, maxAlign = 1;
      for (const f of t.fields) {
        const { align, size } = abiTypeSizeAndAlign(f.type);
        offset = alignUp(offset, align);
        offset += size;
        maxAlign = Math.max(maxAlign, align);
      }
      return { size: alignUp(offset, maxAlign), align: maxAlign };
    }
    case 'array': {
      const elem = abiTypeSizeAndAlign(t.element);
      return { size: elem.size * t.count, align: elem.align };
    }
  }
}

/** Convert an AbiType to a human-readable string. */
export function abiTypeString(t: AbiType): string {
  switch (t.kind) {
    case 'i8':    return 'i8';
    case 'i16':   return 'i16';
    case 'i32':   return 'i32';
    case 'i64':   return 'i64';
    case 'f32':   return 'f32';
    case 'f64':   return 'f64';
    case 'ptr':   return 'ptr';
    case 'bool':  return 'i8';
    case 'void':  return 'void';
    case 'i8_slice': return '{ i8*, i64 }';
    case 'struct': return `{ ${t.fields.map((f) => `${abiTypeString(f.type)}`).join(', ')} }`;
    case 'array': return `[${t.count} x ${abiTypeString(t.element)}]`;
  }
}

/** Convert HirType to a human-readable string. */
export function hirTypeString(t: HirType): string {
  switch (t.kind) {
    case 'prim': return t.name;
    case 'struct': case 'enum': case 'nominal': return t.name;
    case 'array': return `Array<${hirTypeString(t.element)}>`;
    case 'map': return `Map<${hirTypeString(t.key)}, ${hirTypeString(t.value)}>`;
    case 'optional': return `${hirTypeString(t.inner)}?`;
    case 'result': return `Result<${hirTypeString(t.ok)}, ${hirTypeString(t.err)}>`;
    case 'fn': return `fn(${t.params.map((p) => hirTypeString(p.type)).join(', ')}) -> ${hirTypeString(t.ret)}`;
    case 'void': return 'Void';
    case 'var': return `T${t.id}`;
  }
}

/** A field with its computed offset in memory. */
export interface FieldOffset { name: string; type: AbiType; offset: number; }

/** Complete layout information for a type. */
export interface TypeLayout {
  size: number;
  align: number;
  abiRepr: AbiRepr;
  fields?: FieldOffset[];
  fieldOffsets?: Map<string, number>;
}

/**
 * Compute the ABI representation for a HirType.
 */
export class AbiMapper {
  readonly target: TargetSpec;
  readonly structFields: Map<string, string[]>;
  readonly enumVariants: Map<string, string[]>;
  readonly nominals: Map<string, HirType>;

  constructor(
    target: TargetSpec,
    structFields: Map<string, string[]>,
    enumVariants: Map<string, string[]>,
    nominals: Map<string, HirType>,
  ) {
    this.target = target;
    this.structFields = structFields;
    this.enumVariants = enumVariants;
    this.nominals = nominals;
  }

  /** Map a HIR type to its ABI representation. */
  map(type: HirType): AbiRepr {
    switch (type.kind) {
      case 'prim': {
        switch (type.name) {
          case 'Int':    return { type: { kind: 'i64' }, size: 8, align: 8, ownership: 'value', paramCC: 'in_register' };
          case 'Float':  return { type: { kind: 'f64' }, size: 8, align: 8, ownership: 'value', paramCC: 'in_register' };
          case 'Bool':   return { type: { kind: 'i8' }, size: 1, align: 1, ownership: 'value', paramCC: 'in_register' };
          case 'String': return { type: { kind: 'i8_slice' }, size: 16, align: 8, ownership: 'boxed', paramCC: 'by_reference' };
          case 'Null':   return { type: { kind: 'i8' }, size: 0, align: 1, ownership: 'value', paramCC: 'in_register' };
        }
        break;
      }
      case 'void': return { type: { kind: 'void' }, size: 0, align: 1, ownership: 'value', paramCC: 'in_register' };
      case 'struct': {
        const fields = this.structFields.get(type.name);
        if (!fields) return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'boxed', paramCC: 'by_reference' };
        const abiFields: AbiField[] = fields.map((fn) => ({ name: fn, type: { kind: 'ptr' } }));
        const { size, align } = this.structSizeAndAlign(abiFields);
        return { type: { kind: 'struct', fields: abiFields }, size, align, ownership: 'value', paramCC: 'by_reference', fields: abiFields };
      }
      case 'enum': return this.computeEnumLayout(type);
      case 'array': return { type: { kind: 'i8_slice' }, size: 16, align: 8, ownership: 'boxed', paramCC: 'by_reference' };
      case 'map': return { type: { kind: 'i8_slice' }, size: 16, align: 8, ownership: 'boxed', paramCC: 'by_reference' };
      case 'optional': return this.computeOptionLayout(type);
      case 'result': return this.computeResultLayout(type);
      case 'fn': return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'reference', paramCC: 'in_register' };
      case 'nominal': return this.map(type.inner);
      case 'var': return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'reference', paramCC: 'in_register' };
    }
    return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'reference', paramCC: 'in_register' };
  }

  private structSizeAndAlign(fields: AbiField[]): { size: number; align: number } {
    let offset = 0, maxAlign = 1;
    for (const f of fields) {
      const { align, size } = abiTypeSizeAndAlign(f.type);
      offset = alignUp(offset, align);
      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }
        return { size: alignUp(offset, maxAlign), align: maxAlign };
  }

  private computeOptionLayout(type: { kind: 'optional'; inner: HirType }): AbiRepr {
    const payload = this.map(type.inner);
    if (payload.type.kind === 'ptr' || payload.type.kind === 'i8_slice')
      return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'value', paramCC: 'in_register' };
    if (payload.type.kind === 'i64' || payload.type.kind === 'f64')
      return {
        type: { kind: 'struct', fields: [{ name: 'payload', type: payload.type }, { name: 'discriminant', type: { kind: 'i8' } }] },
        size: alignUp(payload.size + 1, 8), align: 8, ownership: 'value', paramCC: 'by_reference',
      };
    const size = payload.size + 1;
    const align = Math.max(payload.align, 8);
    return {
      type: { kind: 'struct', fields: [{ name: 'payload', type: payload.type }, { name: 'discriminant', type: { kind: 'i8' } }] },
      size: alignUp(size, align), align, ownership: 'value', paramCC: 'by_reference',
    };
  }

  private computeResultLayout(type: { kind: 'result'; ok: HirType; err: HirType }): AbiRepr {
    const okR = this.map(type.ok), errR = this.map(type.err);
    const ps = Math.max(okR.size, errR.size), pa = Math.max(okR.align, errR.align);
    const align = Math.max(pa, 8);
    const doff = alignUp(ps, 8);
    return {
      type: { kind: 'struct', fields: [{ name: 'payload', type: { kind: 'i64' } }, { name: 'discriminant', type: { kind: 'i64' } }] },
      size: alignUp(doff + 8, align), align, ownership: 'value', paramCC: 'by_reference',
    };
  }

  private computeEnumLayout(type: { kind: 'enum'; name: string }): AbiRepr {
    const v = this.enumVariants.get(type.name);
    if (!v) return { type: { kind: 'ptr' }, size: 8, align: 8, ownership: 'boxed', paramCC: 'by_reference' };
    return { type: { kind: 'i64' }, size: 8, align: 8, ownership: 'value', paramCC: 'in_register' };
  }

  computeStructLayout(name: string, fieldNames: string[]): TypeLayout {
    const abiFields: AbiField[] = fieldNames.map((fn) => ({ name: fn, type: { kind: 'ptr' } }));
    const { size: s, align } = this.structSizeAndAlign(abiFields);
    let offset = 0;
    const fields: FieldOffset[] = [];
    for (const f of abiFields) {
      const { align: fa, size: fs } = abiTypeSizeAndAlign(f.type);
      offset = alignUp(offset, fa);
      fields.push({ name: f.name, type: f.type, offset });
      offset += fs;
    }
    const fieldOffsets = new Map<string, number>();
    for (const f of fields) fieldOffsets.set(f.name, f.offset);
    return {
      size: alignUp(offset, align), align,
      abiRepr: { type: { kind: 'struct', fields: abiFields }, size: alignUp(offset, align), align, ownership: 'value', paramCC: 'by_reference', fields: abiFields },
      fields, fieldOffsets,
    };
  }

  computeLayout(type: HirType): TypeLayout {
    const abiRepr = this.map(type);
    if (type.kind === 'struct') {
      const fn = this.structFields.get(type.name);
      if (fn) return this.computeStructLayout(type.name, fn);
    }
    return { size: abiRepr.size, align: abiRepr.align, abiRepr };
  }
}