/**
 * NOVA compiler diagnostics.
 *
 * A Diagnostic is the single structured representation of a compiler message.
 * It carries: a stable error code (NOVA<phase><num>), severity, a source Span,
 * optional help text and additional notes. The same structure is rendered as
 * human-friendly text by `formatDiagnostic` or serialized to JSON for
 * AI-native tooling (`nova check --json`).
 *
 * Error code ranges:
 *   NOVA0xxx  internal
 *   NOVA1xxx  lexer
 *   NOVA2xxx  parser
 *   NOVA3xxx  resolver
 *   NOVA4xxx  type checker
 *   NOVA5xxx  runtime
 *   NOVA6xxx  project / CLI
 */

export interface Span {
  file: string;
  /** Byte offset of the first character. */
  start: number;
  /** Byte offset one past the last character. */
  end: number;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  col: number;
}

export type Severity = 'error' | 'warning' | 'note' | 'help';

export interface DiagnosticNote {
  severity: Severity;
  message: string;
  span?: Span;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  span: Span;
  help?: string;
  notes?: DiagnosticNote[];
}

/** Thrown by compiler phases when compilation cannot continue. */
export class NovaCompileError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
    this.name = 'NovaCompileError';
    this.diagnostics = diagnostics;
  }
}

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function colorEnabled(): boolean {
  if (process.env['NOVA_COLOR'] === '0') return false;
  if (process.env['NOVA_COLOR'] === '1') return true;
  return process.stdout.isTTY === true;
}

function paint(text: string, code: string): string {
  return colorEnabled() ? code + text + RESET : text;
}

function severityColor(severity: Severity): string {
  if (severity === 'error') return RED;
  if (severity === 'warning') return YELLOW;
  if (severity === 'note') return BLUE;
  return CYAN;
}

/**
 * Render a diagnostic as a rustc-style report:
 *
 *   error[NOVA4002]: expected Int, found String
 *
 *     ┌─ src/main.nova:3:9
 *     │
 *   3 │     let x = "a" + 1
 *     │             ^^^^^^
 *
 *   help: ...
 */
export function formatDiagnostic(d: Diagnostic, source?: string): string {
  const out: string[] = [];
  const c = paint;
  const label = `${c(d.severity, severityColor(d.severity))}${c(`[${d.code}]`, BOLD)}: ${d.message}`;
  out.push(label);

  if (source === undefined) {
    out.push(`  --> ${d.span.file}:${d.span.line}:${d.span.col}`);
    return out.join('\n');
  }

  const lines = source.split('\n');
  const lineText = lines[d.span.line - 1] ?? '';
  const lineNo = String(d.span.line);
  const gutter = ' '.repeat(lineNo.length);
  const caretStart = d.span.col - 1;
  const caretLen = Math.max(1, Math.min(d.span.end - d.span.start, lineText.length - caretStart));

  out.push(`${c('  -->', DIM)} ${d.span.file}:${d.span.line}:${d.span.col}`);
  out.push(`${gutter} ${c('┌─', DIM)}`);
  out.push(`${gutter} ${c('│', DIM)}`);
  out.push(`${c(lineNo, DIM)} ${c('│', DIM)}   ${lineText}`);
  out.push(
    `${gutter} ${c('│', DIM)}   ${' '.repeat(caretStart)}${c('^'.repeat(caretLen), severityColor(d.severity))}`,
  );
  out.push(`${gutter} ${c('│', DIM)}`);

  if (d.help) out.push(`${c('help:', severityColor('help'))} ${d.help}`);
  for (const n of d.notes ?? []) {
    const where = n.span ? ` --> ${n.span.file}:${n.span.line}:${n.span.col}` : '';
    out.push(`${c(`${n.severity}:`, severityColor(n.severity))} ${n.message}${where}`);
  }
  return out.join('\n');
}

/** Render a list of diagnostics. */
export function formatDiagnostics(diags: Diagnostic[], source?: string): string {
  return diags.map((d) => formatDiagnostic(d, source)).join('\n\n');
}

/** Serialize diagnostics for machine consumption (`nova check --json`). */
export function diagnosticsToJson(diags: Diagnostic[]): string {
  return JSON.stringify({ diagnostics: diags }, null, 2);
}
