import type { RedisClientHealthCheckResult } from './health';
import { CommandTimeoutError, ServerUnavailableError } from './models/errors';
import type { OperationGuard } from './models/guard';
import type { Repository, Schema } from './models/schema';
import Logger from '@novice1/logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type IManager,
  type ManagerArg,
  Registry,
  ManagerNotFoundError,
  InvalidManagerConfigError,
} from '@storehouse/core';
import { randomBytes } from 'node:crypto';
import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
  type RedisDefaultModules,
  type RedisFunctions,
  type RedisModules,
  type RedisScripts,
  type RespVersions,
  type TypeMapping,
} from 'redis';

const Log = Logger.debugger('@storehouse/redis:manager');

/**
 * Configuration argument for creating a {@link RedisManager} instance.
 *
 * @template M - Redis modules type, defaults to RedisDefaultModules
 * @template F - Redis functions type, defaults to RedisFunctions
 * @template S - Redis scripts type, defaults to RedisScripts
 * @template RESP - Redis RESP protocol version, defaults to 3
 * @template TYPE_MAPPING - Redis type mapping, defaults to TypeMapping
 *
 * @extends ManagerArg
 *
 * @example
 * ```typescript
 * const managerArg: RedisManagerArg = {
 *   name: 'my-redis-manager',
 *   config: {
 *     options: {
 *       url: 'redis://localhost:6379'
 *     }
 *   }
 * };
 * ```
 */
export interface RedisManagerArg<
  M extends RedisModules = RedisDefaultModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
  RESP extends RespVersions = 3,
  TYPE_MAPPING extends TypeMapping = TypeMapping,
> extends ManagerArg {
  /**
   * Optional configuration for the Redis manager.
   */
  config?: {
    /**
     * Redis client connection options.
     * See redis client documentation for available options.
     */
    options?: RedisClientOptions<M, F, S, RESP, TYPE_MAPPING>;
  };
}

/**
 * Retrieves a {@link RedisManager} instance from the registry.
 *
 * @template M - The specific RedisManager type to return, defaults to RedisManager
 *
 * @param registry - The Storehouse registry containing registered managers
 * @param managerName - Optional name of the manager to retrieve. If omitted, retrieves the default manager
 *
 * @returns The requested {@link RedisManager} instance
 *
 * @throws {ManagerNotFoundError} If the manager is not found in the registry
 * @throws {InvalidManagerConfigError} If the manager exists but is not an instance of {@link RedisManager}
 *
 * @example
 * ```typescript
 * const redisManager = getManager(registry, 'redis-manager');
 * await redisManager.connect();
 * ```
 */
export function getManager<M extends RedisManager = RedisManager>(registry: Registry, managerName?: string): M {
  const manager = registry.getManager<M>(managerName);
  if (!manager) {
    throw new ManagerNotFoundError(managerName || registry.defaultManager);
  }
  if (!(manager instanceof RedisManager)) {
    throw new InvalidManagerConfigError(
      `Manager "${managerName || registry.defaultManager}" is not instance of RedisManager`
    );
  }
  return manager;
}

/**
 * Retrieves the underlying Redis client connection from a manager in the registry.
 *
 * @template M - Redis modules type, defaults to RedisDefaultModules
 * @template F - Redis functions type, defaults to RedisFunctions
 * @template S - Redis scripts type, defaults to RedisScripts
 * @template RESP - Redis RESP protocol version, defaults to 3
 * @template TYPE_MAPPING - Redis type mapping, defaults to TypeMapping
 *
 * @param registry - The Storehouse registry containing registered managers
 * @param managerName - Optional name of the manager. If omitted, uses the default manager
 *
 * @returns The Redis client instance
 *
 * @throws {ManagerNotFoundError} If the manager is not found in the registry
 *
 * @example
 * ```typescript
 * const redisClient = getConnection(registry, 'redis-manager');
 * await redisClient.set('key', 'value');
 * const value = await redisClient.get('key');
 * ```
 */
