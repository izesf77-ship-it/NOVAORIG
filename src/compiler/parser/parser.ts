import type {
  Block, Decl, Expr, MatchArm, Param, Pattern, Program, Stmt, TopLevelNode, TypeExpr,
} from '../ast/ast.ts';
import type { Token } from '../lexer/token.ts';
import { Lexer } from '../lexer/lexer.ts';
import { NovaCompileError } from '../diagnostics/diagnostics.ts';
import type { Diagnostic } from '../diagnostics/diagnostics.ts';

/**
 * NOVA recursive-descent parser.
 *
 * Newline-sensitive: statements are terminated by a newline, `}` or EOF.
 * Inside brackets and blocks newlines are skipped liberally.
 */
export class Parser {
  private tokens: Token[] = [];
  private idx = 0;
  private diagnostics: Diagnostic[] = [];
  private file: string;

  constructor(source: string, file: string) {
    this.file = file;
    const { tokens } = new Lexer(source, file).lex();
    this.tokens = tokens;
  }

  /** Parse a full compilation unit. Collects all syntax errors. */
  parseProgram(): Program {
    this.diagnostics = [];
    this.idx = 0;
    const decls: Decl[] = [];
    while (!this.at('eof')) {
      this.skipNewlines();
      if (this.at('eof')) break;
      try {
        decls.push(this.parseDecl());
      } catch (e) {
        if (e instanceof ParsePanic) {
          this.synchronize();
        } else {
          throw e;
        }
      }
    }
    if (this.diagnostics.length > 0) throw new NovaCompileError(this.diagnostics);
    const end = this.sourceLength();
    return {
      kind: 'program', decls, file: this.file,
      span: { start: 0, end, line: 1, col: 1 },
    };
  }

  private sourceLength(): number {
    const last = this.tokens[this.tokens.length - 1];
    return last ? last.span.end : 0;
  }

  // ------------------------------------------------------------------ decls

  private parseDecl(): TopLevelNode {
    if (this.at('pub')) {
      this.advance();
      const decl = this.parseDecl();
      (decl as { exported?: boolean }).exported = true;
      return decl;
    }
    switch (this.peek().type) {
      case 'fn': return this.parseFn();
      case 'struct': return this.parseStruct();
      case 'enum': return this.parseEnum();
      case 'const': return this.parseConst();
      case 'test': return this.parseTest();
      case 'use': return this.parseUse();
      case 'type': return this.parseTypeDecl();
      default: return this.parseStmt();
    }
  }

  private parseTypeDecl(): Decl {
    const start = this.expect('type').span;
    const name = this.expect('ident').value;
    this.expect('eq');
    const inner = this.parseType();
    this.endStatement();
    return { kind: 'type', name, inner, span: { ...start, end: inner.span.end } };
  }

  private parseFn(): Decl {
    const start = this.expect('fn').span;
    const name = this.expect('ident').value;
    const typeParams: string[] = [];
    if (this.at('lt')) {
      this.advance();
      this.skipNewlines();
      while (!this.at('gt')) {
        typeParams.push(this.expect('ident').value);
        this.skipNewlines();
        if (!this.match('comma')) break;
        this.skipNewlines();
      }
      this.expect('gt');
    }
    this.expect('lparen');
    const params: Param[] = [];
    this.skipNewlines();
    while (!this.at('rparen')) {
      const pStart = this.advance().span;
      const pName = this.prev().value;
      let pType: TypeExpr | undefined;
      if (this.at('colon')) {
        this.advance();
        pType = this.parseType();
      }
      params.push({ name: pName, type: pType, span: pStart });
      this.skipNewlines();
      if (!this.match('comma')) break;
      this.skipNewlines();
    }
    this.expect('rparen');
    let ret: TypeExpr | undefined;
    if (this.match('arrow')) ret = this.parseType();
    const body = this.parseBlock();
    return {
      kind: 'fn', name, typeParams, params, ret, body, exported: false,
      span: { ...start, end: body.span.end },
    };
  }

  private parseStruct(): Decl {
    const start = this.expect('struct').span;
    const name = this.expect('ident').value;
    this.expect('lbrace');
    this.skipNewlines();
    const fields = [];
    while (!this.at('rbrace')) {
      const fStart = this.advance().span;
      const fName = this.prev().value;
      this.expect('colon');
      const fType = this.parseType();
      fields.push({ name: fName, type: fType, span: fStart });
      this.skipNewlines();
      this.match('comma'); // separators are newlines or commas
      this.skipNewlines();
    }
    const end = this.expect('rbrace').span;
    return { kind: 'struct', name, fields, exported: false, span: { ...start, end: end.end } };
  }

