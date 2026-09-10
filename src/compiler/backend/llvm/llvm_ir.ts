/**
 * LLVM IR module builder.
 *
 * A simple, deterministic text container for the sections of an LLVM IR
 * module. The codegen pass fills these sections; `emit()` produces the final
 * `.ll` file content. Everything is emitted in a fixed order so golden tests
 * are stable:
 *
 *   1. header comment (+ target triple / data layout)
 *   2. struct type definitions (`%name = type { ... }`)
 *   3. external function declarations (runtime + intrinsics)
 *   4. global constants (string literals, const decls)
 *   5. functions
 */

export class LlvmModule {
  readonly header: string[] = [];
  readonly typedefs: string[] = [];
  readonly externs: string[] = [];
  readonly globals: string[] = [];
  readonly funcs: string[] = [];

  addHeader(line: string): void { this.header.push(line); }
  addTypedef(line: string): void { this.typedefs.push(line); }
  addExtern(line: string): void { this.externs.push(line); }
  addGlobal(line: string): void { this.globals.push(line); }
  addFunc(line: string | string[]): void {
    if (typeof line === 'string') this.funcs.push(line);
    else this.funcs.push(...line);
  }

  /** Render the full module text. */
  emit(): string {
    const parts: string[] = [];
    parts.push('; NOVA — LLVM IR (generated; deterministic)');
    if (this.header.length > 0) parts.push(...this.header);
    if (this.typedefs.length > 0) { parts.push(''); parts.push(...this.typedefs); }
    if (this.externs.length > 0) { parts.push(''); parts.push(...this.externs); }
    if (this.globals.length > 0) { parts.push(''); parts.push(...this.globals); }
    if (this.funcs.length > 0) { parts.push(''); parts.push(...this.funcs); }
    parts.push('');
    return parts.join('\n');
  }
}

/** Canonicalize generated LLVM IR for golden-test comparison. */
export function canonicalizeLlvm(ir: string): string {
  const lines = ir.split('\n');
  const out: string[] = [];
  let renames = new Map<string, string>();
  let next = 0;

  const lookup = (name: string): string => {
    if (renames.has(name)) return renames.get(name)!;
    const fresh = `%r${next++}`;
    renames.set(name, fresh);
    return fresh;
  };

  for (const line of lines) {
    if (line.startsWith('define ')) {
      renames = new Map<string, string>();
      next = 0;
    }
    // Renumber per-function %tN registers by first occurrence.
    let l = line.replace(/%t(\d+)/g, (m, n: string) => {
      const base = m;
      void n;
      return lookup(base);
    });
    out.push(l);
  }
  return out.join('\n');
}