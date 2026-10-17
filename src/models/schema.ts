import { InvalidKeyError, ValidationError } from './errors';
import type { OperationGuard } from './guard';
import type { GetPathType } from './path-type';
import type { RedisVariadicArgument } from '@redis/client/dist/lib/commands/generic-transformers';
import type { JsonDelOptions } from '@redis/json/dist/lib/commands/DEL';
import type { JsonGetOptions } from '@redis/json/dist/lib/commands/GET';
import type { JsonSetOptions } from '@redis/json/dist/lib/commands/SET';
import type { CreateOptions } from '@redis/search/dist/lib/commands/CREATE';
import type { FtDropIndexOptions } from '@redis/search/dist/lib/commands/DROPINDEX';
import type { StandardSchemaV1 } from '@standard-schema/spec';
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

function toValidPrefix(prefix: string): string {
  if (typeof prefix === 'string' && prefix !== '') return prefix;
  throw new InvalidKeyError(prefix);
}

function toValidId(id: RedisArgument): RedisArgument {
  if (typeof id === 'string' ? id !== '' : id instanceof Buffer && id.length > 0) return id;
  throw new InvalidKeyError(id);
}

function displayKey(key: RedisArgument): string {
  return typeof key === 'string' ? key : `hex:${key.toString('hex')}`;
}

function isRootPath(path: RedisVariadicArgument): boolean {
  return (typeof path === 'string' || path instanceof Buffer) && path.toString() === '$';
}

/**
 * Represents the search options for creating a RediSearch index.
 * Excludes the 'ON' and 'PREFIX' options, which are automatically set by the schema (ON: 'JSON', PREFIX: prefix)
 */
export type SanitizedSearchOptions = Omit<CreateOptions, 'ON' | 'PREFIX'>;

export type JsonDocument<TSchema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<TSchema> &
  Record<string, RedisJSON>;

/**
 * Represents a schema for JSON Documents stored in Redis.
 */
export class Schema<TSchema extends StandardSchemaV1> {
  #prefix: string;
  #schema: TSchema;
  #searchSchema: RediSearchSchema;
  #options?: SanitizedSearchOptions | undefined;

  get prefix(): string {
    return this.#prefix;
  }

  /**
   * Creates a new schema for JSON Documents stored in Redis.
   *
   * @param prefix the prefix to use for Redis keys
   * @param schema the TypeScript schema definition for the JSON Documents
   * @param searchSchema the RediSearch schema definition for the JSON Documents
   * @param options additional options for creating the index
   */
  constructor(
    prefix: string,
    schema: TSchema,
    searchSchema: RediSearchSchema,
    options?: SanitizedSearchOptions | undefined
  ) {
    this.#prefix = toValidPrefix(prefix);
    this.#schema = schema;
    this.#searchSchema = searchSchema;
    this.#options = options;
  }

