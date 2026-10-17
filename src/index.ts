export { CommandTimeoutError, InvalidKeyError, ServerUnavailableError, ValidationError } from './models/errors';
export type { OperationGuard } from './models/guard';
export type { GetPathType, JsonGetResult } from './models/path-type';
export { type JsonDocument, Repository, type SanitizedSearchOptions, Schema } from './models/schema';
export type { RedisHealthCheckResult, RedisClientHealthCheckResult } from './health';
export { RedisPoolManager, type RedisPoolManagerArg, getPoolConnection, getPoolManager } from './client-pool';
export { RedisManager, type RedisManagerArg, getConnection, getManager } from './client';
