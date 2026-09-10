/**
 * HIR serialization for debugging and golden testing.
 *
 * `hirToJson` produces a stable, human-readable JSON representation of a
 * HirModule with span information stripped (spans are volatile across edits
 * and would break stable golden comparisons). `hirToString` is the
 * pretty-printed form used by `nova dump-hir`.
 */
import type {
  HirModule, HirDecl, HirExpr, HirStmt, HirType,
  HirPattern, HirMatchArm,
} from './hir.ts';
import { hirTypeToString } from './hir.ts';

export function hirToJson(mod: HirModule): unknown {
  return {
    name: mod.name,
    imports: mod.imports,
    decls: mod.decls.map(declToJson),
  };
}

function typeToJson(t: HirType): unknown {
  switch (t.kind) {
    case 'prim': return { kind: 'prim', name: t.name };
    case 'struct': return { kind: 'struct', name: t.name };
    case 'enum': return { kind: 'enum', name: t.name };
    case 'nominal': return { kind: 'nominal', name: t.name, inner: typeToJson(t.inner) };
    case 'array': return { kind: 'array', element: typeToJson(t.element) };
    case 'map': return { kind: 'map', key: typeToJson(t.key), value: typeToJson(t.value) };
    case 'optional': return { kind: 'optional', inner: typeToJson(t.inner) };
    case 'result': return { kind: 'result', ok: typeToJson(t.ok), err: typeToJson(t.err) };
    case 'fn': return { kind: 'fn', params: t.params.map(p => ({ name: p.name, type: typeToJson(p.type) })), ret: typeToJson(t.ret) };
    case 'void': return { kind: 'void' };
    case 'var': return { kind: 'var', id: t.id };
  }
}

function blockToJson(b: { stmts: HirStmt[]; tail?: HirExpr }): unknown {
  return {
    stmts: b.stmts.map(s => stmtToJson(s)),
    tail: b.tail ? exprToJson(b.tail) : undefined,
  };
}

function declToJson(d: HirDecl): unknown {
  switch (d.kind) {
    case 'fn':
      return {
        kind: 'fn',
        name: d.name,
        typeParams: d.typeParams,
        params: d.params.map(p => ({ name: p.name, type: typeToJson(p.type) })),
        ret: typeToJson(d.ret),
        exported: d.exported,
        body: blockToJson(d.body),
      };
    case 'struct':
      return { kind: 'struct', name: d.name, typeParams: d.typeParams, fields: d.fields.map(f => ({ name: f.name, type: typeToJson(f.type) })), exported: d.exported };
    case 'enum':
      return { kind: 'enum', name: d.name, typeParams: d.typeParams, variants: d.variants.map(v => ({ name: v.name, data: v.data ? typeToJson(v.data) : undefined })), exported: d.exported };
    case 'const':
      return { kind: 'const', name: d.name, type: d.type ? typeToJson(d.type) : undefined, value: exprToJson(d.value), exported: d.exported };
    case 'nominal':
      return { kind: 'nominal', name: d.name, inner: typeToJson(d.inner) };
  }
}

function stmtToJson(s: HirStmt): unknown {
  switch (s.kind) {
    case 'expr': return { kind: 'expr', expr: exprToJson(s.expr) };
    case 'let': return { kind: 'let', name: s.name, type: s.type ? typeToJson(s.type) : undefined, value: exprToJson(s.value), isConst: s.isConst };
    case 'assign': return { kind: 'assign', target: exprToJson(s.target), value: exprToJson(s.value) };
    case 'field_assign': return { kind: 'field_assign', name: s.name, value: exprToJson(s.value) };
    case 'index_assign': return { kind: 'index_assign', index: exprToJson(s.index), value: exprToJson(s.value) };
    case 'block': return { kind: 'block', stmts: s.stmts.map(stmtToJson), tail: s.tail ? exprToJson(s.tail) : undefined, type: typeToJson(s.type) };
    case 'if': return { kind: 'if', cond: exprToJson(s.cond), then: blockToJson(s.then), else: s.else ? blockToJson(s.else) : undefined };
    case 'while': return { kind: 'while', cond: exprToJson(s.cond), body: blockToJson(s.body) };
    case 'for': return { kind: 'for', name: s.name, iter: exprToJson(s.iter), body: blockToJson(s.body) };
    case 'return': return { kind: 'return', value: s.value ? exprToJson(s.value) : undefined };
    case 'match': return { kind: 'match', subject: exprToJson(s.subject), arms: s.arms.map(a => armToJson(a)) };
    case 'break': return { kind: 'break' };
    case 'continue': return { kind: 'continue' };
  }
}