  /**
   * Creates the index for the JSON Documents in Redis.
   * @param client the Redis client to use for creating the index
   */
  async createIndex(client: RedisClientType | RedisClientPoolType): Promise<void> {
    try {
      await client.ft.create('idx:' + this.#prefix, this.#searchSchema, {
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

  async validate(
    value: unknown,
    options?: StandardSchemaV1.Options | undefined
  ): Promise<StandardSchemaV1.Result<unknown>> {
    return await this.#schema['~standard'].validate(value, options);
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
  ): Repository<TSchema> {
    return new Repository<TSchema>(client as RedisClientType<M, F, S> | RedisClientPoolType<M, F, S>, this, guard);
  }
}

/**
 * Represents a repository for JSON Documents stored in Redis.
 * Provides methods to save, fetch, and remove JSON Documents, as well as create the index.
 */
export class Repository<TSchema extends StandardSchemaV1> {
  #client: RedisClientType | RedisClientPoolType;
  #schema: Schema<TSchema>;
  #guard?: OperationGuard;

  constructor(client: RedisClientType | RedisClientPoolType, schema: Schema<TSchema>, guard?: OperationGuard) {
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
   * Computes the full Redis key for a JSON Document based on its id.
   * @param id the id of the JSON Document
   * @returns the full Redis key for the JSON Document
   */
  fullKey(id: RedisArgument): RedisArgument {
    const validId = toValidId(id);
    const prefix = `${this.#schema.prefix}:`;
    return typeof validId === 'string' ? prefix + validId : Buffer.concat([Buffer.from(prefix), validId]);
  }

  /**
   * Removes a JSON Document from Redis.
   *
   * @param id the id of the JSON Document to remove
   * @param options optional JSON.DEL command options
   * @returns the number of keys that were removed
   */
  async remove(id: RedisArgument, options?: JsonDelOptions | undefined): Promise<number> {
    const key = this.fullKey(id);
    return await this.exec(() => this.#client.json.del(key, options));
  }

  /**
   * Saves a JSON Document to Redis.
   *
   * @param id the id of the JSON Document to save
   * @param value the JSON Document to save
   * @param options optional JSON.SET command options
   * @returns the result of the Redis JSON.SET command
   * @throws ValidationError if the JSON Document does not conform to the schema
   */
  async save(
    id: RedisArgument,
    value: JsonDocument<TSchema>,
    options?: JsonSetOptions | undefined
  ): Promise<'OK' | null> {
    const key = this.fullKey(id);
    const result = await this.#schema.validate(value);
    if (result.issues) {
      throw new ValidationError(`RedisJSON Validation failed at save for key: ${displayKey(key)}`, result.issues);
    }
    return await this.exec(() => this.#client.json.set(key, '$', result.value as JsonDocument<TSchema>, options));
  }

  /**
   * Sets the whole JSON Document (root path `$`), like {@link Repository.save}.
   * The value is validated against the schema before being written.
   *
   * @param id the id of the JSON Document to set
   * @param value the JSON Document to set
   * @param options optional JSON.SET command options
   * @returns the result of the Redis JSON.SET command
   * @throws ValidationError if the JSON Document does not conform to the schema
   */
  async set(
    id: RedisArgument,
    value: JsonDocument<TSchema>,
    options?: JsonSetOptions | undefined
  ): Promise<'OK' | null>;
  /**
   * Sets the value at a given path of a JSON Document.
   * Validation against the schema is only performed when `path` is the root (`$`);
   * values written to any other path are sent to Redis as is.
   *
   * @param id the id of the JSON Document to modify
   * @param path the JSONPath where to set the value
   * @param value the value to set at `path`
   * @param options optional JSON.SET command options
   * @returns the result of the Redis JSON.SET command
   * @throws ValidationError if `path` is the root and the JSON Document does not conform to the schema
   */
  async set(
    id: RedisArgument,
    path: RedisArgument,
    value: JsonDocument<TSchema>,
    options?: JsonSetOptions | undefined
  ): Promise<'OK' | null>;
  async set(
    id: RedisArgument,
    pPath: RedisArgument | JsonDocument<TSchema>,
    pValue?: JsonSetOptions | JsonDocument<TSchema> | undefined,
    pOptions?: JsonSetOptions | undefined
  ): Promise<'OK' | null> {
    const key = this.fullKey(id);
    let path: RedisArgument = '$';
    let value: JsonDocument<TSchema>;
    let options: JsonSetOptions | undefined;
    if (typeof pOptions === 'undefined') {
      if (typeof pValue === 'undefined') {
        value = pPath as JsonDocument<TSchema>;
      } else if (typeof pPath === 'string' || pPath instanceof Buffer) {
        path = pPath;
        value = pValue as JsonDocument<TSchema>;
        options = pOptions;
      } else {
        value = pPath as JsonDocument<TSchema>;
        options = pValue as JsonSetOptions | undefined;
      }
    } else {
      path = pPath as RedisArgument;
      value = pValue as JsonDocument<TSchema>;
      options = pOptions;
    }

    if (!isRootPath(path)) {
      return await this.exec(() => this.#client.json.set(key, path, value, options));
    }

    const result = await this.#schema.validate(value);
    if (result.issues) {
      throw new ValidationError(`RedisJSON Validation failed at save for key: ${displayKey(key)}`, result.issues);
    }

    return await this.exec(() => this.#client.json.set(key, path, result.value as JsonDocument<TSchema>, options));
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
   * @param options optional FT.DROPINDEX command options
   * @returns the number of indexes that were dropped
   */
  async dropIndex(options?: FtDropIndexOptions | undefined): Promise<number> {
    return await this.exec(() => this.#client.ft.dropIndex('idx:' + this.#schema.prefix, options));
  }

  /**
   * Fetches a JSON Document from Redis by its id.
   * @param id the id of the JSON Document to fetch
   * @param options optional JSON.GET command options
   * @returns the JSON Document if found, otherwise null
   * @throws ValidationError if the JSON Document does not conform to the schema
   */
  async fetch<P extends RedisVariadicArgument | undefined = undefined>(
    id: RedisArgument,
    options?: (JsonGetOptions & { path?: P }) | undefined
  ): Promise<null | GetPathType<JsonDocument<TSchema>, P>> {
    const key = this.fullKey(id);
    return await this.exec(async () => {
      const rawData = await this.#client.json.get(key, options);
      if (rawData === null) return null;

      if (options?.path && !isRootPath(options.path)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return rawData as any;
      }

      const result = await this.#schema.validate(rawData);
      if (result.issues) {
        throw new ValidationError(`RedisJSON Validation failed at fetch for key: ${displayKey(key)}`, result.issues);
      }

      return result.value;
    });
  }

  /**
   * Sets the expiration time for a given JSON Document in Redis.
   * @param id the id of the JSON Document to set expiration on
   * @param seconds Number of seconds until key expiration
   * @param mode  Expiration mode: NX (only if key has no expiry), XX (only if key has existing expiry), GT (only if new expiry is greater than current), LT (only if new expiry is less than current)
   */
  async expire(id: RedisArgument, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT' | undefined): Promise<number> {
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
