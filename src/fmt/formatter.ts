import type {
  Block, Decl, Expr, Program, Stmt, TopLevelNode, TypeExpr,
} from '../compiler/ast/ast.ts';

/**
 * NOVA formatter.
 *
 * Deterministic: the same input always produces the same output, independent
 * of the original whitespace. Two-space indentation, no semicolons, one
 * statement per line, a blank line between top-level declarations.
 */

const INDENT = '  ';

const PREC: Record<string, number> = {
  or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

class Formatter {
  private lines: string[] = [];

  formatProgram(prog: Program): string {
    let first = true;
    for (const decl of prog.decls) {
      if (this.isStmt(decl)) {
        this.formatStmt(decl);
      } else {
        if (!first) this.lines.push('');
        this.formatDecl(decl);
      }
      first = false;
    }
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  private isStmt(n: TopLevelNode): n is Stmt {
    return !['fn', 'struct', 'enum', 'const', 'test', 'use', 'type'].includes(n.kind);
  }

  /** Render statements into this.lines (at current indentation). */
  private emit(stmts: Stmt[]): void {
    for (const stmt of stmts) this.formatStmt(stmt);
  }

  /** Render a block as un-indented lines (caller adds indentation). */
  private renderBlock(block: Block): string[] {
    const sub = new Formatter();
    sub.emit(block.stmts);
    return sub.lines;
  }

  private writeIndented(line: string): void {
    this.lines.push(INDENT + line);
  }

  private formatDecl(decl: Decl): void {
    switch (decl.kind) {
      case 'fn': {
        const params = decl.params
          .map((p) => `${p.name}${p.type ? ': ' + this.type(p.type) : ''}`)
          .join(', ');
        const ret = decl.ret ? ' -> ' + this.type(decl.ret) : '';
        this.lines.push(`fn ${decl.name}(${params})${ret} {`);
        for (const l of this.renderBlock(decl.body)) this.writeIndented(l);
        this.lines.push('}');
        break;
      }
      case 'struct': {
        this.lines.push(`struct ${decl.name} {`);
        for (const f of decl.fields) this.writeIndented(`${f.name}: ${this.type(f.type)}`);
        this.lines.push('}');
        break;
      }
      case 'enum': {
        this.lines.push(`enum ${decl.name} {`);
        for (const v of decl.variants) this.writeIndented(v.name);
        this.lines.push('}');
        break;
      }
      case 'const': {
        const annot = decl.annot ? ': ' + this.type(decl.annot) : '';
        this.lines.push(`const ${decl.name}${annot} = ${this.expr(decl.value)}`);
        break;
      }
      case 'test': {
        this.lines.push(`test ${JSON.stringify(decl.name)} {`);
        for (const l of this.renderBlock(decl.body)) this.writeIndented(l);
        this.lines.push('}');
        break;
      }
      case 'use': {
        this.lines.push(`use ${JSON.stringify(decl.path)}`);
        break;
      }
      case 'type': {
        this.lines.push(`type ${decl.name} = ${this.type(decl.inner)}`);
        break;
      }
    }
  }

  private formatStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'assign': {
        const target = this.expr(stmt.target);
        const annot = stmt.isDeclaration && stmt.annot ? ': ' + this.type(stmt.annot) : '';
        this.lines.push(`${target}${annot} = ${this.expr(stmt.value)}`);
        break;
      }
      case 'expr':
        this.lines.push(this.expr(stmt.expr));
        break;
      case 'if': {
        this.lines.push(`if ${this.expr(stmt.cond)} {`);
        for (const l of this.renderBlock(stmt.then)) this.writeIndented(l);
        if (stmt.else) {
          this.lines.push('} else {');
          for (const l of this.renderBlock(stmt.else)) this.writeIndented(l);
        }
        this.lines.push('}');
        break;
      }
      case 'while': {
        this.lines.push(`while ${this.expr(stmt.cond)} {`);
        for (const l of this.renderBlock(stmt.body)) this.writeIndented(l);
        this.lines.push('}');
        break;
      }
      case 'for': {
        this.lines.push(`for ${stmt.name} in ${this.expr(stmt.iter)} {`);
        for (const l of this.renderBlock(stmt.body)) this.writeIndented(l);
        this.lines.push('}');
        break;
      }
      case 'return':
        this.lines.push(stmt.value ? `return ${this.expr(stmt.value)}` : 'return');
        break;
      case 'match': {
        this.lines.push(`match ${this.expr(stmt.subject)} {`);
        for (const arm of stmt.arms) {
          this.writeIndented(`${this.pattern(arm.pattern)} => ${this.armBody(arm.body)}`);
        }
        this.lines.push('}');
        break;
      }
      case 'block': {
        this.lines.push('{');
        for (const l of this.renderBlock(stmt.block)) this.writeIndented(l);
        this.lines.push('}');
        break;
      }
      case 'break':
        this.lines.push('break');
        break;
      case 'continue':
        this.lines.push('continue');
        break;
    }
  }

  /** Render a match arm body compactly when it is a single expression. */
  private armBody(block: Block): string {
    if (block.stmts.length === 1 && block.stmts[0]!.kind === 'expr') {
      return this.expr(block.stmts[0]!.expr);
    }
    const inner = this.renderBlock(block);
    return '{\n' + inner.map((l) => INDENT + l).join('\n') + '\n' + INDENT + '}';
  }

  private pattern(p: { kind: string; [k: string]: unknown }): string {
    switch (p.kind) {
      case 'wildcard': return '_';
      case 'binding': return p['name'] as string;
      case 'path': {
        const name = p['name'] as string;
        const variant = p['variant'] as string;
        return variant ? `${name}.${variant}` : name;
      }
      case 'literal': return this.expr(p['expr'] as Expr);
      case 'some': {
        const inner = p['inner'] as { kind: string; name?: string };
        return inner.kind === 'binding' ? `some(${inner.name})` : 'some';
      }
      case 'none': return 'none';
      case 'ok': {
        const inner = p['inner'] as { kind: string; name?: string };
        return inner.kind === 'binding' ? `ok(${inner.name})` : 'ok';
      }
      case 'err': {
        const inner = p['inner'] as { kind: string; name?: string };
        return inner.kind === 'binding' ? `error(${inner.name})` : 'error';
      }
      default: return '_';
    }
  }

  // ------------------------------------------------------------- expressions

  private expr(e: Expr): string {
    return this.exprPrec(e, 0);
  }

  private exprPrec(e: Expr, minPrec: number): string {
    switch (e.kind) {
      case 'int': case 'float':
        return String(e.value);
      case 'string':
        return '"' + e.parts.map((p) => p.kind === 'text'
          ? p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
          : `{${this.expr(p.expr)}}`).join('') + '"';
      case 'bool':
        return e.value ? 'true' : 'false';
      case 'null':
        return 'null';
      case 'ident':
        return e.name;
      case 'unary':
        return e.op === '-' ? `-${this.exprPrec(e.expr, 7)}` : `not ${this.exprPrec(e.expr, 7)}`;
      case 'binary': {
        const prec = PREC[e.op] ?? 1;
        const text = `${this.exprPrec(e.left, prec)} ${e.op} ${this.exprPrec(e.right, prec + 1)}`;
        return prec < minPrec ? `(${text})` : text;
      }
      case 'field':
        return `${this.exprPrec(e.obj, 9)}.${e.name}`;
      case 'index':
        return `${this.exprPrec(e.obj, 9)}[${this.expr(e.index)}]`;
      case 'call': {
        const args = e.args.map((a) => a.name ? `${a.name}: ${this.expr(a.value)}` : this.expr(a.value));
        return `${this.exprPrec(e.callee, 9)}(${args.join(', ')})`;
      }
      case 'array':
        return `[${e.elements.map((el) => this.expr(el)).join(', ')}]`;
      case 'map':
        return `{${e.entries.map((en) => `${this.expr(en.key)}: ${this.expr(en.value)}`).join(', ')}}`;
      case 'propagate':
        return `${this.exprPrec(e.expr, 9)}?`;
      case 'ok':
        return e.value ? `ok ${this.exprPrec(e.value, 7)}` : 'ok';
      case 'error':
        return e.value ? `error ${this.exprPrec(e.value, 7)}` : 'error';
      case 'some':
        return e.value ? `some(${this.expr(e.value)})` : 'some';
      case 'none':
        return 'none';
      case 'closure': {
        const params = e.params.map((p) => p.name).join(', ');
        const blockLines = this.renderBlock(e.body);
        if (blockLines.length === 1) return `|${params}| ${blockLines[0]}`;
        return `|${params}| { ${blockLines.join('; ')} }`;
      }
    }
    return '<expr>';
  }

  private type(t: TypeExpr): string {
    if (t.kind === 'optional') return `${this.type(t.inner)}?`;
    if (t.kind === 'func') {
      return `fn(${t.params.map((p) => this.type(p)).join(', ')}) -> ${this.type(t.ret)}`;
    }
    return t.args.length > 0 ? `${t.name}<${t.args.map((a) => this.type(a)).join(', ')}>` : t.name;
  }
}

/** Format a parsed program. */
export function formatProgram(prog: Program): string {
  return new Formatter().formatProgram(prog);
}
