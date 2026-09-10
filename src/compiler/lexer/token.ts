/**
 * NOVA tokens.
 *
 * Tokens are plain tagged objects (no classes) so they are cheap to create,
 * trivially serializable to JSON, and safe under Node's erasable-TS-only
 * type stripping.
 */

export type TokenType =
  // literals & identifiers
  | 'int'
  | 'float'
  | 'string'
  | 'ident'
  // keywords
  | 'fn'
  | 'struct'
  | 'enum'
  | 'const'
  | 'let'
  | 'type'
  | 'if'
  | 'else'
  | 'while'
  | 'for'
  | 'in'
  | 'return'
  | 'match'
  | 'test'
  | 'use'
  | 'pub'
  | 'break'
  | 'continue'
  | 'true'
  | 'false'
  | 'null'
  | 'ok'
  | 'error'
  | 'some'
  | 'none'
  | 'and'
  | 'or'
  | 'not'
  // operators & punctuation
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'percent'
  | 'eq'
  | 'eqeq'
  | 'neq'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'not_'
  | 'arrow'
  | 'fatarrow'
  | 'pipe'
  | 'question'
  | 'dot'
  | 'comma'
  | 'colon'
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'lbracket'
  | 'rbracket'
  // trivia
  | 'newline'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw source text of the token. */
  value: string;
  span: Span2;
  /** For string tokens: parts with embedded interpolation token streams. */
  parts?: StringPart[];
}

export interface Span2 {
  start: number;
  end: number;
  line: number;
  col: number;
}

export type StringPart =
  | { kind: 'text'; text: string }
  | { kind: 'interp'; tokens: Token[] };

export const KEYWORDS: ReadonlySet<string> = new Set([
  'fn', 'struct', 'enum', 'const', 'let', 'type', 'if', 'else', 'while', 'for',
  'in', 'return', 'match', 'test', 'use', 'true', 'false', 'null',
  'ok', 'error', 'some', 'none', 'and', 'or', 'not', 'pub', 'break', 'continue',
]);

export const KEYWORD_TOKEN_TYPES: Readonly<Record<string, TokenType>> = {
  fn: 'fn', struct: 'struct', enum: 'enum', const: 'const', let: 'let', type: 'type',
  if: 'if', else: 'else', while: 'while', for: 'for', in: 'in',
  return: 'return', match: 'match', test: 'test', use: 'use',
  true: 'true', false: 'false', null: 'null', ok: 'ok', error: 'error',
  some: 'some', none: 'none',
  and: 'and', or: 'or', not: 'not', pub: 'pub', break: 'break', continue: 'continue',
};
