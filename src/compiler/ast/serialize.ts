import type { Program, TopLevelNode } from './ast/ast.ts';

/**
 * AST → plain JSON serializer for AI-native tooling (`nova ast --json`).
 * Every node becomes `{ kind, ...fields, span }`.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function spanToJson(span: { start: number; end: number; line: number; col: number }): Json {
  return { start: span.start, end: span.end, line: span.line, col: span.col };
}

function nodeToJson(node: unknown): Json {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return node as Json;
  if (Array.isArray(node)) return node.map(nodeToJson);
  const out: { [k: string]: Json } = {};
  const rec = node as Record<string, unknown>;
  if ('kind' in rec) out['kind'] = rec['kind'] as Json;
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'kind' || key === 'span') continue;
    if (value === undefined) continue;
    out[key] = nodeToJson(value);
  }
  if ('span' in rec && rec['span']) out['span'] = spanToJson(rec['span'] as Parameters<typeof spanToJson>[0]);
  return out;
}

export function programToJson(program: Program): string {
  return JSON.stringify(
    {
      kind: 'program',
      file: program.file,
      decls: program.decls.map((d: TopLevelNode) => nodeToJson(d)),
    },
    null,
    2,
  );
}
