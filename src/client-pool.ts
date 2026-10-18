/**
 * Recommended Infrastructure Use Cases for a Pool
 *
 * This comment section outlines scenarios where using a Redis connection pool is beneficial.
 *
 * 1. Multi-Threaded Cluster Environments (Node.js Clusters / Worker Threads)
 *
 * If your app utilizes the native Node.js cluster module,
 * pm2 in cluster mode, or heavy Worker Threads, each worker runs its own isolated V8 engine instance.
 * - The Problem: If every worker creates an independent client,
 *   traffic spikes can easily exceed your Redis server's connection limits (maxclients).
 * - The Pool Solution: Placing a pool manager (or a centralized internal pool proxy)
 *   at the infrastructure level ensures workers dynamically share a fixed,
 *   predictable block of connections instead of opening thousands of unmanaged sockets.
 *
 * 2. Cross-Region / High-Latency Network Paths
 *
 * If your Node.js application server lives in one cloud region (e.g., AWS us-east-1)
 * and your Redis database is hosted elsewhere (e.g., a managed Redis instances in GCP
 * or an on-premise data center), network latency increases.
 * - The Problem: When latency is high, a single multiplexed connection will bottleneck
 *   because it has to wait longer for TCP acknowledgment packets to return before
 *   it can efficiently clear out its deep pipeline queue.
 * - The Pool Solution: Spreading the workload across a pool of parallel sockets allows
 *   the system to fire multiple concurrent packets concurrently over different pathways,
 *   masking network latency and increasing throughput.
 *
 * 3. Dedicated Enterprise Job Queues (BullMQ / Celery Workers)
 *
 * If you run dedicated background workers handling intensive data processing
 * (like image resizing or massive report generation):
 * - The Problem: A single long-running or blocking command (like BLPOP or heavy Lua scripts)
 *   will completely freeze a single connection, blocking all other fast queries (like GET or SET).
 * - The Pool Solution: Setting up a connection pool prevents workers from starving
 *   the rest of your app. If worker A blocks a socket, worker B simply leases an alternative,
 *   clean socket from the pool pool to execute lightweight reads instantly.
 *
 * ⚠️ Anti-Pattern: Serverless Infrastructure (AWS Lambda / Vercel Edge)
 *
 * You should strictly avoid connection pools in Serverless environments.
 * Because serverless functions completely freeze or terminate immediately after execution,
 * a pool cannot persist in memory across invocations.
 * If a Lambda function spins up a pool of 10 connections, processes 1 request, and exits,
 * those 10 connections hang open on your Redis server until they hit a timeout.
 * Under a traffic spike, this will exhaust your Redis connection limit instantly.
 * In serverless setups, always stick to a single, carefully managed createClient connection lifecycle.
 *
 */
import type { RedisHealthCheckResult } from './health';
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
  createClientPool,
  type RedisClientPoolType,
  type RedisClientOptions,
  type RedisDefaultModules,
  type RedisFunctions,
  type RedisModules,
  type RedisScripts,
  type RespVersions,
  type TypeMapping,
} from 'redis';

const Log = Logger.debugger('@storehouse/redis:poolmanager');

/**
 * Configuration argument for creating a {@link RedisPoolManager} instance.
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
 * const managerArg: RedisPoolManagerArg = {
 *   name: 'my-redis-pool-manager',
 *   config: {
 *     options: {
 *       url: 'redis://localhost:6379'
 *     }
 *   }
 * };
 * ```
 */
export interface RedisPoolManagerArg<
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
    debugLevel?: number | 'error' | 'warn' | 'info' | 'debug';
    /**
     * Redis client connection options.
     * See redis client documentation for available options.
     */
    options?: Omit<RedisClientOptions<M, F, S, RESP, TYPE_MAPPING>, 'clientSideCache'>;

    poolOptions?: Parameters<typeof createClientPool>[1];
  };
}

/**
 * Retrieves a {@link RedisPoolManager} instance from the registry.
 *
 * @template M - The specific RedisPoolManager type to return, defaults to RedisPoolManager
 *
 * @param registry - The Storehouse registry containing registered managers
 * @param managerName - Optional name of the manager to retrieve. If omitted, retrieves the default manager
 *
 * @returns The requested {@link RedisPoolManager} instance
 *
 * @throws {ManagerNotFoundError} If the manager is not found in the registry
 * @throws {InvalidManagerConfigError} If the manager exists but is not an instance of {@link RedisPoolManager}
 *
 * @example
 * ```typescript
 * const redisManager = getPoolManager(registry, 'redis-pool-manager');
 * await redisManager.connect();
 * ```
 */
