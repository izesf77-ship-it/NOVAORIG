/**
 * Process-level control-flow signals for the interpreters.
 *
 * `exit(code)` and `panic(message)` terminate a NOVA program. Native binaries
 * realize this with ExitProcess; the interpreters realize it with these
 * signals, which their top-level run() handlers turn into the same observable
 * behavior (exit code + stderr message) without killing the host process.
 */

/** Thrown by `exit(code)`; carries the requested process exit code. */
export class NovaExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.name = 'NovaExitSignal';
    this.code = code;
  }
}

/** Thrown by `panic(message)`; prints to stderr and exits with code 1. */
export class NovaPanicSignal extends Error {
  readonly panicMessage: string;
  constructor(message: string) {
    super(`panic: ${message}`);
    this.name = 'NovaPanicSignal';
    this.panicMessage = message;
  }
}
