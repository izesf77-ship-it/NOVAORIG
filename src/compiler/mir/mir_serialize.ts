/**
 * MIR serialization for debugging, golden testing and backend hand-off.
 *
 * `mirToJson` produces a stable, deterministic JSON representation of a
 * MirModule. Spans are stripped (they are volatile across edits and would
 * break stable golden comparisons). All types are rendered with
 * `mirTypeString`. Declaration/instruction order is preserved exactly as
 * produced by the (deterministic) lowering pass, so two compilations of the
 * same source always produce byte-identical JSON.
 *
 * See docs/MIR_FORMAT.md for the full JSON schema description.
 *
 * `mirToString` is the human-readable form used by `nova dump-mir` (no
 * `--json`): one block per label, explicit terminators, LLVM-flavoured
 * expressions.
 */
import type {
  MirModule, MirDecl, MirFunction, MirClosureDecl, MirBlock, MirInstr, MirTerm, MirValue,
} from './mir.ts';
import { mirTypeString } from './mir.ts';

// ----------------------------------------------------------------------------
// JSON
// ----------------------------------------------------------------------------

export function mirToJson(module: MirModule): unknown {
  return {
    name: module.name,
    imports: module.imports,
    decls: module.decls.map(declToJson),
  };
}

function declToJson(d: MirDecl): unknown {
  switch (d.kind) {
    case 'fn':
      return {
        kind: 'fn',
        name: d.name,
        typeParams: d.typeParams,
        params: d.params.map((p) => ({ name: p.name, type: mirTypeString(p.type) })),
        ret: mirTypeString(d.ret),
        blocks: d.blocks.map(blockToJson),
      };
    case 'struct':
      return {
        kind: 'struct',
        name: d.name,
        typeParams: d.typeParams,
        fields: d.fields.map((f) => ({ name: f.name, type: mirTypeString(f.type) })),
      };
    case 'enum':
      return {
        kind: 'enum',
        name: d.name,
        typeParams: d.typeParams,
        variants: d.variants.map((v) => ({ name: v.name, data: v.data ? mirTypeString(v.data) : undefined })),
      };
    case 'const':
      return { kind: 'const', name: d.name, type: mirTypeString(d.type), value: valueToJson(d.value) };
    case 'closure_fn':
      return {
        kind: 'closure_fn',
        name: d.name,
        params: d.params.map((p) => ({ name: p.name, type: mirTypeString(p.type) })),
        ret: mirTypeString(d.ret),
        captured: d.captured,
        blocks: d.blocks.map(blockToJson),
      };
  }
}

function blockToJson(b: MirBlock): unknown {
  return {
    label: b.label,
    params: b.params.map((p) => ({ name: p.name, type: mirTypeString(p.type) })),
    instrs: b.instrs.map(instrToJson),
    term: termToJson(b.term),
  };
}

function instrToJson(i: MirInstr): unknown {
  switch (i.kind) {
    case 'assign':
      return { kind: 'assign', name: i.name, type: mirTypeString(i.type), value: valueToJson(i.value) };
    case 'store_field':
      return { kind: 'store_field', obj: valueToJson(i.obj), name: i.name, value: valueToJson(i.value) };
    case 'store_index':
      return {
        kind: 'store_index',
        obj: valueToJson(i.obj),
        index: valueToJson(i.index),
        value: valueToJson(i.value),
      };
  }
}

function termToJson(t: MirTerm): unknown {
  switch (t.kind) {
    case 'jump': return { kind: 'jump', target: t.target };
    case 'branch': return { kind: 'branch', cond: valueToJson(t.cond), thenLabel: t.thenLabel, elseLabel: t.elseLabel };
    case 'return': return t.value !== undefined ? { kind: 'return', value: valueToJson(t.value) } : { kind: 'return' };
    case 'unreachable': return { kind: 'unreachable' };
  }
}

function valueToJson(v: MirValue): unknown {
  switch (v.kind) {
    case 'lit': return { kind: 'lit', value: v.value, type: mirTypeString(v.type) };
    case 'ref': return { kind: 'ref', name: v.name, type: mirTypeString(v.type) };
    case 'bin': return { kind: 'bin', op: v.op, left: valueToJson(v.left), right: valueToJson(v.right), type: mirTypeString(v.type) };
    case 'unary': return { kind: 'unary', op: v.op, expr: valueToJson(v.expr), type: mirTypeString(v.type) };
    case 'call': return { kind: 'call', callee: valueToJson(v.callee), args: v.args.map(valueToJson), type: mirTypeString(v.type) };
    case 'field': return { kind: 'field', obj: valueToJson(v.obj), name: v.name, type: mirTypeString(v.type) };
    case 'index': return { kind: 'index', obj: valueToJson(v.obj), index: valueToJson(v.index), type: mirTypeString(v.type) };
    case 'struct_lit': return { kind: 'struct_lit', structName: v.structName, fields: v.fields.map((f) => ({ name: f.name, value: valueToJson(f.value) })), type: mirTypeString(v.type) };
    case 'array_lit': return { kind: 'array_lit', elements: v.elements.map(valueToJson), type: mirTypeString(v.type) };
    case 'map_lit': return { kind: 'map_lit', entries: v.entries.map((e) => ({ key: valueToJson(e.key), value: valueToJson(e.value) })), type: mirTypeString(v.type) };
    case 'enum_lit': return v.data !== undefined
      ? { kind: 'enum_lit', enumName: v.enumName, variant: v.variant, data: valueToJson(v.data), type: mirTypeString(v.type) }
      : { kind: 'enum_lit', enumName: v.enumName, variant: v.variant, type: mirTypeString(v.type) };
    case 'closure_ref': return { kind: 'closure_ref', fnName: v.fnName, captures: v.captures.map(valueToJson), type: mirTypeString(v.type) };
    case 'intrinsic': return { kind: 'intrinsic', op: v.op, arg: valueToJson(v.arg), type: mirTypeString(v.type) };
  }
}