export function getPoolManager<M extends RedisPoolManager = RedisPoolManager>(
  registry: Registry,
  managerName?: string
): M {
  const manager = registry.getManager<M>(managerName);
  if (!manager) {
    throw new ManagerNotFoundError(managerName || registry.defaultManager);
  }
  if (!(manager instanceof RedisPoolManager)) {
    throw new InvalidManagerConfigError(
      `Manager "${managerName || registry.defaultManager}" is not instance of RedisPoolManager`
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
 * const redisClient = getPoolConnection(registry, 'redis-pool-manager');
 * await redisClient.set('key', 'value');
 * const value = await redisClient.get('key');
 * ```
 */
export function getPoolConnection<
  M extends RedisModules = RedisDefaultModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
  RESP extends RespVersions = 3,
  TYPE_MAPPING extends TypeMapping = TypeMapping,
>(registry: Registry, managerName?: string): RedisClientPoolType<M, F, S, RESP, TYPE_MAPPING> {
  const conn = registry.getConnection<RedisClientPoolType<M, F, S, RESP, TYPE_MAPPING>>(managerName);
  if (!conn) {
    throw new ManagerNotFoundError(managerName || registry.defaultManager);
  }
  return conn;
}

export class RedisPoolManager<
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

  #connection: RedisClientPoolType<M, F, S, RESP, TYPE_MAPPING>;

  #commandTimeoutMs: number;

  protected logger: Logger.Debugger;

  /**
   * The name of this manager instance.
   * @protected
   */
  protected name: string;
  /**
   * Creates a new RedisPoolManager instance.
   *
   * @param settings - Configuration settings for the manager
   *
   * @remarks
   * The connection is created but not opened. You must call `connect()` to establish the connection.
   * Connection events (error, connect, ready, end, reconnecting) are automatically registered and logged.
   */
  constructor(settings: RedisPoolManagerArg<M, F, S, RESP, TYPE_MAPPING>) {
    this.name = settings.name || `redis_${Date.now()}_${randomBytes(1).toString('hex')}`;
    this.logger = Log.extend(`${this.name}`);
    if (typeof settings.config?.debugLevel !== 'undefined') {
      this.logger.setLevel(settings.config.debugLevel);
    }
    this.#connection = createClientPool(settings?.config?.options, settings?.config?.poolOptions);
    this.#commandTimeoutMs = settings?.config?.options?.commandOptions?.timeout || 5000;

    this.#registerConnectionEvents();

    this.logger.debug(`RedisConnection created. Must call "RedisConnection.connect()".`);
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
        this.logger.error(`Redis Client Error`, err);
      })
      .on('connect', () => {
        this.logger.debug(`connecting ...`);
      })
      .on('ready', () => {
        this.logger.info(`connected!`);
      })
      .on('end', () => {
        this.logger.warn(`disconnected!`);
      })
      .on('reconnecting', () => {
        this.logger.info(`reconnecting ...`);
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
  getConnection(): RedisClientPoolType<M, F, S, RESP, TYPE_MAPPING> {
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
  async close(): Promise<void> {
    return await this.#connection.close();
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
  async closeConnection(): Promise<void> {
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
   * ensuring that the connection is open, and enforcing a command timeout.
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
   * @throws {ServerUnavailableError} If the Redis connection is not open
   * @throws {CommandTimeoutError} If the operation exceeds the configured command timeout
   */
  async run<R>(operation: () => Promise<R>): Promise<R> {
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
  async healthCheck(): Promise<RedisHealthCheckResult> {
    const start = Date.now();
    const timestamp = start;

    if (!this.#connection.isOpen) {
      return {
        healthy: false,
        message: 'Redis connection is not open',
        details: {
          name: this.name,
          isOpen: this.#connection.isOpen,
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
          error: error instanceof Error ? error.stack : String(error),
        },
        latency: Date.now() - start,
        timestamp,
      };
    }
  }
}
