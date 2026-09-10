/**
 * Native backend error type.
 *
 * Codes:
 *   NOVA1001 — native toolchain unavailable (LLVM/linker/SDK missing)
 *   NOVA2001 — LLVM backend cannot lower this construct yet
 */

export class NovaNativeError extends Error {
  readonly code: string;

  constructor(code: 'NOVA1001' | 'NOVA2001', message: string) {
    super(`${code} ${message}`);
    this.code = code;
    this.name = 'NovaNativeError';
  }

  /** Human-friendly multi-line diagnostic for `nova build --native`. */
  format(): string {
    const [code, ...rest] = this.message.split(' ');
    const msg = rest.join(' ');
    switch (this.code) {
      case 'NOVA1001':
        return msg.startsWith('Target:')
          ? `${code} Native toolchain unavailable\n\n${msg}`
          : `${code} Native toolchain unavailable\n\n  Target: x86_64-pc-windows-msvc\n\n  ${msg}`;
      case 'NOVA2001':
        return `${code} LLVM backend cannot lower this program\n\n  ${msg}`;
      default:
        return this.message;
    }
  }
}