function armToJson(a: HirMatchArm): unknown {
  return { pattern: patToJson(a.pattern), body: blockToJson(a.body) };
}

function patToJson(p: HirPattern): unknown {
  switch (p.kind) {
    case 'wildcard': return { kind: 'wildcard' };
    case 'binding': return { kind: 'binding', name: p.name };
    case 'path': return { kind: 'path', enum: p.enumName, variant: p.variant };
    case 'literal': return { kind: 'literal', value: p.value.value, type: typeToJson(p.value.type) };
    case 'some': return { kind: 'some', inner: patToJson(p.inner) };
    case 'none': return { kind: 'none' };
    case 'ok': return { kind: 'ok', inner: patToJson(p.inner) };
    case 'err': return { kind: 'err', inner: patToJson(p.inner) };
  }
}

function exprToJson(e: HirExpr): unknown {
  switch (e.kind) {
    case 'lit': return { kind: 'lit', value: e.value, type: typeToJson(e.type) };
    case 'ident': {
      const id = e.ident;
      const name = id.kind === 'fn' ? id.name : id.name;
      return { kind: 'ident', ident: { kind: id.kind, name }, type: typeToJson(e.type) };
    }
    case 'binary': return { kind: 'binary', op: e.op, left: exprToJson(e.left), right: exprToJson(e.right), type: typeToJson(e.type) };
    case 'unary': return { kind: 'unary', op: e.op, expr: exprToJson(e.expr), type: typeToJson(e.type) };
    case 'call': return { kind: 'call', callee: exprToJson(e.callee), args: e.args.map(a => ({ name: a.name, value: exprToJson(a.value) })), type: typeToJson(e.type) };
    case 'field': return { kind: 'field', name: e.name, obj: exprToJson(e.obj), type: typeToJson(e.type) };
    case 'index': return { kind: 'index', obj: exprToJson(e.obj), index: exprToJson(e.index), type: typeToJson(e.type) };
    case 'array': return { kind: 'array', elements: e.elements.map(exprToJson), type: typeToJson(e.type) };
    case 'map': return { kind: 'map', entries: e.entries.map(en => ({ key: exprToJson(en.key), value: exprToJson(en.value) })), type: typeToJson(e.type) };
    case 'block': return blockToJson(e);
    case 'if_expr': return {
      kind: 'if_expr', cond: exprToJson(e.cond),
      then: blockToJson(e.then),
      else: e.else ? (e.else.kind === 'if_expr' ? exprToJson(e.else) : blockToJson(e.else)) : undefined,
      type: typeToJson(e.type),
    };
    case 'match_expr': return { kind: 'match_expr', subject: exprToJson(e.subject), arms: e.arms.map(a => armToJson(a)), type: typeToJson(e.type) };
    case 'return': return { kind: 'return', value: e.value ? exprToJson(e.value) : undefined, type: typeToJson(e.type) };
    case 'propagate': return { kind: 'propagate', expr: exprToJson(e.expr), type: typeToJson(e.type) };
    case 'ok': return { kind: 'ok', value: e.value ? exprToJson(e.value) : undefined, type: typeToJson(e.type) };
    case 'error': return { kind: 'error', value: e.value ? exprToJson(e.value) : undefined, type: typeToJson(e.type) };
    case 'assign': return { kind: 'assign', target: exprToJson(e.target), value: exprToJson(e.value), type: typeToJson(e.type) };
    case 'closure': return { kind: 'closure', params: e.params.map(p => ({ name: p.name, type: typeToJson(p.type) })), ret: typeToJson(e.ret), body: blockToJson(e.body), type: typeToJson(e.type) };
    case 'some': return { kind: 'some', value: e.value ? exprToJson(e.value) : undefined, type: typeToJson(e.type) };
    case 'none': return { kind: 'none', type: typeToJson(e.type) };
  }
}

// ---------------------------------------------------------------------------
// Pretty printer (human readable) — used by `nova dump-hir`
// ---------------------------------------------------------------------------