  // statements --------------------------------------------------------------

  private parseStmt(): Stmt {
    switch (this.peek().type) {
      case 'if': return this.parseIf();
      case 'while': return this.parseWhile();
      case 'for': return this.parseFor();
      case 'return': return this.parseReturn();
      case 'match': return this.parseMatch();
      case 'break': {
        const t = this.advance();
        this.endStatement();
        return { kind: 'break', span: t.span };
      }
      case 'continue': {
        const t = this.advance();
        this.endStatement();
        return { kind: 'continue', span: t.span };
      }
      case 'lbrace': {
        const block = this.parseBlock();
        return { kind: 'block', block, span: block.span };
      }
      default: return this.parseExprOrAssignStmt();
    }
  }

  private parseExprOrAssignStmt(): Stmt {
    const start = this.peek().span;
    // Annotated declaration: `name: Type = value`
    if (this.at('ident') && this.peekAhead(1).type === 'colon' && this.peekAhead(2).type === 'ident') {
      const nameTok = this.advance();
      this.advance(); // ':'
      const annot = this.parseType();
      this.expect('eq');
      const value = this.parseExpr();
      this.endStatement();
      return {
        kind: 'assign',
        target: { kind: 'ident', name: nameTok.value, span: nameTok.span },
        annot, value,
        span: { ...start, end: this.prev().span.end },
      };
    }
    const target = this.parseExpr();
    if (this.at('eq')) {
      if (target.kind !== 'ident' && target.kind !== 'field' && target.kind !== 'index') {
        this.error('NOVA2002', 'invalid assignment target', start);
        throw new ParsePanic();
      }
      this.advance();
      const value = this.parseExpr();
      this.endStatement();
      const annot = (target as { annot?: TypeExpr }).annot;
      return { kind: 'assign', target, value, annot, span: { ...start, end: this.prev().span.end } };
    }
    this.endStatement();
    return { kind: 'expr', expr: target, span: { ...start, end: this.prev().span.end } };
  }

  private parseIf(): Stmt {
    const start = this.expect('if').span;
    const cond = this.parseExpr();
    const then = this.parseBlock();
    let elseBlock: Block | undefined;
    // Allow `else` to start on its own line: `if c { ... }` \n `else { ... }`.
    if (this.at('else') || (this.at('newline') && this.elseOnFollowingLine())) {
      this.skipNewlines();
      this.expect('else');
      if (this.at('if')) {
        const nested = this.parseIf();
        elseBlock = { stmts: [nested], span: nested.span };
      } else {
        elseBlock = this.parseBlock();
      }
    }
    const end = elseBlock ? elseBlock.span.end : then.span.end;
    return { kind: 'if', cond, then, else: elseBlock, span: { ...start, end } };
  }

  /** True when the current newline run is followed by an `else` token. */
  private elseOnFollowingLine(): boolean {
    let i = this.idx;
    while (this.tokens[i]?.type === 'newline') i++;
    return this.tokens[i]?.type === 'else';
  }

  private parseWhile(): Stmt {
    const start = this.expect('while').span;
    const cond = this.parseExpr();
    const body = this.parseBlock();
    return { kind: 'while', cond, body, span: { ...start, end: body.span.end } };
  }

  private parseFor(): Stmt {
    const start = this.expect('for').span;
    const name = this.expect('ident').value;
    this.expect('in');
    const iter = this.parseExpr();
    const body = this.parseBlock();
    return { kind: 'for', name, iter, body, span: { ...start, end: body.span.end } };
  }

  private parseReturn(): Stmt {
    const start = this.expect('return').span;
    let value: Expr | undefined;
    if (!this.at('newline') && !this.at('rbrace') && !this.at('eof')) {
      value = this.parseExpr();
    }
    this.endStatement();
    return { kind: 'return', value, span: { ...start, end: this.prev().span.end } };
  }

