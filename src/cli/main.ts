import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { compile, loadProgram, parseSource, compileSources } from '../compiler/driver.ts';
import type { CompileResult } from '../compiler/driver.ts';
import { NovaCompileError, formatDiagnostics, diagnosticsToJson } from '../compiler/diagnostics/diagnostics.ts';
import type { Diagnostic } from '../compiler/diagnostics/diagnostics.ts';
import type { Expr, Program } from '../compiler/ast/ast.ts';
import { programToJson } from '../compiler/ast/serialize.ts';
import { formatProgram } from '../fmt/formatter.ts';
import { Interpreter } from '../runtime/interpreter.ts';
import { generateJs } from '../compiler/codegen/js.ts';
import { typeToJson } from '../compiler/typechecker/types.ts';
import { lintProgram } from '../lint/lint.ts';
import { astToHir } from '../compiler/hir/hir_lower.ts';
import { hirToJson, hirToString } from '../compiler/hir/hir_serialize.ts';
import { mirLowerModule } from '../compiler/mir/mir_lower.ts';
import { verifyMirModule } from '../compiler/mir/mir_verify.ts';
import { mirToJson, mirToString } from '../compiler/mir/mir_serialize.ts';
import { MirInterpreter } from '../compiler/mir/mir_interp.ts';
import type { NovaType } from '../compiler/typechecker/types.ts';
import { buildNative, lowerMirToLlvm } from '../compiler/backend/llvm_backend.ts';
import { NovaNativeError } from '../compiler/backend/native_error.ts';

export const NOVA_VERSION = '0.1.0';

/** NOVA CLI entry point. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      printHelp();
      return 0;
    case 'version':
      console.log(NOVA_VERSION);
      return 0;
    case 'run': return cmdRun(args);
    case 'build': return cmdBuild(args);
    case 'check': return cmdCheck(args);
    case 'fmt': return cmdFmt(args);
    case 'format': return cmdFmt(args);
    case 'ast': return cmdAst(args);
    case 'test': return cmdTest(args);
    case 'new': return cmdNew(args);
    case 'init': return cmdInit(args);
    case 'repl': return cmdRepl();
    case 'symbols': return cmdSymbols(args);
    case 'types': return cmdTypes(args);
    case 'dependencies': return cmdDeps(args);
     case 'lint': return cmdLint(args);
    case 'dump-hir': return cmdDumpHir(args);
    case 'dump-mir': return cmdDumpMir(args);
    case 'dump-llvm': return cmdDumpLlvm(args);
    case 'check-mir': return cmdCheckMir(args);
    case 'run-mir': return cmdRunMir(args);
    default:
      console.error(`unknown command '${command}' (see 'nova help')`);
      return 2;
  }
}

function printHelp(): void {
  console.log(`NOVA ${NOVA_VERSION} — a modern, type-safe, AI-native language

USAGE:
  nova <command> [options]

COMMANDS:
  run <file>          Run a NOVA program (interpret)
  build <file>        Compile to a standalone JS module (dist/), or native with --native
  check <file>        Type-check a program (--json for machine output)
  fmt <file>          Format a file in place (--check to verify only)
  ast <file>          Print the AST as JSON
  symbols <file>      Print resolved symbol table (--json)
  types <file>        Print inferred types for every expression (--json)
  dependencies <file> Print the module import graph (--json)
   lint <file>         Run lint checks (reports warnings, --json)
    dump-hir <file>     Dump HIR for a program (--json for structured output)
    dump-mir <file>     Dump MIR: basic blocks + explicit terminators (--json)
    dump-llvm <file>    Dump real LLVM IR from the MIR backend
    check-mir <file>    Verify MIR (blocks, terminators, locals, types) --json
    run-mir <file>      Run a program on the reference MIR interpreter
  test <file|dir>     Run test "..." { } blocks
  new <name>          Create a new NOVA project
  init                Initialize a NOVA project in the current directory
  repl                Start an interactive session
  version             Print version
  help                Show this help`);
}

function findNovaFile(args: string[]): string {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('error: expected a .nova file');
    process.exit(2);
  }
  return path.resolve(file);
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Print compile diagnostics nicely and exit with code 1. */
function handleCompileError(e: unknown, sources?: Map<string, string>): never {
  if (e instanceof NovaCompileError) {
    for (const d of e.diagnostics) {
      const src = sources?.get(d.span.file) ?? safeRead(d.span.file);
      console.error(formatDiagnostics([d], src || undefined));
    }
    process.exit(1);
  }
  throw e;
}

