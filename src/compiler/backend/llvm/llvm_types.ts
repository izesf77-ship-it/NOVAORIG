/**
 * NOVA → LLVM type lowering.
 *
 * Maps MIR/HIR types to LLVM IR types. This is the M5 layer on top of the M4
 * ABI: the canonical mapping is `NOVA type → AbiType (M4) → LLVM type`.
 *
 * Examples:
 *   Int    → i64
 *   Float  → double
 *   Bool   → i8        (ABI: bool is stored as i8)
 *   String → { i8*, i64 }  (ABI: fat pointer ptr+len)
 *   Array  → { i8*, i64 }  (ABI: fat pointer over the heap header)
 *   Enum   → i64       (ABI: discriminant)
 *   Option<T> → { T, i8 } for value payloads, { i8*, i64 } for pointers
 *   Result<T,E> → { payload, i64 } (payload union of ok/err)
 *   fn     → i8*       (opaque function pointer)
 */

import type { HirType } from '../../hir/hir.ts';

/** An LLVM type, described as an IR type-string. */
export type LlvmType = string;

/**
 * Resolve a HIR type to an LLVM type-string.
 *
 * @param structType  resolver for named structs (name → LLVM type string);
 *                    used so recursive field types can be resolved lazily.
 */
export function hirToLlvmType(t: HirType, structType: (name: string) => string | null): LlvmType {
  switch (t.kind) {
    case 'prim':
      switch (t.name) {
        case 'Int': return 'i64';
        case 'Float': return 'double';
        case 'Bool': return 'i8';
        case 'String': return '{ i8*, i64 }';
        case 'Null': return 'i8';
      }
      break;
    case 'void': return 'void';
    case 'array': return '{ i8*, i64 }';
    case 'map': return '{ i8*, i64 }';
    case 'enum': return 'i64';
    case 'fn': return 'i8*';
    case 'struct': {
      const inner = structType(t.name);
      if (inner !== null) return inner;
      return 'i8*'; // unresolved — must be a named struct we did not see
    }
    case 'optional': {
      const inner = hirToLlvmType(t.inner, structType);
      if (isPtrLike(t.inner)) return '{ i8*, i64 }';
      return `{ ${inner}, i8 }`;
    }
    case 'result': {
      const ok = hirToLlvmType(t.ok, structType);
      const err = hirToLlvmType(t.err, structType);
      const payload = ok === err ? ok : 'i64';
      return `{ ${payload}, i64 }`;
    }
    case 'nominal': return hirToLlvmType(t.inner, structType);
    case 'var': return 'i8*';
  }
  return 'i8*';
}

/** Whether a type is represented as a pointer/fat-pointer (nullable-ptr Option). */
export function isPtrLike(t: HirType): boolean {
  switch (t.kind) {
    case 'prim': return t.name === 'String' || t.name === 'Null';
    case 'array': case 'map': case 'fn': case 'var':
      return true;
    case 'optional':
      return isPtrLike(t.inner);
    case 'nominal':
      return isPtrLike(t.inner);
    case 'struct': case 'enum': case 'result':
      return false;
    default:
      return false;
  }
}

/** LLVM function type with named params: `ret (i64, i64)` */
export function fnLLVMType(params: LlvmType[], ret: LlvmType): string {
  return `${ret} (${params.join(', ')})`;
}

/** Escape a string literal as an LLVM .ll byte string. */
export function llvmEscapeString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) {
    if (b === 34 /* " */) out += '\\22';       // "
    else if (b === 92 /* \ */) out += '\\5C';  // backslash
    else if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    else out += `\\${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Render a JS number as an LLVM floating-point literal. */
export function llvmDoubleLiteral(x: number): string {
  if (Number.isNaN(x)) return '0x7FF8000000000000';
  if (x === Number.POSITIVE_INFINITY) return '0x7FF0000000000000';
  if (x === Number.NEGATIVE_INFINITY) return '0xFFF0000000000000';
  let s = String(x);
  // LLVM requires a floating literal to contain '.', 'e' or 'E'.
  if (!s.includes('.') && !s.includes('e') && !s.includes('E')) s += '.0';
  return s;
}

/** Sanitize an MIR identifier into a safe LLVM identifier fragment. */
export function llvmIdent(name: string): string {
  // Keep [A-Za-z0-9_$] and '.', replace everyother byte with _XX (hex).
  let out = '';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || ch === '_' || ch === '$' || ch === '.';
    if (ok) out += ch;
    else out += `_${c.toString(16)}`;
  }
  return out;
}