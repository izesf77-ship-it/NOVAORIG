/**
 * NOVA symbol resolver.
 *
 * Performs name resolution as a separate phase from type checking.
 * In the current implementation, name resolution is still handled by the
 * typechecker (Checker), but this module provides a clean interface for
 * tooling (LSP, `nova symbols --json`) and paves the way for splitting
 * resolution and type-checking into separate passes.
 */

import type { Program } from '../ast/ast.ts';
import type { Span2 } from '../lexer/token.ts';

/** A binding resolved to a specific declaration. */
export interface ResolvedBinding {
  kind: 'variable' | 'function' | 'struct' | 'enum' | 'const' | 'type';
  name: string;
  span: Span2;
  declSpan: Span2;
}

/** A resolved symbol tree that can be queried by tooling. */
export interface ResolvedSymbols {
  symbols: Map<string, ResolvedBinding>;
  scopes: ScopeInfo[];
  diagnostics: { code: string; message: string; span: Span2 }[];
}

export interface ScopeInfo {
  id: number;
  parent: number | null;
  name: string;
  bindings: Map<string, ResolvedBinding>;
}

/**
 * Extract resolved symbol information from already-parsed/analyzed programs.
 * In a future phase, this will perform full traversal-based resolution.
 */
export class Resolver {
  private readonly programs: Program[];
  private readonly scopes: ScopeInfo[] = [];
  private readonly symbols = new Map<string, ResolvedBinding>();
  private readonly diagnostics: { code: string; message: string; span: Span2 }[] = [];

  constructor(programs: Program[]) {
    this.programs = programs;
  }

  resolve(symbols: {
    structs: Map<string, { name: string; span: Span2 }>;
    enums: Map<string, { name: string; span: Span2 }>;
    nominals: Map<string, { name: string; span: Span2 }>;
    fns: Map<string, { name: string; span: Span2 }>;
    consts: Map<string, { name: string; span: Span2 }>;
  }): ResolvedSymbols {
    const rootScope: ScopeInfo = { id: 0, parent: null, name: 'root', bindings: new Map() };
    this.scopes.push(rootScope);

    for (const [name, info] of symbols.structs) {
      rootScope.bindings.set(name, { kind: 'struct', name, span: info.span, declSpan: info.span });
      this.symbols.set(`${info.span.file}:${info.span.start}`, { kind: 'struct', name, span: info.span, declSpan: info.span });
    }
    for (const [name, info] of symbols.enums) {
      rootScope.bindings.set(name, { kind: 'enum', name, span: info.span, declSpan: info.span });
      this.symbols.set(`${info.span.file}:${info.span.start}`, { kind: 'enum', name, span: info.span, declSpan: info.span });
    }
    for (const [name, info] of symbols.nominals) {
      rootScope.bindings.set(name, { kind: 'type', name, span: info.span, declSpan: info.span });
      this.symbols.set(`${info.span.file}:${info.span.start}`, { kind: 'type', name, span: info.span, declSpan: info.span });
    }
    for (const [name, info] of symbols.fns) {
      rootScope.bindings.set(name, { kind: 'function', name, span: info.span, declSpan: info.span });
      this.symbols.set(`${info.span.file}:${info.span.start}`, { kind: 'function', name, span: info.span, declSpan: info.span });
    }
    for (const [name, info] of symbols.consts) {
      rootScope.bindings.set(name, { kind: 'const', name, span: info.span, declSpan: info.span });
      this.symbols.set(`${info.span.file}:${info.span.start}`, { kind: 'const', name, span: info.span, declSpan: info.span });
    }

    return { symbols: this.symbols, scopes: this.scopes, diagnostics: this.diagnostics };
  }
}
