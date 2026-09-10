import type { Span2, StringPart, Token, TokenType } from './token.ts';
import { KEYWORD_TOKEN_TYPES, KEYWORDS } from './token.ts';
import { NovaCompileError } from '../diagnostics/diagnostics.ts';
import type { Diagnostic } from '../diagnostics/diagnostics.ts';

/**
 * The NOVA lexer.
 *
 * Newlines are significant (statement terminators), comments are `//` and
 * block comments, strings support `{expr}` interpolation (recursively lexed).
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly tokens: Token[] = [];
  private diagnostics: Diagnostic[] = [];

  private readonly source: string;
  private readonly file: string;

  constructor(source: string, file: string) {
    this.source = source;
    this.file = file;
  }

  /** Tokenize. Collects all lexical errors instead of failing on the first. */
  lex(): { tokens: Token[]; diagnostics: Diagnostic[] } {
    this.diagnostics = [];
    this.tokens.length = 0;
    while (this.pos < this.source.length) {
      const start = this.pos;
      const ch = this.source[this.pos]!;

      if (ch === '\n') {
        this.advance();
        this.push('newline', '\n', this.span(start));
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
        continue;
      }
      if (ch === '/' && this.peek(1) === '/') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.advance();
        continue;
      }
      if (ch === '/' && this.peek(1) === '*') {
        this.blockComment();
        continue;
      }
      if (isDigit(ch)) {
        this.number();
        continue;
      }
      if (ch === '"') {
        this.string();
        continue;
      }
      if (isIdentStart(ch)) {
        this.identifier();
        continue;
      }
      if (this.operator()) continue;

      this.error('NOVA1001', `unexpected character '${ch}'`, this.span(start));
      this.advance();
    }
    this.push('eof', '', this.span(this.pos));
    if (this.diagnostics.length > 0) {
      throw new NovaCompileError(this.diagnostics);
    }
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // ---------------------------------------------------------------- internals

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? '';
  }

  private advance(): string {
    const ch = this.source[this.pos]!;
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private span(start: number): Span2 {
    // Recompute line/col at `start` by scanning (cheap for typical files).
    let line = 1;
    let col = 1;
    for (let i = 0; i < start && i < this.source.length; i++) {
      if (this.source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { start, end: this.pos, line, col };
  }

  private push(type: TokenType, value: string, span: Span2, parts?: StringPart[]): void {
    this.tokens.push({ type, value, span, parts });
  }

  private error(code: string, message: string, span: Span2): void {
    this.diagnostics.push({
      code, severity: 'error', message,
      span: { file: this.file, ...span },
    });
  }

  private blockComment(): void {
    const start = this.pos;
    this.advance(); // '/'
    this.advance(); // '*'
    while (this.pos < this.source.length) {
      if (this.source[this.pos] === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        return;
      }
      this.advance();
    }
    this.error('NOVA1002', 'unterminated block comment', this.span(start));
  }

  private number(): void {
    const start = this.pos;
    let isFloat = false;
    while (isDigit(this.peek())) this.advance();
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      isFloat = true;
      this.advance();
      while (isDigit(this.peek())) this.advance();
    }
    const text = this.source.slice(start, this.pos);
    this.push(isFloat ? 'float' : 'int', text, this.span(start));
  }

  private string(): void {
    const start = this.pos;
    this.advance(); // opening quote
    const parts: StringPart[] = [];
    let text = '';

    while (true) {
      if (this.pos >= this.source.length || this.peek() === '\n') {
        this.error('NOVA1003', 'unterminated string literal', this.span(start));
        break;
      }
      const ch = this.peek();
      if (ch === '"') {
        this.advance();
        break;
      }
      if (ch === '\\') {
        this.advance();
        const esc = this.peek();
        const decoded = esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r'
          : esc === '"' ? '"' : esc === '\\' ? '\\' : null;
        if (decoded === null) {
          this.error('NOVA1004', `invalid escape sequence '\\${esc}'`, this.span(this.pos));
        } else {
          text += decoded;
          this.advance();
        }
        continue;
      }
      if (ch === '{' && this.peek(1) !== '{') {
        if (text) parts.push({ kind: 'text', text });
        text = '';
        parts.push({ kind: 'interp', tokens: this.interpolation() });
        continue;
      }
      if (ch === '{' && this.peek(1) === '{') {
        text += '{';
        this.advance();
        this.advance();
        continue;
      }
      text += this.advance();
    }
    if (text) parts.push({ kind: 'text', text });

    const span = this.span(start);
    const raw = this.source.slice(start, span.end);
    this.push('string', raw, span, parts);
  }

  /**
   * Lex the contents of a `{...}` interpolation in place and return its tokens
   * (without the surrounding braces). Nested braces are respected.
   */
  private interpolation(): Token[] {
    const openStart = this.pos;
    this.advance(); // '{'
    const inner: string[] = [];
    let depth = 1;
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      inner.push(this.advance());
    }
    if (depth !== 0) {
      this.error('NOVA1005', 'unterminated interpolation in string literal', this.span(openStart));
      return [];
    }
    this.advance(); // closing '}'

    const innerSource = inner.join('');
    const { tokens } = new Lexer(innerSource, this.file).lex();
    return tokens.filter((t) => t.type !== 'newline' && t.type !== 'eof');
  }

  private identifier(): void {
    const start = this.pos;
    while (isIdentPart(this.peek())) this.advance();
    const text = this.source.slice(start, this.pos);
    const keywordType = KEYWORDS.has(text) ? KEYWORD_TOKEN_TYPES[text] : undefined;
    if (keywordType) {
      this.push(keywordType, text, this.span(start));
    } else {
      this.push('ident', text, this.span(start));
    }
  }

  private operator(): boolean {
    const start = this.pos;
    const two = this.peek() + this.peek(1);
    const twoChar: Record<string, TokenType> = {
      '==': 'eqeq', '!=': 'neq', '<=': 'le', '>=': 'ge', '->': 'arrow', '=>': 'fatarrow',
    };
    const t2 = twoChar[two];
    if (t2) {
      this.advance();
      this.advance();
      this.push(t2, two, this.span(start));
      return true;
    }
    const oneChar: Record<string, TokenType> = {
      '+': 'plus', '-': 'minus', '*': 'star', '/': 'slash', '%': 'percent',
      '=': 'eq', '<': 'lt', '>': 'gt', '!': 'not_', '?': 'question',
      '.': 'dot', ',': 'comma', ':': 'colon', '|': 'pipe',
      '(': 'lparen', ')': 'rparen', '{': 'lbrace', '}': 'rbrace',
      '[': 'lbracket', ']': 'rbracket',
    };
    const t1 = oneChar[this.peek()];
    if (t1) {
      const ch = this.advance();
      this.push(t1, ch, this.span(start));
      return true;
    }
    return false;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Convenience helper for tests and tooling. */
export function tokenize(source: string, file = '<input>'): Token[] {
  return new Lexer(source, file).lex().tokens;
}