// ------------------------------------------------------------------ commands

function cmdRun(args: string[]): number {
  const file = findNovaFile(args);
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = compile(file);
  } catch (e) {
    handleCompileError(e);
  }
  const interpreter = new Interpreter(compiled.programs, compiled.symbols);
  const code = interpreter.run();
  for (const d of interpreter.getDiagnostics()) {
    console.error(formatDiagnostics([d], compiled.sources.get(d.span.file) || undefined));
  }
  return code;
}

function cmdBuild(args: string[]): number {
  const file = findNovaFile(args);
  const emitArg = args.find((arg) => arg.startsWith('--emit='))?.slice('--emit='.length);
  if (args.includes('--native') || emitArg !== undefined) {
    return cmdNativeBuild(file, args, emitArg);
  }
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = compile(file);
  } catch (e) {
    handleCompileError(e, undefined);
  }
  const { programs, symbols } = compiled;
  // Merge the entry file and its imports into one logical module.
  const merged: Program = {
    kind: 'program',
    decls: programs.flatMap((p) => p.decls),
    file,
    span: { start: 0, end: 0, line: 1, col: 1 },
  };
  const fieldOrder = new Map<string, string[]>();
  for (const [name, info] of symbols.structs) {
    fieldOrder.set(name, [...info.fields.keys()]);
  }
  const js = generateJs(merged, fieldOrder);
  const outDir = path.join(path.dirname(file), 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, path.basename(file).replace(/\.nova$/, '.mjs'));
  fs.writeFileSync(outFile, js);
  console.log(`compiled ${path.basename(file)} -> ${outFile}`);
  return 0;
}

function cmdNativeBuild(file: string, args: string[], emitArg?: string): number {
  const emit = emitArg ?? 'exe';
  if (emit !== 'llvm' && emit !== 'obj' && emit !== 'exe') {
    console.error(`error: unsupported native emit stage '${emit}' (expected llvm, obj, or exe)`);
    return 2;
  }
  const compiled = safeCompile(file);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  const errors = verifyMirModule(mir);
  if (errors.length > 0) {
    console.error(`nova: MIR verification failed for '${file}':`);
    for (const e of errors) console.error(`  [${e.fn}${e.block ? `/${e.block}` : ''}] ${e.message}`);
    return 1;
  }
  const base = path.join(path.dirname(file), 'dist', path.basename(file).replace(/\.nova$/, ''));
  try {
    const result = buildNative(mir, compiled.symbols, base, { release: args.includes('--release'), emit });
    const output = emit === 'llvm' ? result.llPath : emit === 'obj' ? result.objPath : result.exePath;
    console.log(`compiled ${path.basename(file)} -> ${output}`);
    return 0;
  } catch (e) {
    if (e instanceof NovaNativeError) {
      console.error(e.format());
      return 1;
    }
    throw e;
  }
}

function cmdCheck(args: string[]): number {
  const file = findNovaFile(args);
  const json = args.includes('--json');
  try {
    compile(file);
  } catch (e) {
    if (e instanceof NovaCompileError) {
      if (json) {
        console.log(diagnosticsToJson(e.diagnostics));
      } else {
        handleCompileError(e);
      }
      return 1;
    }
    throw e;
  }

  if (json) console.log(JSON.stringify({ diagnostics: [] }, null, 2));
  else console.log('ok: no errors');
  return 0;
}

