/**
 * NOVA Native Layout Computation.
 *
 * Computes complete memory layouts for NOVA types: field offsets, padding,
 * total size and alignment. Wraps AbiMapper and provides the LayoutEngine
 * used by the future LLVM backend for struct/aggregate codegen.
 *
 * See docs/NATIVE_ABI.md for full documentation.
 */

import type { HirType } from '../hir/hir.ts';
import { AbiMapper, abiTypeSizeAndAlign, hirTypeString } from './abi.ts';
import type { FieldOffset, TypeLayout } from './abi.ts';

export type { FieldOffset, TypeLayout } from './abi.ts';

/**
 * Layout computation engine.
 * Uses AbiMapper for type representation and provides
 * pretty-printing of computed layouts.
 */
export class LayoutEngine {
  private readonly mapper: AbiMapper;

  constructor(mapper: AbiMapper) {
    this.mapper = mapper;
  }

  /** Compute the complete layout for a type. */
  computeLayout(type: HirType): TypeLayout {
    return this.mapper.computeLayout(type);
  }

  /** Compute the complete layout for a named struct. */
  computeStructLayout(name: string, fieldNames: string[]): TypeLayout {
    return this.mapper.computeStructLayout(name, fieldNames);
  }

  /** Get the byte offset of a struct field, or undefined. */
  fieldOffset(type: HirType, fieldName: string): number | undefined {
    if (type.kind !== 'struct') return undefined;
    const layout = this.computeLayout(type);
    return layout.fieldOffsets?.get(fieldName);
  }

  /**
   * Pretty-print the layout of a type.
   * Deterministic output — used in golden tests.
   */
  formatLayout(type: HirType): string {
    const layout = this.computeLayout(type);
    const lines: string[] = [];
    lines.push(`${hirTypeString(type)}:`);
    lines.push(`  size: ${layout.size}`);
    lines.push(`  align: ${layout.align}`);
    lines.push(`  ownership: ${layout.abiRepr.ownership}`);
    lines.push(`  paramCC: ${layout.abiRepr.paramCC}`);
    if (layout.fields && layout.fields.length > 0) {
      lines.push('  fields:');
      for (const f of layout.fields) {
        lines.push(`    ${f.name}: offset ${f.offset}`);
      }
    }
    return lines.join('\n');
  }
}

/** Re-export size/align helper for convenience. */
export { abiTypeSizeAndAlign };
