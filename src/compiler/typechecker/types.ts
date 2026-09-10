import type { Span2 } from '../lexer/token.ts';

/**
 * NOVA semantic types.
 *
 * `unknown` is the inference poison value: it assigns to and from everything,
 * letting the compiler continue after an error without cascading noise.
 */

export type PrimName = 'Int' | 'Float' | 'String' | 'Bool' | 'Null';

export interface FnParam {
  name: string;
  type: NovaType;
  span?: Span2;
}

export type NovaType =
  | { kind: 'prim'; name: PrimName }
  | { kind: 'struct'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'array'; element: NovaType }
  | { kind: 'map'; key: NovaType; value: NovaType }
  | { kind: 'optional'; inner: NovaType }
  | { kind: 'result'; ok: NovaType; err: NovaType }
  | { kind: 'fn'; params: FnParam[]; ret: NovaType }
  | { kind: 'void' }
  | { kind: 'nominal'; name: string; inner: NovaType }
  | { kind: 'generic'; name: string; args: NovaType[] }
  | { kind: 'var'; id: number }
  | { kind: 'unknown' };

const PRIMS: Record<PrimName, NovaType> = {
  Int: { kind: 'prim', name: 'Int' },
  Float: { kind: 'prim', name: 'Float' },
  String: { kind: 'prim', name: 'String' },
  Bool: { kind: 'prim', name: 'Bool' },
  Null: { kind: 'prim', name: 'Null' },
};

export const T_INT = PRIMS.Int;
export const T_FLOAT = PRIMS.Float;
export const T_STRING = PRIMS.String;
export const T_BOOL = PRIMS.Bool;
export const T_NULL = PRIMS.Null;
export const T_VOID: NovaType = { kind: 'void' };
export const T_UNKNOWN: NovaType = { kind: 'unknown' };

export function isNumeric(t: NovaType): boolean {
  return t.kind === 'prim' && (t.name === 'Int' || t.name === 'Float');
}

/** Nominal/structural assignability: can a value of `from` be used as `to`? */
export function isAssignable(from: NovaType, to: NovaType): boolean {
  if (from.kind === 'unknown' || to.kind === 'unknown') return true;
  // Type variables: assignable to themselves or to unknown
  if (from.kind === 'var' && to.kind === 'var' && from.id === to.id) return true;
  if (from.kind === 'var' || to.kind === 'var') return true;  // Type vars are flexible
  if (from.kind === 'prim' && from.name === 'Null' && to.kind === 'optional') return true;
  if (to.kind === 'optional') return isAssignable(from, to.inner) || (from.kind === 'prim' && from.name === 'Null');
  if (from.kind === 'optional') return to.kind === 'optional' && isAssignable(from.inner, to.inner);
  // Nominal types: allow inner -> nominal (explicit annotation), but not nominal -> inner or different nominals
  if (to.kind === 'nominal') {
    // Can assign inner type to nominal (e.g., `uid: UserId = 42`)
    if (isAssignable(from, to.inner)) return true;
    // Can assign same nominal to itself
    if (from.kind === 'nominal' && from.name === to.name) return true;
    return false;
  }
  if (from.kind === 'nominal') {
    // Cannot implicitly convert nominal to its inner type or other types
    return false;
  }
  if (from.kind !== to.kind) {
    // numeric widening Int -> Float
    if (from.kind === 'prim' && from.name === 'Int' && to.kind === 'prim' && to.name === 'Float') return true;
    return false;
  }
  switch (from.kind) {
    case 'prim':
      if (from.name === (to as typeof from).name) return true;
      // Same-kind prim — allow Int->Float widening even when kind matches.
      if (from.name === 'Int' && (to as typeof from).name === 'Float') return true;
      return false;
    case 'struct':
    case 'enum':
      return from.name === (to as typeof from).name;
    case 'generic':
      return from.name === (to as typeof from).name &&
        from.args.length === (to as typeof from).args.length &&
        from.args.every((a, i) => isAssignable(a, (to as typeof from).args[i]!));
    case 'array':
      return isAssignable(from.element, (to as typeof from).element);
    case 'map':
      return isAssignable(from.key, (to as typeof from).key) &&
        isAssignable(from.value, (to as typeof from).value);
    case 'result':
      return isAssignable(from.ok, (to as typeof from).ok) &&
        isAssignable(from.err, (to as typeof from).err);
    case 'fn': {
      const t = to as typeof from;
      if (from.params.length !== t.params.length) return false;
      return from.params.every((p, i) => isAssignable(p.type, t.params[i]!.type)) &&
        isAssignable(from.ret, t.ret);
    }
    case 'void':
      return true;
  }
}

/** Human-readable type name for diagnostics. */
export function typeToString(t: NovaType): string {
  switch (t.kind) {
    case 'prim': return t.name;
    case 'struct': return t.name;
    case 'enum': return t.name;
    case 'nominal': return t.name;
    case 'generic': return t.args.length > 0 ? `${t.name}<${t.args.map(typeToString).join(', ')}>` : t.name;
    case 'var': return `T${t.id}`;
    case 'array': return `Array<${typeToString(t.element)}>`;
    case 'map': return `Map<${typeToString(t.key)}, ${typeToString(t.value)}>`;
    case 'optional': return `${typeToString(t.inner)}?`;
    case 'result': return `Result<${typeToString(t.ok)}, ${typeToString(t.err)}>`;
    case 'fn': return `fn(${t.params.map((p) => `${p.name}: ${typeToString(p.type)}`).join(', ')}) -> ${typeToString(t.ret)}`;
    case 'void': return 'Void';
    case 'unknown': return '<unknown>';
  }
}

/** JSON representation for AI-native tooling. */
export function typeToJson(t: NovaType): unknown {
  switch (t.kind) {
    case 'prim': return t.name;
    case 'struct': return t.name;
    case 'enum': return t.name;
    case 'nominal': return { nominal: t.name, inner: typeToJson(t.inner) };
    case 'generic': return { generic: t.name, args: t.args.map(typeToJson) };
    case 'var': return { var: t.id };
    case 'array': return { array: typeToJson(t.element) };
    case 'map': return { map: [typeToJson(t.key), typeToJson(t.value)] };
    case 'optional': return { optional: typeToJson(t.inner) };
    case 'result': return { result: [typeToJson(t.ok), typeToJson(t.err)] };
    case 'fn': return { fn: { params: t.params.map((p) => ({ name: p.name, type: typeToJson(p.type) })), ret: typeToJson(t.ret) } };
    case 'void': return 'Void';
    case 'unknown': return null;
  }
}