// ----------------------------------------------------------------------------
// Text (LLVM-flavoured pretty printer)
// ----------------------------------------------------------------------------

export function mirToString(module: MirModule): string {
  const out: string[] = [];
  out.push(`; MIR module '${module.name}'`);
  if (module.imports.length > 0) out.push(`; imports: ${module.imports.join(', ')}`);
  for (const d of module.decls) out.push(declToString(d));
  return out.join('\n');
}

function declToString(d: MirDecl): string {
  switch (d.kind) {
    case 'fn': {
      const head = `fn ${d.name}(${d.params.map(paramToString).join(', ')}) -> ${mirTypeString(d.ret)} {`;
      return `${head}\n${blocksToString(d.blocks)}\n}`;
    }
    case 'struct':
      return `struct ${d.name} { ${d.fields.map((f) => `${f.name}: ${mirTypeString(f.type)}`).join(', ')} }`;
    case 'enum':
      return `enum ${d.name} { ${d.variants.map((v) => v.data ? `${v.name}(${mirTypeString(v.data)})` : v.name).join(', ')} }`;
    case 'const':
      return `const ${d.name}: ${mirTypeString(d.type)} = ${valueToString(d.value)}`;
    case 'closure_fn': {
      const captures = d.captured.length > 0 ? ` [captures: ${d.captured.join(', ')}]` : '';
      const head = `closure_fn ${d.name}${captures}(${d.params.map(paramToString).join(', ')}) -> ${mirTypeString(d.ret)} {`;
      return `${head}\n${blocksToString(d.blocks)}\n}`;
    }
  }
}

function paramToString(p: { name: string; type: import('../hir/hir.ts').HirType }): string {
  return `${p.name}: ${mirTypeString(p.type)}`;
}

function blocksToString(blocks: MirBlock[]): string {
  return blocks.map((b) => blockToString(b)).join('\n\n');
}

function blockToString(b: MirBlock): string {
  const lines: string[] = [];
  const params = b.params.length > 0 ? `(${b.params.map(paramToString).join(', ')})` : '';
  lines.push(`${b.label}${params}:`);
  for (const instr of b.instrs) lines.push(`    ${instrToString(instr)}`);
  lines.push(`    ${termToString(b.term)}`);
  return lines.join('\n');
}

function instrToString(i: MirInstr): string {
  switch (i.kind) {
    case 'assign': return `${i.name}: ${mirTypeString(i.type)} = ${valueToString(i.value)}`;
    case 'store_field': return `${valueToString(i.obj)}.${i.name} = ${valueToString(i.value)}`;
    case 'store_index': return `${valueToString(i.obj)}[${valueToString(i.index)}] = ${valueToString(i.value)}`;
  }
}

function termToString(t: MirTerm): string {
  switch (t.kind) {
    case 'jump': return `jump ${t.target}`;
    case 'branch': return `branch ${valueToString(t.cond)}, ${t.thenLabel}, ${t.elseLabel}`;
    case 'return': return t.value !== undefined ? `return ${valueToString(t.value)}` : 'return';
    case 'unreachable': return 'unreachable';
  }
}

function valueToString(v: MirValue): string {
  switch (v.kind) {
    case 'lit':
      if (typeof v.value === 'string') return JSON.stringify(v.value);
      if (v.value === null) return 'null';
      return String(v.value);
    case 'ref': return v.name;
    case 'bin': return `(${valueToString(v.left)} ${v.op} ${valueToString(v.right)})`;
    case 'unary': return `(${v.op}${valueToString(v.expr)})`;
    case 'call': return `${valueToString(v.callee)}(${v.args.map(valueToString).join(', ')})`;
    case 'field': return `${valueToString(v.obj)}.${v.name}`;
    case 'index': return `${valueToString(v.obj)}[${valueToString(v.index)}]`;
    case 'struct_lit': return `${v.structName} { ${v.fields.map((f) => `${f.name}: ${valueToString(f.value)}`).join(', ')} }`;
    case 'array_lit': return `[${v.elements.map(valueToString).join(', ')}]`;
    case 'map_lit': return `{ ${v.entries.map((e) => `${valueToString(e.key)}: ${valueToString(e.value)}`).join(', ')} }`;
    case 'enum_lit': return v.data !== undefined ? `${v.enumName}.${v.variant}(${valueToString(v.data)})` : `${v.enumName}.${v.variant}`;
    case 'closure_ref': return `closure ${v.fnName}(${v.captures.map(valueToString).join(', ')})`;
    case 'intrinsic': return `@${v.op}(${valueToString(v.arg)})`;
  }
}