  private parseMatch(): Stmt {
    const start = this.expect('match').span;
    const subject = this.parseExpr();
    this.expect('lbrace');
    this.skipNewlines();
    const arms: MatchArm[] = [];
    while (!this.at('rbrace')) {
      const armStart = this.peek().span;
      const pattern = this.parsePattern();
      this.expect('fatarrow');
      let body: Block;
      if (this.at('lbrace')) {
        body = this.parseBlock();
      } else {
        const stmt = this.parseStmt();
        body = { stmts: [stmt], span: stmt.span };
      }
      arms.push({ pattern, body, span: { ...armStart, end: body.span.end } });
      this.skipNewlines();
    }
    const end = this.expect('rbrace').span;
    return { kind: 'match', subject, arms, span: { ...start, end: end.end } };
  }

  private parsePattern(): Pattern {
    const tok = this.advance();
    const span = tok.span;
    if (tok.type === 'ident' && tok.value === '_') {
      return { kind: 'wildcard', span };
    }
    if (tok.type === 'int') return { kind: 'literal', expr: { kind: 'int', value: Number(tok.value), span }, span };
    if (tok.type === 'float') return { kind: 'literal', expr: { kind: 'float', value: Number(tok.value), span }, span };
    if (tok.type === 'string') return { kind: 'literal', expr: this.stringFromToken(tok), span };
    if (tok.type === 'true') return { kind: 'literal', expr: { kind: 'bool', value: true, span }, span };
    if (tok.type === 'false') return { kind: 'literal', expr: { kind: 'bool', value: false, span }, span };
    if (tok.type === 'null') return { kind: 'literal', expr: { kind: 'null', span }, span };
    if (tok.type === 'ident') {
      const isUpper = tok.value[0]!.toUpperCase() === tok.value[0];
      if (isUpper && this.match('dot')) {
        const variant = this.expect('ident').value;
        return { kind: 'path', name: tok.value, variant, span: { ...span, end: this.prev().span.end } };
      }
      if (isUpper) {
        return { kind: 'path', name: tok.value, variant: '', span };
      }
      return { kind: 'binding', name: tok.value, span };
    }
    if (tok.type === 'some' || tok.type === 'ok' || tok.type === 'error') {
      // some(pattern) / ok(pattern) / error(pattern) — payload patterns with an
      // optional binding inside. A bare keyword matches any payload.
      const kind = tok.type === 'some' ? 'some' : tok.type === 'ok' ? 'ok' : 'err';
      if (this.match('lparen')) {
        const inner = this.parsePattern();
        const end = this.expect('rparen').span;
        return { kind, inner, span: { ...span, end: end.end } } as Pattern;
      }
      return { kind, inner: { kind: 'wildcard', span }, span } as Pattern;
    }
    if (tok.type === 'none') {
      return { kind: 'none', span };
    }
    this.error('NOVA2003', `invalid match pattern '${tok.value}'`, span);
    throw new ParsePanic();
  }

  // expressions -------------------------------------------------------------

  private static readonly BIN_LEVELS: Record<string, number> = {
    or: 1, and: 2, eqeq: 3, neq: 3, lt: 4, le: 4, gt: 4, ge: 4,
    plus: 5, minus: 5, star: 6, slash: 6, percent: 6,
  };

  private static readonly BIN_OPS: Record<string, string> = {
    or: 'or', and: 'and', eqeq: '==', neq: '!=', lt: '<', le: '<=',
    gt: '>', ge: '>=', plus: '+', minus: '-', star: '*', slash: '/', percent: '%',
  };

  private parseExpr(): Expr {
    return this.parseBinary(1);
  }