function cmdFmt(args: string[]): number {
  const file = findNovaFile(args);
  const checkOnly = args.includes('--check');
  const source = safeRead(file);
  let formatted: string;
  try {
    formatted = formatProgram(parseSource(source, file));
  } catch (e) {
    handleCompileError(e);
  }
  if (checkOnly) {
    if (formatted !== source.replace(/\r\n/g, '\n')) {
      console.log(`${file} is not formatted`);
      return 1;
    }
    console.log(`${file} is formatted`);
    return 0;
  }
  fs.writeFileSync(file, formatted);
  console.log(`formatted ${file}`);
  return 0;
}

function cmdAst(args: string[]): number {
  const file = findNovaFile(args);
  const program = parseSource(safeRead(file), file);
  console.log(programToJson(program));
  return 0;
}

function cmdTest(args: string[]): number {
  const target = args[0] ? path.resolve(args[0]) : path.resolve('src');
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith('.nova')).map((f) => path.join(target, f))
    : [target];
  let failed = 0;
  let total = 0;
  for (const file of files) {
    let compiled;
    try {
      compiled = compile(file);
    } catch (e) {
      handleCompileError(e);
    }
    const interpreter = new Interpreter(compiled.programs, compiled.symbols);
    for (const result of interpreter.runTests()) {
      total++;
      if (result.passed) {
        console.log(`  ✓ ${result.name}`);
      } else {
        failed++;
        console.log(`  ✗ ${result.name}`);
        console.log(`      ${result.error ?? 'failed'}`);
      }
    }
  }
  console.log(`\n${total - failed}/${total} tests passed`);
  return failed > 0 ? 1 : 0;
}

const NOVA_TOML = (name: string) => `[package]
name = "${name}"
version = "0.1.0"
edition = "2026"
`;

const HELLO_NOVA = `fn main() {
    print("Hello, NOVA!")
}
`;

function cmdNew(args: string[]): number {
  const name = args[0];
  if (!name) {
    console.error("error: expected a project name: nova new <name>");
    return 2;
  }
  const dir = path.resolve(name);
  if (fs.existsSync(dir)) {
    console.error(`error: directory '${dir}' already exists`);
    return 1;
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nova.toml'), NOVA_TOML(name));
  fs.writeFileSync(path.join(dir, 'src', 'main.nova'), HELLO_NOVA);
  console.log(`created new NOVA project '${name}'`);
  console.log(`\n  cd ${name}`);
  console.log('  nova run src/main.nova');
  return 0;
}

function cmdInit(args: string[]): number {
  const dir = process.cwd();
  const name = path.basename(dir);
  if (fs.existsSync(path.join(dir, 'nova.toml'))) {
    console.error('error: project is already initialized (nova.toml exists)');
    return 1;
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nova.toml'), NOVA_TOML(name));
  if (!fs.existsSync(path.join(dir, 'src', 'main.nova'))) {
    fs.writeFileSync(path.join(dir, 'src', 'main.nova'), HELLO_NOVA);
  }
  console.log(`initialized NOVA project '${name}'`);
  return 0;
}

function cmdRepl(): number {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'nova> ' });
  console.log(`NOVA ${NOVA_VERSION} REPL — type an expression or statement, Ctrl+C to exit`);
  /** Accumulated top-level declarations (definitions persist between lines). */
  const history: Array<{ file: string; source: string }> = [];
  let counter = 0;
  rl.prompt();
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        const isDecl = /}(\s*)$/.test(trimmed) ||
          /^(fn|struct|enum|const|use|test)\b/.test(trimmed);
        const source = isDecl ? trimmed : `__repl_value = ${trimmed}\n__repl_value`;
        const file = `<repl:${counter++}>`;
        const result = compileSources([...history, { file, source }]);
        const errors = result.diagnostics.filter((d) => d.severity === 'error');
        if (errors.length > 0) {
          for (const d of errors) console.error(`${d.code}: ${d.message}`);
        } else {
          history.push({ file, source });
          const interpreter = new Interpreter(result.programs, result.symbols);
          interpreter.run();
          for (const d of interpreter.getDiagnostics()) {
            console.error(`runtime: ${d.message}`);
          }
        }
      } catch (e) {
        if (e instanceof NovaCompileError) {
          for (const d of e.diagnostics) console.error(`${d.code}: ${d.message}`);
        } else {
          console.error(String(e));
        }
      }
    }
    rl.prompt();
  });
  return 0;
}

