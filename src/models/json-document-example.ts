// This is just an example of how schema and repository should be implemented
// with a schema-driven approach (validation (ArkType, Valibot, ...), type inference, and safe data access)
import { JsonGetOptions } from '@redis/json/dist/lib/commands/GET';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { RedisClientType } from 'redis';

// Properly normalize array brackets into dot segments (e.g., "items.0.name")
type NormalizePath<P extends string> = P extends `${infer Head}[${infer Index}].${infer Tail}`
  ? NormalizePath<`${Head}.${Index}.${Tail}`>
  : P extends `${infer Head}[${infer Index}]`
    ? NormalizePath<`${Head}.${Index}`>
    : P;

// Strip standard Redis JSONPath prefixes like "\$." or "/"
type CleanPath<P extends string> = P extends `$.${infer R}`
  ? NormalizePath<R>
  : P extends `/${infer R}`
    ? NormalizePath<R>
    : NormalizePath<P>;

// Resolve keys against objects, index specific arrays, OR map across arrays of objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Step<T, Key extends string> = T extends any[]
  ? Key extends `${number}`
    ? T[number] // Direct specific array item indexing
    : T[number] extends infer Item // Inline block: Extract the array's object shape
      ? Key extends keyof Item
        ? Item[Key][]
        : unknown // Map string keys across array of objects -> fields[]
      : unknown
  : Key extends keyof T
    ? T[Key] // Standard object property lookup
    : unknown;

// Recursive engine walking down the cleaned string array segments
type ResolvePath<T, P extends string> = P extends `${infer Head}.${infer Tail}`
  ? ResolvePath<Step<T, Head>, Tail>
  : Step<T, P>;

// Final public entry point helper
export type GetPathType<T, P extends string | undefined> = P extends string
  ? CleanPath<P> extends ''
    ? T
    : ResolvePath<T, CleanPath<P>>
  : T;

export class RedisJsonClient<TSchema extends StandardSchemaV1> {
  #client: RedisClientType; // Your underlying Redis Client
  #schema: TSchema;

  constructor(client: RedisClientType, schema: TSchema) {
    this.#client = client;
    this.#schema = schema;
  }

  /**
   * Fetches a JSON Document or a specific path from Redis by its id.
   */
  async fetch<P extends string | undefined = undefined>(
    key: string,
    options?: JsonGetOptions & { path?: P }
  ): Promise<null | GetPathType<StandardSchemaV1.InferOutput<TSchema>, P>> {
    const rawData = await this.#client.json.get(key, options);
    if (rawData === null) return null;

    // eslint-disable-next-line no-useless-escape
    if (options?.path && options.path !== '\$') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rawData as any;
    }

    const result = await this.#schema['~standard'].validate(rawData);
    if (result.issues) {
      throw new Error(`RedisJSON Validation failed: ${JSON.stringify(result.issues)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.value as any;
  }
}

/**
// Example usage of RedisJsonClient:

import { type } from 'arktype';
import { createClient } from 'redis';

const complexSchema = type({
  id: "string",
  orders: [{
    orderId: "string",
    skus: "string[]",
    details: { totalPrice: "number" }
  }]
});

const client = new RedisJsonClient(createClient(), complexSchema);

const id = await client.fetch("user:99", { path: "$.id" });

// Example 1: Extract an entire array of objects
const orders = await client.fetch("user:99", { path: "$.orders" });
// Type inferred as: { orderId: string; skus: string[]; details: { totalPrice: number }; }[] | null

// Example 2: Index an array item using index notation
const firstOrder = await client.fetch("user:99", { path: "$.orders[0]" });
// Type inferred as: { orderId: string; skus: string[]; details: { totalPrice: number }; } | null

// Example 3: Deep navigation inside an array of objects
const price = await client.fetch("user:99", { path: "$.orders[0].details.totalPrice" });
// Type inferred as: number | null

// Example 4: Mixed string dot-index notation
const sku = await client.fetch("user:99", { path: "$.orders.0.skus.1" });
// Type inferred as: string | null

 */
