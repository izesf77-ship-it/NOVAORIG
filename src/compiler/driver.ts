import type { Program } from './ast/ast.ts';
import type { Expr } from './ast/ast.ts';
import { Parser } from './parser/parser.ts';
import { Checker } from './typechecker/checker.ts';
import type { NovaType } from './typechecker/types.ts';
import type { ConstInfo, EnumInfo, FnInfo, NominalInfo, StructInfo } from './typechecker/checker.ts';
import { NovaCompileError } from './diagnostics/diagnostics.ts';
import type { Diagnostic } from './diagnostics/diagnostics.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Compile a single source string into a Program. */
export function parseSource(source: string, file: string): Program {
  return new Parser(source, file).parseProgram();
}

/** Result of compiling a set of NOVA files. */
export interface CompileResult {
  programs: Program[];
  diagnostics: Diagnostic[];
  symbols: {
    structs: Map<string, StructInfo>;
    enums: Map<string, EnumInfo>;
    nominals: Map<string, NominalInfo>;
    fns: Map<string, FnInfo>;
    consts: Map<string, ConstInfo>;
  };
  exprTypes: Map<Expr, NovaType>;
  sources: Map<string, string>;
}

/**
 * Load a file and all of its transitive `use "..."` imports.
 * Paths are resolved relative to the importing file.
 */
export function loadProgram(entryFile: string): { programs: Program[]; sources: Map<string, string> } {
  const sources = new Map<string, string>();
  const programs = new Map<string, Program>();
  const visiting = new Set<string>();

  const load = (file: string): void => {
    const resolved = path.resolve(file);
    if (programs.has(resolved) || visiting.has(resolved)) return;
    visiting.add(resolved);
    let source: string;
    try {
      source = fs.readFileSync(resolved, 'utf8');
    } catch {
      throw new NovaCompileError([{
        code: 'NOVA6002',
        severity: 'error',
        message: `cannot read file '${resolved}'`,
        span: { file: resolved, start: 0, end: 0, line: 1, col: 1 },
      }]);
    }
    sources.set(resolved, source);
    const program = parseSource(source, resolved);
    programs.set(resolved, program);
    for (const decl of program.decls) {
      if (decl.kind === 'use') {
        const target = path.resolve(path.dirname(resolved), decl.path);
        load(target);
      }
    }
    visiting.delete(resolved);
  };

  load(entryFile);
  return { programs: [...programs.values()], sources };
}

/**
 * Full frontend: parse + resolve + type check.
 * Throws NovaCompileError when there are errors.
 */
export function compile(entryFile: string): CompileResult {
  const { programs, sources } = loadProgram(entryFile);
  const checker = new Checker(programs);
  const { diagnostics, structs, enums, nominals, fns, consts, exprTypes } = checker.check();
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new NovaCompileError(errors);
  return { programs, diagnostics, symbols: { structs, enums, nominals, fns, consts }, exprTypes, sources };
}

/** Compile in-memory sources (used by tests and the REPL). */
export function compileSources(sources: Array<{ file: string; source: string }>): CompileResult {
  // First pass: parse all sources and resolve `use` declarations
  const parsed = new Map<string, Program>();
  const sourceMap = new Map<string, string>();
  
  const loadSource = (file: string, source: string): void => {
    if (parsed.has(file)) return;
    sourceMap.set(file, source);
    const program = parseSource(source, file);
    parsed.set(file, program);
    // Resolve `use` declarations by finding matching sources
    for (const decl of program.decls) {
      if (decl.kind === 'use') {
        // Find a source that matches the used path
        for (const src of sources) {
          if (src.file.endsWith(decl.path) || decl.path.endsWith(src.file) || src.file === decl.path) {
            loadSource(src.file, src.source);
            break;
          }
        }
      }
    }
  };
  
  for (const { file, source } of sources) {
    loadSource(file, source);
  }
  
    const programs = [...parsed.values()];
  const checker = new Checker(programs);
  const { diagnostics, structs, enums, nominals, fns, consts, exprTypes } = checker.check();
  return {
    programs,
    diagnostics,
    symbols: { structs, enums, nominals, fns, consts },
    exprTypes,
    sources: sourceMap,
  };
}
