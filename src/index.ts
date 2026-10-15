import Logger from '@novice1/logger';
import {
	type HealthCheckResult,
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
 * Extended health check result specific to Redis managers.
 * Includes Redis connection status, ping response, and registered models.
 *
 * @extends HealthCheckResult
 */
export interface RedisHealthCheckResult extends HealthCheckResult {
	/**
	 * Detailed information about the Redis connection health.
	 */
	details: {
		/** The name of the manager */
		name: string;
		/** Whether the Redis connection is currently open */
		isOpen: boolean;
		/** Whether the Redis connection is ready to accept commands */
		isReady: boolean;
		/** The response from the Redis PING command */
		pingResponse?: string | Buffer<ArrayBufferLike>;
		/** List of registered model (schema) names */
		models?: string[];
		/** Time taken to perform the health check in milliseconds */
		latency?: string;
		/** Error message if the health check failed */
		error?: string;
		/** Additional custom properties */
		[key: string]: unknown;
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
 * @template RESP - Redis RESP protocol version, defaults to 2
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
	RESP extends RespVersions = 2,
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
> implements IManager {
	/**
	 * Identifier for the manager type.
	 * @readonly
	 */
	static readonly type = '@storehouse/redis';

	#connection: RedisClientType<M, F, S, RESP, TYPE_MAPPING>;
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

	getModel?(name: string): unknown {
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
