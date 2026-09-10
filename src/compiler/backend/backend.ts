/**
 * NOVA backend interface.
 *
 * A Backend consumes HIR (produuced by the frontend) and produces executable
 * output — JavaScript source, native machine code, or interpreted execution.
 * The interface is deliberately minimal so that multiple backends can be
 * swapped without touching the frontend.
 */

import type { HirModule } from '../hir/hir.ts';
import type { Diagnostic } from '../diagnostics/diagnostics.ts';
import type { StructInfo, EnumInfo, FnInfo, ConstInfo, NominalInfo } from '../typechecker/checker.ts';

/** Symbol tables gathered by the typechecker. */
export interface SymbolTables {
  structs: Map<string, StructInfo>;
  enums: Map<string, EnumInfo>;
  nominals: Map<string, NominalInfo>;
  fns: Map<string, FnInfo>;
  consts: Map<string, ConstInfo>;
}

/** Output produced by a backend. */
export interface BackendOutput {
  /** Diagnostics generated during backend processing (e.g. codegen warnings). */
  diagnostics: Diagnostic[];
}

/** Result of running a program produced by the backend. */
export interface RunResult {
  exitCode: number;
  diagnostics: Diagnostic[];
}

/**
 * A backend transforms HIR into a target format and optionally executes it.
 */
export interface Backend {
  /**
   * Generate target-specific code from HIR.
   * Called by `nova build`.
   */
  generate(hir: HirModule, symbols: SymbolTables): BackendOutput & { code: string };

  /**
   * Execute the program using this backend.
   * Called by `nova run`.
   */
  run(hir: HirModule, symbols: SymbolTables): RunResult;
}