// ---------------------------------------------------- new commands

/** nova symbols <file> --json: resolved symbol table */
function cmdSymbols(args: string[]): number {
  const file = findNovaFile(args);
  const compiled = safeCompile(file);
  const symbols: Record<string, unknown[]> = {};
  for (const [k, v] of compiled.symbols.structs) symbols[k] = [{ kind: 'struct', fields: [...v.fields.keys()] }];
  for (const [k, v] of compiled.symbols.enums) symbols[k] = [{ kind: 'enum', variants: [...v.variants.keys()] }];
  for (const [k, v] of compiled.symbols.nominals) symbols[k] = [{ kind: 'type', inner: v.inner }];
  for (const [k, v] of compiled.symbols.fns) symbols[k] = [{ kind: 'fn', params: v.params.length, ret: v.ret }];
  for (const [k, v] of compiled.symbols.consts) symbols[k] = [{ kind: 'const', type: v.type }];
  console.log(JSON.stringify({ symbols }, null, 2));
  return 0;
}

/** nova types <file> --json: expression type map */
function cmdTypes(args: string[]): number {
  const file = findNovaFile(args);
  const compiled = safeCompile(file);
  const types: { [k: string]: string } = {};
  for (const [expr, t] of compiled.exprTypes) {
    types[`${expr.kind}:${expr.span.start}`] = typeToJson(t) as unknown as string;
  }
  console.log(JSON.stringify({ types }, null, 2));
  return 0;
}

/** nova dependencies <file> --json: module import graph */
function cmdDeps(args: string[]): number {
  const file = findNovaFile(args);
  const compiled = safeCompile(file);
  const deps: Array<{ file: string; uses: string[] }> = compiled.programs.map((p) => ({
    file: p.file,
    uses: p.decls.filter((d) => d.kind === 'use').map((d) => (d as { path: string }).path),
  }));
  console.log(JSON.stringify({ dependencies: deps, sources: [...compiled.sources.keys()] }, null, 2));
  return 0;
}

/** nova lint <file>: static analysis warnings */
function cmdLint(args: string[]): number {
  const file = findNovaFile(args);
  const json = args.includes('--json');
  const compiled = safeCompile(file);
  const source = (f: string) => compiled.sources.get(f);
  const lints = lintProgram({ programs: compiled.programs, source });
  const warnings = [...compiled.diagnostics, ...lints].filter((d) => d.severity === 'warning' || d.severity === 'error');
  if (warnings.length === 0) {
    if (json) console.log(JSON.stringify({ diagnostics: [] }, null, 2));
    else console.log(`${file}: no issues`);
    return 0;
  }
  if (json) {
    console.log(diagnosticsToJson(warnings));
  } else {
    for (const d of warnings) {
      console.error(formatDiagnostics([d], source(d.span.file) || undefined));
    }
  }
  return warnings.some((d) => d.severity === 'error') ? 1 : 0;
}

// ---------------------------------------------------- dump commands
//
// `nova dump-hir` and `nova dump-mir` expose intermediate representations for
// debugging. `dump-hir` is fully implemented (typed+resolved AST -> HIR).
// `dump-mir` is declared now so the CLI surface is stable; it reports that the
// HIR -> MIR pass has not yet been implemented (see docs/COMPILER_ARCHITECTURE.md)
// rather than silently emitting JS.

/** nova dump-hir <file> [--json]: print the HIR for a program. */
function cmdDumpHir(args: string[]): number {
  const file = findNovaFile(args);
  const json = args.includes('--json');
  const compiled = safeCompile(file);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  if (json) {
    console.log(JSON.stringify(hirToJson(hir), null, 2));
  } else {
    console.log(hirToString(hir));
  }
  return 0;
}

