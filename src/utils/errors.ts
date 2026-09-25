/** Base class for every error this package throws intentionally. */
export class RedisDumperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RedisDumperError';
    this.code = code;
  }
}

/** Thrown when an operation stops because its `AbortSignal` was triggered. */
export class OperationCancelledError extends RedisDumperError {
  constructor(message = 'The operation was cancelled') {
    super('operation-cancelled', message);
    this.name = 'OperationCancelledError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

/**
 * True for both cancellation shapes this package can observe: its own
 * {@link OperationCancelledError} and the `DOMException` an `AbortSignal`
 * (or a Node stream aborted through one) raises.
 */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'OperationCancelledError')
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
