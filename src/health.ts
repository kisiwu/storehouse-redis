import { HealthCheckResult } from '@storehouse/core';

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
 * Extended health check result specific to Redis managers.
 * Includes Redis connection status, ping response, and registered models.
 *
 * @extends RedisHealthCheckResult
 */
export interface RedisClientHealthCheckResult extends RedisHealthCheckResult {
  /**
   * Detailed information about the Redis connection health.
   */
  details: RedisHealthCheckResult['details'] & {
    /** Whether the Redis connection is ready to accept commands */
    isReady: boolean;
  };
}