// ---------------------------------------------------- MIR commands
//
// The MIR pipeline: compile (parse+resolve+typecheck) -> astToHir ->
// mirLowerModule -> verifyMirModule. Every MIR command verifies the module
// before using it: the verifier is part of the pipeline, not an optional
// lint step.

/** Build + verify MIR for a compiled program. Returns null after reporting verification errors. */
function buildMir(file: string): ReturnType<typeof mirLowerModule> | null {
  const compiled = safeCompile(file);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  const errors = verifyMirModule(mir);
  if (errors.length > 0) {
    console.error(`nova: MIR verification failed for '${file}':`);
    for (const e of errors) {
      console.error(`  [${e.fn}${e.block ? `/${e.block}` : ''}] ${e.message}`);
    }
    return null;
  }
  return mir;
}

/** nova dump-mir <file> [--json]: print the MIR for a program. */
function cmdDumpMir(args: string[]): number {
  const file = findNovaFile(args);
  const json = args.includes('--json');
  const mir = buildMir(file);
  if (!mir) return 1;
  if (json) console.log(JSON.stringify(mirToJson(mir), null, 2));
  else console.log(mirToString(mir));
  return 0;
}

/** nova check-mir <file> [--json]: verify MIR without running or dumping. */
function cmdCheckMir(args: string[]): number {
  const file = findNovaFile(args);
  const json = args.includes('--json');
  const compiled = safeCompile(file);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  const errors = verifyMirModule(mir);
  if (json) {
    console.log(JSON.stringify({
      file,
      functions: mir.decls.filter((d) => d.kind === 'fn' || d.kind === 'closure_fn').length,
      verified: errors.length === 0,
      errors,
    }, null, 2));
  } else if (errors.length > 0) {
    console.error(`nova: MIR verification failed for '${file}':`);
    for (const e of errors) {
      console.error(`  [${e.fn}${e.block ? `/${e.block}` : ''}] ${e.message}`);
    }
    return 1;
  } else {
    const fnCount = mir.decls.filter((d) => d.kind === 'fn' || d.kind === 'closure_fn').length;
    const blockCount = mir.decls.reduce((n, d) => n + (d.kind === 'fn' || d.kind === 'closure_fn' ? d.blocks.length : 0), 0);
    console.log(`${file}: ok — MIR verified (${fnCount} functions, ${blockCount} blocks)`);
  }
  return errors.length === 0 ? 0 : 1;
}

/** nova run-mir <file>: execute the program on the reference MIR interpreter. */
function cmdRunMir(args: string[]): number {
  const file = findNovaFile(args);
  const mir = buildMir(file);
  if (!mir) return 1;
  const interp = new MirInterpreter(mir);
  return interp.run('main');
}

/** nova dump-llvm <file>: lower verified MIR to real LLVM IR text. */
function cmdDumpLlvm(args: string[]): number {
  const file = findNovaFile(args);
  const compiled = safeCompile(file);
  const hir = astToHir(compiled.programs, compiled.symbols, compiled.exprTypes);
  const mir = mirLowerModule(hir, compiled.symbols);
  const errors = verifyMirModule(mir);
  if (errors.length > 0) {
    console.error(`nova: MIR verification failed for '${file}':`);
    for (const e of errors) console.error(`  [${e.fn}${e.block ? `/${e.block}` : ''}] ${e.message}`);
    return 1;
  }
  console.log(lowerMirToLlvm(mir, compiled.symbols).text);
  return 0;
}


function safeCompile(file: string): CompileResult {
  try {
    return compile(file);
  } catch (e) {
    if (e instanceof NovaCompileError) {
      process.exitCode = 1;
      console.error(formatDiagnostics(e.diagnostics, safeRead(file)));
      process.exit(1);
    }
    throw e;
  }
}