export function getConnection<
  M extends RedisModules = RedisDefaultModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
  RESP extends RespVersions = 3,
  TYPE_MAPPING extends TypeMapping = TypeMapping,
>(registry: Registry, managerName?: string): RedisClientType<M, F, S, RESP, TYPE_MAPPING> {
  const conn = registry.getConnection<RedisClientType<M, F, S, RESP, TYPE_MAPPING>>(managerName);
  if (!conn) {
    throw new ManagerNotFoundError(managerName || registry.defaultManager);
  }
  return conn;
}

export class RedisManager<
  M extends RedisModules = RedisDefaultModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
  RESP extends RespVersions = 3,
  TYPE_MAPPING extends TypeMapping = TypeMapping,
>
  implements IManager, OperationGuard
{
  /**
   * Identifier for the manager type.
   * @readonly
   */
  static readonly type = '@storehouse/redis';

  #connection: RedisClientType<M, F, S, RESP, TYPE_MAPPING>;

  #commandTimeoutMs: number;

  /**
   * The name of this manager instance.
   * @protected
   */
  protected name: string;
  /**
   * Creates a new RedisManager instance.
   *
   * @param settings - Configuration settings for the manager
   *
   * @remarks
   * The connection is created but not opened. You must call `connect()` to establish the connection.
   * Connection events (error, connect, ready, end, reconnecting) are automatically registered and logged.
   */
  constructor(settings: RedisManagerArg<M, F, S, RESP, TYPE_MAPPING>) {
    this.name = settings.name || `Redis ${Date.now()}_${randomBytes(3).toString('hex')}`;
    this.#connection = createClient(settings?.config?.options);
    this.#commandTimeoutMs = settings?.config?.options?.commandOptions?.timeout || 5000;

    this.#registerConnectionEvents();

    Log.info(`[${this.name}] RedisConnection created. Must call "RedisConnection.connect()".`);
  }

  /**
   * Registers event listeners for Redis connection lifecycle events.
   * Logs connection state changes for debugging and monitoring.
   *
   * @private
   */
  #registerConnectionEvents() {
    this.#connection
      .on('error', (err) => {
        Log.error(`[${this.name}] Redis Client Error`, err);
      })
      .on('connect', () => {
        Log.info(`[${this.name}] connecting ...`, this.name);
      })
      .on('ready', () => {
        Log.info(`[${this.name}] connected!`, this.name);
      })
      .on('end', () => {
        Log.warn(`[${this.name}] disconnected!`, this.name);
      })
      .on('reconnecting', () => {
        Log.info(`[${this.name}] reconnecting ...`, this.name);
      });
  }

  /**
   * Gets the underlying Redis client connection.
   *
   * @returns The Redis client instance
   *
   * @example
   * ```typescript
   * const client = manager.getConnection();
   * await client.set('mykey', 'myvalue');
   * ```
   */
  getConnection(): RedisClientType<M, F, S, RESP, TYPE_MAPPING> {
    return this.#connection;
  }

  /**
   * Establishes the connection to Redis.
   *
   * @returns A promise that resolves to this manager instance for method chaining
   *
   * @throws {Error} If the connection cannot be established
   *
   * @example
   * ```typescript
   * await manager.connect();
   * ```
   */
  async connect(): Promise<this> {
    await this.getConnection().connect();
    return this;
  }

  /**
   * Closes the Redis connection gracefully using the QUIT command.
   *
   * @returns A promise that resolves to the Redis server's response to the QUIT command
   *
   * @example
   * ```typescript
   * await manager.close();
   * ```
   */
  async close(): Promise<string> {
    return await this.#connection.quit();
  }

  /**
   * Alias for `close()`. Closes the Redis connection gracefully.
   *
   * @returns A promise that resolves to the Redis server's response to the QUIT command
   *
   * @example
   * ```typescript
   * await manager.closeConnection();
   * ```
   */
  async closeConnection(): Promise<string> {
    return await this.close();
  }

  getModel?(_name: string): unknown {
    throw new Error('Method not implemented.');
  }

  /**
   * Checks if the Redis connection is currently open.
   *
   * @returns A promise that resolves to true if connected, false otherwise
   *
   * @example
   * ```typescript
   * if (await manager.isConnected()) {
   *   console.log('Redis is connected');
   * }
   * ```
   */
  async isConnected(): Promise<boolean> {
    return this.#connection.isOpen;
  }

  /**
   * Executes an asynchronous operation with the Redis connection,
   * ensuring that the connection is ready and open, and enforcing a command timeout.
   *
   * Because node-redis' own command timeout stops once the command is written to
   * the socket, so it does not protect against a frozen Redis.
   *
   * This method adds an additional layer of protection by enforcing a command timeout at the application level.
   *
   * The value of the command timeout is taken from the options provided during the client's initialization (commandOptions.timeout)
   * or defaults to 5000 milliseconds if not specified.
   *
   * @param operation The asynchronous operation to execute with the Redis connection
   * @returns A promise that resolves to the result of the operation or rejects with an error if the operation fails or times out
   *
   * @throws {ServerUnavailableError} If the Redis connection is not ready or not open
   * @throws {CommandTimeoutError} If the operation exceeds the configured command timeout
   */
  async run<R>(operation: () => Promise<R>): Promise<R> {
    if (!this.#connection.isReady) {
      throw new ServerUnavailableError('not ready');
    }
    if (!this.#connection.isOpen) {
      throw new ServerUnavailableError('circuit not open');
    }
    const pending = operation();
    // If the timeout wins, the command may still settle later: avoid an unhandled rejection.
    pending.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CommandTimeoutError(this.#commandTimeoutMs)), this.#commandTimeoutMs);
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Creates a repository for the given schema, allowing interaction with the corresponding Redis data.
   *
   * @param schema The schema for which to create the repository
   * @returns A repository instance for the specified schema
   */
  createModel<TSchema extends StandardSchemaV1>(schema: Schema<TSchema>): Repository<TSchema> {
    return schema.createRepository(this.getConnection(), this);
  }

  /**
   * Performs a comprehensive health check on the Redis connection.
   * Tests connectivity by sending a PING command and gathering connection metrics.
   *
   * @returns A promise that resolves to a detailed health check result including:
   * - Connection status (open/ready)
   * - Ping response
   * - Registered models
   * - Response latency
   * - Error details (if unhealthy)
   *
   * @example
   * ```typescript
   * const health = await manager.healthCheck();
   * if (health.healthy) {
   *   console.log(`Redis is healthy. Latency: ${health.details.latency}`);
   *   console.log(`Models: ${health.details.models?.join(', ')}`);
   * } else {
   *   console.error(`Redis is unhealthy: ${health.message}`);
   * }
   * ```
   */
  async healthCheck(): Promise<RedisClientHealthCheckResult> {
    const start = Date.now();
    const timestamp = start;

    if (!this.#connection.isOpen) {
      return {
        healthy: false,
        message: 'Redis connection is not open',
        details: {
          name: this.name,
          isOpen: this.#connection.isOpen,
          isReady: this.#connection.isReady,
        },
        timestamp,
      };
    }

    try {
      // Ping Redis to check connection
      const pingResult = await this.#connection.ping();

      const latency = Date.now() - start;

      return {
        healthy: true,
        message: 'Redis connection is healthy',
        details: {
          name: this.name,
          isOpen: this.#connection.isOpen,
          isReady: this.#connection.isReady,
          pingResponse: pingResult,
          latency: `${latency}ms`,
        },
        latency,
        timestamp,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Redis health check failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          name: this.name,
          isOpen: this.#connection.isOpen,
          isReady: this.#connection.isReady,
          error: error instanceof Error ? error.stack : String(error),
        },
        latency: Date.now() - start,
        timestamp,
      };
    }
  }
}