  private parseBinary(minLevel: number): Expr {
    let left = this.parseUnary();
    while (true) {
      const level = Parser.BIN_LEVELS[this.peek().type];
      if (level === undefined || level < minLevel) return left;
      const opTok = this.advance();
      const op = Parser.BIN_OPS[opTok.type]!;
      const right = this.parseBinary(level + 1);
      left = {
        kind: 'binary', op: op as never, left, right,
        span: { ...left.span, end: right.span.end },
      };
    }
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.type === 'minus') {
      this.advance();
      const expr = this.parseUnary();
      return { kind: 'unary', op: '-', expr, span: { ...tok.span, end: expr.span.end } };
    }
    if (tok.type === 'not_' || tok.type === 'not') {
      this.advance();
      const expr = this.parseUnary();
      return { kind: 'unary', op: 'not', expr, span: { ...tok.span, end: expr.span.end } };
    }
    if (tok.type === 'ok' || tok.type === 'error') {
      this.advance();
      let value: Expr | undefined;
      // The wrapped expression grabs the whole remaining expression:
      // `ok a / b` means `ok (a / b)`, not `(ok a) / b`.
      if (this.startsExpression()) value = this.parseExpr();
      return {
        kind: tok.type === 'ok' ? 'ok' : 'error',
        value, span: { ...tok.span, end: (value ?? tok).span.end },
      };
    }
    return this.parsePostfix();
  }

  private startsExpression(): boolean {
    const t = this.peek().type;
    return !['newline', 'rparen', 'rbrace', 'rbracket', 'eof', 'comma', 'eq'].includes(t);
  }

  /**
   * Lookahead: does the current `<` start a generic type-argument list
   * (`name<A, B>(...)`)? We only accept it when a matching `>` is immediately
   * followed by `(` — otherwise `<` is the less-than comparison operator.
   */
  private isGenericCallStart(): boolean {
    if (!this.at('lt')) return false;
    const bad: ReadonlySet<string> = new Set([
      'rbrace', 'lbrace', 'lparen', 'rparen', 'lbracket', 'rbracket',
      'eq', 'plus', 'minus', 'star', 'slash', 'percent',
      'fatarrow', 'arrow', 'and', 'or', 'not', 'colon', 'pipe',
    ]);
    let depth = 0;
    for (let i = this.idx; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (t.type === 'newline') continue;
      if (t.type === 'lt') {
        depth++;
        continue;
      }
      if (t.type === 'gt') {
        depth--;
        if (depth === 0) {
          let j = i + 1;
          while (this.tokens[j] && this.tokens[j]!.type === 'newline') j++;
          return this.tokens[j]?.type === 'lparen';
        }
        continue;
      }
      if (depth > 0 && bad.has(t.type)) return false;
    }
    return false;
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    // Handle type arguments: `identity<Type1, Type2>(...)`. Only treat `<` as a
    // generic list when a matching `>` is directly followed by `(` — otherwise
    // it is the less-than comparison operator.
    if (expr.kind === 'ident' && this.at('lt') && this.isGenericCallStart()) {
      this.advance(); // consume '<'
      const typeArgs: TypeExpr[] = [];
      this.skipNewlines();
      while (!this.at('gt')) {
        typeArgs.push(this.parseType());
        this.skipNewlines();
        if (!this.match('comma')) break;
        this.skipNewlines();
      }
      const end = this.expect('gt').span;
      expr = { kind: 'generic', name: expr.name, typeArgs, span: { ...expr.span, end: end.end } };
    }
    while (true) {
      if (this.at('lparen')) {
        this.advance();
        const args = [];
        this.skipNewlines();
        while (!this.at('rparen')) {
          // named argument: `name: expr`
          if (this.at('ident') && this.peekAhead(1).type === 'colon') {
            const nameTok = this.advance();
            this.advance(); // ':'
            args.push({ name: nameTok.value, value: this.parseExpr() });
          } else {
            args.push({ value: this.parseExpr() });
          }
          this.skipNewlines();
          if (!this.match('comma')) break;
          this.skipNewlines();
        }
        const end = this.expect('rparen').span;
        expr = { kind: 'call', callee: expr, args, span: { ...expr.span, end: end.end } };
        continue;
      }
      if (this.at('lbracket')) {
        this.advance();
        const index = this.parseExpr();
        const end = this.expect('rbracket').span;
        expr = { kind: 'index', obj: expr, index, span: { ...expr.span, end: end.end } };
        continue;
      }
      if (this.at('dot')) {
        this.advance();
        const nameTok = this.expect('ident');
        expr = { kind: 'field', obj: expr, name: nameTok.value, span: { ...expr.span, end: nameTok.span.end } };
        continue;
      }
      if (this.at('question')) {
        this.advance();
        expr = { kind: 'propagate', expr, span: { ...expr.span, end: this.prev().span.end } };
        continue;
      }
      return expr;
    }
  }

  // primary expressions -----------------------------------------------------

  private parsePrimary(): Expr {
    const tok = this.peek();
    switch (tok.type) {
      case 'int':
        this.advance();
        return { kind: 'int', value: Number(tok.value), span: tok.span };
      case 'float':
        this.advance();
        return { kind: 'float', value: Number(tok.value), span: tok.span };
      case 'string':
        this.advance();
        return this.stringFromToken(tok);
      case 'true':
        this.advance();
        return { kind: 'bool', value: true, span: tok.span };
      case 'false':
        this.advance();
        return { kind: 'bool', value: false, span: tok.span };
      case 'null':
        this.advance();
        return { kind: 'null', span: tok.span };
      case 'some': {
        this.advance();
        // Some(expr) or Some
        if (this.match('lparen')) {
          const value = this.parseExpr();
          const end = this.expect('rparen').span;
          return { kind: 'some', value, span: { ...tok.span, end: end.end } };
        }
        return { kind: 'some', span: tok.span };
      }
      case 'none':
        this.advance();
        return { kind: 'none', span: tok.span };
      case 'pipe': {
        // Closure literal: `|x, y| expr` or `|x, y| { ... }`.
        this.advance();
        const params: Param[] = [];
        this.skipNewlines();
        while (!this.at('pipe')) {
          const pTok = this.expect('ident');
          let pType: TypeExpr | undefined;
          if (this.at('colon')) {
            this.advance();
            pType = this.parseType();
          }
          params.push({ name: pTok.value, type: pType, span: pTok.span });
          this.skipNewlines();
          if (!this.match('comma')) break;
          this.skipNewlines();
        }
        this.expect('pipe');
        let body: Block;
        if (this.at('lbrace')) {
          body = this.parseBlock();
        } else {
          const expr = this.parseExpr();
          body = { stmts: [{ kind: 'expr', expr, span: expr.span }], span: expr.span };
        }
        return { kind: 'closure', params, body, span: { ...tok.span, end: body.span.end } };
      }
      case 'ident':
        this.advance();
        return { kind: 'ident', name: tok.value, span: tok.span };
      case 'lparen': {
        this.advance();
        const expr = this.parseExpr();
        const end = this.expect('rparen').span;
        return { ...expr, span: { ...expr.span, end: end.end } };
      }
      case 'lbracket': {
        this.advance();
        const elements: Expr[] = [];
        this.skipNewlines();
        while (!this.at('rbracket')) {
          elements.push(this.parseExpr());
          this.skipNewlines();
          if (!this.match('comma')) break;
          this.skipNewlines();
        }
        const end = this.expect('rbracket').span;
        return { kind: 'array', elements, span: { ...tok.span, end: end.end } };
      }
      case 'lbrace': {
        this.advance();
        const entries: { key: Expr; value: Expr }[] = [];
        this.skipNewlines();
        while (!this.at('rbrace')) {
          let key: Expr;
          if (this.at('string')) {
            key = this.stringFromToken(this.advance());
          } else {
            const kt = this.expect('ident');
            key = { kind: 'string', parts: [{ kind: 'text', text: kt.value }], span: kt.span };
          }
          this.expect('colon');
          const value = this.parseExpr();
          entries.push({ key, value });
          this.skipNewlines();
          if (!this.match('comma')) break;
          this.skipNewlines();
        }
        const end = this.expect('rbrace').span;
        return { kind: 'map', entries, span: { ...tok.span, end: end.end } };
      }
      default:
        this.error('NOVA2004', `expected expression, found '${tok.value || tok.type}'`, tok.span);
        throw new ParsePanic();
    }
  }

  /** Convert a string token into a StrLit by parsing interpolation tokens. */
  private stringFromToken(tok: Token): Expr {
    const parts = (tok.parts ?? []).map((p) => {
      if (p.kind === 'text') return p;
      const sub = new Parser(tokensToSource(p.tokens), this.file);
      const expr = sub.parseExpr();
      return { kind: 'interp' as const, expr };
    });
    return { kind: 'string', parts, span: tok.span };
  }

  // helpers -----------------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peekAhead(offset: number): Token {
    return this.tokens[this.idx + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private prev(): Token {
    return this.tokens[Math.max(0, this.idx - 1)]!;
  }

  private at(type: string): boolean {
    return this.peek().type === type;
  }

  private match(type: string): boolean {
    if (this.at(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): Token {
    const tok = this.peek();
    if (this.idx < this.tokens.length - 1) this.idx++;
    return tok;
  }

  private expect(type: string): Token {
    if (this.at(type)) return this.advance();
    const tok = this.peek();
    this.error('NOVA2001', `expected '${type}', found '${tok.value || tok.type}'`, tok.span);
    throw new ParsePanic();
  }

  private skipNewlines(): void {
    while (this.at('newline')) this.advance();
  }

  /** Consume the end of a statement: a newline, `}` or EOF. */
  private endStatement(): void {
    if (this.at('newline')) {
      this.advance();
      return;
    }
    if (this.at('rbrace') || this.at('eof')) return;
    const tok = this.peek();
    this.error('NOVA2005', `expected newline after statement, found '${tok.value || tok.type}'`, tok.span);
    throw new ParsePanic();
  }

  private error(code: string, message: string, span: { start: number; end: number; line: number; col: number }): void {
    this.diagnostics.push({
      code, severity: 'error', message,
      span: { file: this.file, ...span },
    });
  }


  // blocks ------------------------------------------------------------------

  private parseBlock(): Block {
    const start = this.expect('lbrace').span;
    this.skipNewlines();
    const stmts: Stmt[] = [];
    while (!this.at('rbrace') && !this.at('eof')) {
      try {
        stmts.push(this.parseStmt());
      } catch (e) {
        if (e instanceof ParsePanic) this.synchronize();
        else throw e;
      }
      this.skipNewlines();
    }
    const end = this.at('rbrace') ? this.advance().span : this.peek().span;
    return { stmts, span: { ...start, end: end.end } };
  }

  // more decls --------------------------------------------------------------

  private parseEnum(): Decl {
    const start = this.expect('enum').span;
    const name = this.expect('ident').value;
    this.expect('lbrace');
    this.skipNewlines();
    const variants = [];
    while (!this.at('rbrace')) {
      const vStart = this.advance().span;
      variants.push({ name: this.prev().value, span: vStart });
      this.skipNewlines();
      this.match('comma'); // separators are newlines or commas
      this.skipNewlines();
    }
    const end = this.expect('rbrace').span;
    return { kind: 'enum', name, variants, exported: false, span: { ...start, end: end.end } };
  }

  private parseConst(): Decl {
    const start = this.expect('const').span;
    const name = this.expect('ident').value;
    let annot: TypeExpr | undefined;
    if (this.match('colon')) annot = this.parseType();
    this.expect('eq');
    const value = this.parseExpr();
    this.endStatement();
    const span = { ...start, end: this.prev().span.end };
    return { kind: 'const', name, annot, value, exported: false, span };
  }

  private parseTest(): Decl {
    const start = this.expect('test').span;
    const name = this.expect('string').value;
    const body = this.parseBlock();
    return {
      kind: 'test', name: JSON.parse(name), body,
      span: { ...start, end: body.span.end },
    };
  }

  private parseUse(): Decl {
    const start = this.expect('use').span;
    const path = this.expect('string').value;
    this.endStatement();
    return { kind: 'use', path: JSON.parse(path), span: { ...start, end: this.prev().span.end } };
  }

  // types -------------------------------------------------------------------

  private parseType(): TypeExpr {
    // Function type: `fn(<params>) -> <ret>` (e.g. `fn(Int) -> Int`).
    if (this.at('fn')) {
      const start = this.advance().span;
      this.expect('lparen');
      const params: TypeExpr[] = [];
      this.skipNewlines();
      while (!this.at('rparen')) {
        params.push(this.parseType());
        this.skipNewlines();
        if (!this.match('comma')) break;
        this.skipNewlines();
      }
      this.expect('rparen');
      this.expect('arrow');
      const ret = this.parseType();
      return { kind: 'func', params, ret, span: { ...start, end: ret.span.end } };
    }
    const tok = this.expect('ident');
    const span = { ...tok.span };
    let t: TypeExpr = { kind: 'named', name: tok.value, args: [], span };
    if (this.at('lt')) {
      this.advance();
      const args: TypeExpr[] = [];
      this.skipNewlines();
      while (!this.at('gt')) {
        args.push(this.parseType());
        this.skipNewlines();
        if (!this.match('comma')) break;
        this.skipNewlines();
      }
      this.expect('gt');
      t = { kind: 'named', name: tok.value, args, span: { ...span, end: this.prev().span.end } };
    }
    if (this.at('question')) {
      this.advance();
      t = { kind: 'optional', inner: t, span: { ...t.span, end: this.prev().span.end } };
    }
    return t;
  }

  /** Skip to the next statement boundary after a parse failure. */
  private synchronize(): void {
    while (!this.at('eof')) {
      if (this.match('newline')) return;
      if (this.match('rbrace')) return;
      this.advance();
    }
  }
}

/** Render interpolation tokens back to source for sub-parsing. */
function tokensToSource(tokens: Token[]): string {
  return tokens.map((t) => t.value).join(' ');
}

/** Internal control-flow signal for error recovery. */
export class ParsePanic extends Error {}
