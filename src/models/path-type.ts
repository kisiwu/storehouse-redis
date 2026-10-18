import type { RedisVariadicArgument } from '@redis/client/dist/lib/commands/generic-transformers';
import type { RedisClientType } from 'redis';

// Properly normalize array brackets into dot segments (e.g., "items.0.name")
type NormalizePath<P extends string> = P extends `${infer Head}[${infer Index}].${infer Tail}`
  ? NormalizePath<`${Head}.${Index}.${Tail}`>
  : P extends `${infer Head}[${infer Index}]`
    ? NormalizePath<`${Head}.${Index}`>
    : P;

// Strip standard Redis JSONPath prefixes like "$", "$.", ".", or "/"
type StripPrefix<N extends string> = N extends '$' | '.'
  ? ''
  : N extends `$.${infer R}`
    ? R
    : N extends `.${infer R}`
      ? R
      : N extends `/${infer R}`
        ? R
        : N;

// CleanPath combines normalization of array brackets and stripping of standard Redis JSONPath prefixes.
type CleanPath<P extends string> = StripPrefix<NormalizePath<P>>;

// Resolve keys against objects, index specific arrays, OR map across arrays of objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Step<T, Key extends string> = T extends any[]
  ? Key extends `${number}`
    ? T[number]
    : unknown
  : Key extends keyof T
    ? T[Key]
    : unknown;

// Recursive engine walking down the cleaned string array segments
type ResolvePath<T, P extends string> = P extends `${infer Head}.${infer Tail}`
  ? ResolvePath<Step<T, Head>, Tail>
  : Step<T, P>;

// Determines if a path contains indefinite or wildcard segments (like "..", "*", "?", ":", ",")
type IsIndefinite<P extends string> = P extends
  `${string}..${string}` | `${string}*${string}` | `${string}?${string}` | `${string}:${string}` | `${string},${string}`
  ? true
  : false;

// Resolves a path after it has been cleaned (normalized and stripped of prefixes).
type ResolveClean<T, C extends string> = C extends '' ? T : ResolvePath<T, C>;

/**
 * Utility types for resolving the type of a JSON path within a Redis JSON document.
 */
export type JsonGetResult = Awaited<ReturnType<RedisClientType['json']['get']>>;

/**
 * Resolves the TypeScript type corresponding to a given JSON path within a Redis JSON document.
 */
export type GetPathType<T, P extends RedisVariadicArgument | undefined> = P extends undefined
  ? T
  : P extends string
    ? P extends `$${string}`
      ? IsIndefinite<P> extends true
        ? unknown[]
        : ResolveClean<T, CleanPath<P>>[]
      : ResolveClean<T, CleanPath<P>>
    : JsonGetResult;
