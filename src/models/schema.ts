import { InvalidKeyError } from './errors';
import type { OperationGuard } from './guard';
import type { CreateOptions } from '@redis/search/dist/lib/commands/CREATE';
import type {
  RediSearchSchema,
  RedisJSON,
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
  TypeMapping,
  RespVersions,
  FtSearchOptions,
  RedisArgument,
  RedisClientPoolType,
} from 'redis';

/**
 * Converts a value into a valid string for use in Redis keys.
 * Accepts non-empty strings, numbers, and objects with a meaningful string form.
 * Throws InvalidKeyError for invalid values.
 */
function toValidKey(id: unknown): string {
  if (typeof id === 'string') {
    if (id !== '') {
      return id;
    }
  } else if (typeof id === 'number' || typeof id === 'bigint') {
    return String(id);
  } else if (id !== null && typeof id === 'object') {
    const value =
      typeof (id as { toHexString?: unknown }).toHexString === 'function'
        ? (id as { toHexString: () => string }).toHexString()
        : String(id);
    if (value !== '' && !value.startsWith('[object ')) {
      return value;
    }
  }
  throw new InvalidKeyError(id);
}

/**
 * Represents the search options for creating a RediSearch index.
 * Excludes the 'ON' and 'PREFIX' options, which are automatically set by the schema (ON: 'JSON', PREFIX: prefix)
 */
export type SanitizedSearchOptions = Omit<CreateOptions, 'ON' | 'PREFIX'>;

/**
 * Represents a schema for JSON Documents stored in Redis.
 */
export class Schema<TS extends Record<string, RedisJSON> = Record<string, RedisJSON>> {
  #prefix: string;
  #schema: RediSearchSchema;
  #options?: SanitizedSearchOptions | undefined;

  get prefix(): string {
    return this.#prefix;
  }

  /**
   * Creates a new schema for JSON Documents stored in Redis.
   *
   * @param prefix the prefix to use for Redis keys
   * @param schema the RediSearch schema definition for the JSON Documents
   * @param options additional options for creating the index
   */
  constructor(prefix: string, schema: RediSearchSchema, options?: SanitizedSearchOptions | undefined) {
    this.#prefix = toValidKey(prefix);
    this.#schema = schema;
    this.#options = options;
  }

  /**
   * Creates the index for the JSON Documents in Redis.
   * @param client the Redis client to use for creating the index
   */
  async createIndex(client: RedisClientType | RedisClientPoolType): Promise<void> {
    try {
      await client.ft.create('idx:' + this.#prefix, this.#schema, {
        ...(this.#options || {}),
        ON: 'JSON',
        PREFIX: this.#prefix,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'Index already exists') {
        //
      } else {
        throw e;
      }
    }
  }

  /**
   * Creates a new repository instance for the schema.
   * @param client the Redis client to use for the repository
   * @param guard an optional operation guard to control Redis operations
   * @returns a new repository instance for the schema
   */
  createRepository<
    M extends RedisModules,
    F extends RedisFunctions,
    S extends RedisScripts,
    R extends RespVersions,
    T extends TypeMapping,
  >(
    client: RedisClientType<M, F, S, R, T> | RedisClientPoolType<M, F, S, R, T>,
    guard?: OperationGuard
  ): Repository<TS> {
    return new Repository<TS>(client as RedisClientType<M, F, S> | RedisClientPoolType<M, F, S>, this, guard);
  }
}

/**
 * Represents a repository for JSON Documents stored in Redis.
 * Provides methods to save, fetch, and remove JSON Documents, as well as create the index.
 */
export class Repository<T extends Record<string, RedisJSON> = Record<string, RedisJSON>> {
  #client: RedisClientType | RedisClientPoolType;
  #schema: Schema<T>;
  #guard?: OperationGuard;

  constructor(client: RedisClientType | RedisClientPoolType, schema: Schema<T>, guard?: OperationGuard) {
    this.#client = client;
    this.#schema = schema;
    this.#guard = guard;
  }

  /**
   * Every Redis command goes through the guard when one is provided.
   */
  private exec<R>(operation: () => Promise<R>): Promise<R> {
    return this.#guard ? this.#guard.run(operation) : operation();
  }

  /**
   * Redis key of an JSON Document.
   */
  fullKey(id: unknown): string {
    return `${this.#schema.prefix}:${toValidKey(id)}`;
  }

  /**
   * Removes a JSON Document from Redis.
   *
   * @param id the id of the JSON Document to remove
   * @returns the number of keys that were removed
   */
  async remove(id: unknown): Promise<number> {
    const key = this.fullKey(id);
    return await this.exec(() => this.#client.json.del(key));
  }

  /**
   * Saves a JSON Document to Redis.
   *
   * @param id the id of the JSON Document to save
   * @param obj the JSON Document to save
   * @returns the result of the Redis JSON.SET command
   */
  async save(id: unknown, obj: T) {
    const key = this.fullKey(id);
    return await this.exec(() => this.#client.json.set(key, '$', obj));
  }

  /**
   * Creates the index for the JSON Documents in Redis.
   * @returns a promise that resolves when the index has been created successfully
   */
  async createIndex(): Promise<void> {
    await this.exec(() => this.#schema.createIndex(this.#client));
  }

  /**
   * Drops the index for the JSON Documents in Redis.
   * @returns a promise that resolves when the index has been dropped successfully
   */
  async dropIndex(): Promise<void> {
    await this.exec(() => this.#client.ft.dropIndex('idx:' + this.#schema.prefix));
  }

  /**
   * Fetches a JSON Document from Redis by its id.
   * @param id the id of the JSON Document to fetch
   * @returns the JSON Document if found, otherwise null
   */
  async fetch(id: unknown): Promise<null | T> {
    const key = this.fullKey(id);
    return (await this.exec(() => this.#client.json.get(key))) as null | T;
  }

  /**
   * Sets the expiration time for a given JSON Document in Redis.
   * @param id the id of the JSON Document to set expiration on
   * @param seconds Number of seconds until key expiration
   * @param mode  Expiration mode: NX (only if key has no expiry), XX (only if key has existing expiry), GT (only if new expiry is greater than current), LT (only if new expiry is less than current)
   */
  async expire(id: unknown, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT' | undefined): Promise<number> {
    const key = this.fullKey(id);
    return await this.exec(() => this.#client.expire(key, seconds, mode));
  }

  /**
   * Searches for JSON Documents in Redis using the specified query and options.
   * @param query the search query to execute
   * @param options optional search options
   * @returns the result of the Redis FT.SEARCH command
   */
  async search(
    query: RedisArgument,
    options?: FtSearchOptions | undefined
  ): Promise<ReturnType<RedisClientType['ft']['search']>> {
    return await this.exec(() => this.#client.ft.search('idx:' + this.#schema.prefix, query, options));
  }
}