export function hirToString(mod: HirModule): string {
  const lines: string[] = [];
  for (const d of mod.decls) {
    lines.push(declToString(d, 0));
  }
  return lines.join('\n');
}

function indent(n: number): string {
  return '  '.repeat(n);
}

function declToString(d: HirDecl, n: number): string {
  const i = indent(n);
  switch (d.kind) {
    case 'fn':
      return `${i}fn ${d.name}(${d.params.map(p => `${p.name}: ${hirTypeToString(p.type)}`).join(', ')}) -> ${hirTypeToString(d.ret)} {\n${blockToString(d.body, n + 1)}\n${i}}`;
    case 'struct':
      return `${i}struct ${d.name} { ${d.fields.map(f => `${f.name}: ${hirTypeToString(f.type)}`).join(', ')} }`;
    case 'enum':
      return `${i}enum ${d.name} { ${d.variants.map(v => v.name).join(', ')} }`;
    case 'const':
      return `${i}const ${d.name}: ${d.type ? hirTypeToString(d.type) : '?'} = ...`;
    case 'nominal':
      return `${i}type ${d.name} = ${hirTypeToString(d.inner)}`;
  }
}

function blockToString(b: { stmts: HirStmt[]; tail?: HirExpr }, n: number): string {
  const out: string[] = [];
  for (const s of b.stmts) out.push(stmtToString(s, n));
  if (b.tail) out.push(indent(n) + exprToString(b.tail));
  return out.join('\n');
}

function stmtToString(s: HirStmt, n: number): string {
  const i = indent(n);
  switch (s.kind) {
    case 'expr': return i + exprToString(s.expr);
    case 'let': return `${i}let ${s.name}: ${s.type ? hirTypeToString(s.type) : '?'} = ${exprToString(s.value)}`;
    case 'assign': return `${i}${exprToString(s.target)} = ${exprToString(s.value)}`;
    case 'field_assign': return `${i}.${s.name} = ${exprToString(s.value)}`;
    case 'index_assign': return `${i}[${exprToString(s.index)}] = ${exprToString(s.value)}`;
    case 'block': return `${i}{\n${blockToString(s, n + 1)}\n${i}}`;
    case 'if': return `${i}if ${exprToString(s.cond)} { ... }`;
    case 'while': return `${i}while ${exprToString(s.cond)} { ... }`;
    case 'for': return `${i}for ${s.name} in ${exprToString(s.iter)} { ... }`;
    case 'return': return `${i}return${s.value ? ' ' + exprToString(s.value) : ''}`;
    case 'match': return `${i}match ${exprToString(s.subject)} { ... }`;
    case 'break': return `${i}break`;
    case 'continue': return `${i}continue`;
  }
}

function exprToString(e: HirExpr): string {
  switch (e.kind) {
    case 'lit': return JSON.stringify(e.value);
    case 'ident': return e.ident.name;
    case 'binary': return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case 'unary': return `${e.op}${exprToString(e.expr)}`;
    case 'call': return `${exprToString(e.callee)}(${e.args.map(a => exprToString(a.value)).join(', ')})`;
    case 'field': return `${exprToString(e.obj)}.${e.name}`;
    case 'index': return `${exprToString(e.obj)}[${exprToString(e.index)}]`;
    case 'array': return `[${e.elements.map(exprToString).join(', ')}]`;
    case 'map': return `{ ${e.entries.map(en => `${exprToString(en.key)}: ${exprToString(en.value)}`).join(', ')} }`;
    case 'block': return `{ ${blockToString(e, 0)} }`;
    case 'if_expr': return `if ${exprToString(e.cond)} { ... }`;
    case 'match': return `match ${exprToString(e.subject)} { ... }`;
    case 'return': return `return${e.value ? ' ' + exprToString(e.value) : ''}`;
    case 'propagate': return `${exprToString(e.expr)}?`;
    case 'ok': return `ok(${e.value ? exprToString(e.value) : ''})`;
    case 'error': return `error(${e.value ? exprToString(e.value) : ''})`;
    case 'assign': return `${exprToString(e.target)} = ${exprToString(e.value)}`;
    case 'closure': return `(|${e.params.map(p => p.name).join(', ')}| => ${blockToString(e.body, 0)})`;
    case 'some': return `Some(${e.value ? exprToString(e.value) : ''})`;
    case 'none': return `None`;
  }
}
