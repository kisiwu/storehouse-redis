import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Thrown when the Redis server is unavailable.
 */
export class ServerUnavailableError extends Error {
  constructor(reason: string) {
    super(`Redis server unavailable: ${reason}`);
    this.name = 'ServerUnavailableError';
  }
}

/**
 * Thrown when a Redis command takes longer than the specified timeout.
 * This helps prevent the application from hanging indefinitely due to slow Redis responses.
 */
export class CommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis command timed out after ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
  }
}

/**
 * Thrown when a value cannot be turned into a valid Redis key: null,
 * undefined, empty string, or an empty buffer.
 */
export class InvalidKeyError extends Error {
  constructor(key: unknown) {
    const shown =
      key instanceof Buffer && key.length === 0
        ? 'empty buffer'
        : key === ''
          ? 'empty string'
          : key === null || key === undefined
            ? String(key)
            : typeof key;
    super(`Invalid key: ${shown}`);
    this.name = 'InvalidKeyError';
  }
}

export class ValidationError extends Error {
  readonly issues?: readonly StandardSchemaV1.Issue[];

  constructor(message: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`ValidationError: ${message}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
