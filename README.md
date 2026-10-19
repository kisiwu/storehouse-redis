# @storehouse/redis

Redis manager for [@storehouse/core](https://www.npmjs.com/package/@storehouse/core), built on [node-redis](https://github.com/redis/node-redis) v6.

- Register one or many Redis connections in a Storehouse registry and retrieve them by name.
- Single-connection manager (`RedisManager`) and connection-pool manager (`RedisPoolManager`).
- Schema-driven repositories for **RedisJSON** documents and **RediSearch** indexes, validated with any [Standard Schema](https://standardschema.dev) library (Valibot, Zod, ArkType, ...).
- Application-level command timeout, so a frozen Redis can't hang your app.
- Built-in health check.
- Fully typed, including the result type of JSON path fetches.

## Installation

```sh
npm install @storehouse/core @storehouse/redis redis
```

`@storehouse/core` and `redis` (^6.3.0) are peer dependencies.

Any Redis server works for the connection managers and plain commands (`get`, `set`, ...). The schema-driven repositories need extra Redis modules, and only for the features you use:

| Feature                                                      | Requires                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Connection managers, plain key/value commands                | Nothing, any Redis                                                            |
| Repository document methods (`save`, `fetch`, `remove`, ...) | [RedisJSON](https://redis.io/docs/latest/develop/data-types/json/)            |
| Index and search methods (`createIndex`, `search`, ...)      | [RediSearch](https://redis.io/docs/latest/develop/interact/search-and-query/) |

Redis 8 and Redis Stack include both. Compatible servers such as Valkey work when they have the JSON and search modules loaded.

## Quick start

```ts
import { Storehouse } from '@storehouse/core';
import { RedisManager, getManager, getConnection } from '@storehouse/redis';

Storehouse.add({
  redis: {
    type: RedisManager,
    config: {
      options: {
        url: 'redis://localhost:6379',
      },
    },
  },
});

// Managers are created but not connected: connect explicitly.
const conn = getConnection(Storehouse, 'redis');
await conn.connect();

await conn.set('hello', 'world');
console.log(await conn.get('hello'));

await Storehouse.close();
```

`getConnection(Storehouse, 'redis')` returns the underlying node-redis client, and `getManager(Storehouse, 'redis')` returns the `RedisManager`. If you omit the name, the registry's default manager is used.

## Configuration

`RedisManagerArg`:

| Option              | Type                                               | Description                                                                                                                                      |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | `string`                                           | Manager name. Generated when omitted.                                                                                                            |
| `config.options`    | `RedisClientOptions`                               | Any [node-redis client option](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md) (`url`, `socket`, `password`, ...). |
| `config.debugLevel` | `number \| 'error' \| 'warn' \| 'info' \| 'debug'` | Log level of the manager's logger.                                                                                                               |

```ts
Storehouse.add({
  redis: {
    type: RedisManager,
    config: {
      debugLevel: 'info',
      options: {
        password: process.env.REDIS_PASSWORD,
        socket: {
          host: process.env.REDIS_HOST,
          port: 6379,
          connectTimeout: 2000,
          reconnectStrategy: (retries) => (retries > 3 ? new Error('Too many retries') : 1000),
        },
        disableOfflineQueue: true,
        commandOptions: { timeout: 1000 },
      },
    },
  },
});
```

### Command timeout

`commandOptions.timeout` (default **5000 ms**) is also enforced by the manager itself. node-redis' own timeout stops counting once the command is written to the socket, so it doesn't protect against a frozen server. Repository operations run through `manager.run()`, which rejects with:

- `ServerUnavailableError` if the connection is not open (or not ready, for `RedisManager`).
- `CommandTimeoutError` if the command exceeds the timeout.

You can use `run()` for your own commands too:

```ts
const manager = getManager(Storehouse, 'redis');
const value = await manager.run(() => manager.getConnection().get('hello'));
```

## Manager API

| Method                          | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| `connect()`                     | Opens the connection. Resolves to the manager.                 |
| `close()` / `closeConnection()` | Closes the connection (`QUIT` for `RedisManager`).             |
| `isConnected()`                 | `true` when the connection is open.                            |
| `getConnection()`               | Returns the underlying node-redis client (or pool).            |
| `run(operation)`                | Runs an operation with availability check and command timeout. |
| `createModel(schema)`           | Creates a `Repository` for a `Schema`.                         |
| `healthCheck()`                 | Pings Redis and returns a detailed result.                     |

### Health check

```ts
const health = await getManager(Storehouse, 'redis').healthCheck();

if (health.healthy) {
  console.log(health.details.latency, health.details.pingResponse);
} else {
  console.error(health.message);
}
```

The result contains `healthy`, `message`, `timestamp`, `latency` (ms) and `details` (`name`, `isOpen`, `isReady`, `pingResponse`, `latency`, `error`).

## Repositories (RedisJSON + RediSearch)

A `Schema` maps a key prefix to a validation schema and a RediSearch index definition. Documents are stored as JSON under `<prefix>:<id>`, and the index is named `idx:<prefix>`.

### Define a schema

```ts
import { Schema } from '@storehouse/redis';
import { SCHEMA_FIELD_TYPE } from 'redis';
import * as v from 'valibot';

export const AlbumSchema = new Schema(
  'album', // key prefix
  v.object({
    artist: v.string(),
    title: v.string(),
    year: v.number(),
    genres: v.array(v.string()),
    songDurations: v.array(v.number()),
    outOfPublication: v.optional(v.boolean()),
  }),
  // RediSearch schema
  {
    '$.artist': { type: SCHEMA_FIELD_TYPE.TEXT, SORTABLE: true, AS: 'artist' },
    '$.title': { type: SCHEMA_FIELD_TYPE.TEXT, SORTABLE: true, AS: 'title' },
    '$.year': { type: SCHEMA_FIELD_TYPE.NUMERIC, SORTABLE: true, AS: 'year' },
  }
  // optional 4th argument: index creation options (`ON` and `PREFIX` are set for you)
);
```

Any [Standard Schema](https://standardschema.dev) compatible library works for the validation part.

### Use it

```ts
const manager = getManager(Storehouse, 'redis');
const Albums = manager.createModel(AlbumSchema);

// Create the index once, before saving, to avoid backfilling issues
if (!(await Albums.indexInfo())) {
  await Albums.createIndex();
}

// Save (validated against the schema)
await Albums.save('1', {
  artist: 'Mushroomhead',
  title: 'The Righteous & The Butterfly',
  year: 2014,
  genres: ['metal'],
  songDurations: [204, 290, 196],
});

// Fetch (validated)
const album = await Albums.fetch('1');

// Search
const { total, documents } = await Albums.search('@title:Righteous @title:Butterfly');

// Expire (seconds) and remove
await Albums.expire('1', 120);
await Albums.remove('1');
```

### Repository API

| Method                           | Description                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `save(id, value, options?)`      | `JSON.SET` at the root, after schema validation. Throws `ValidationError` on invalid data. |
| `set(id, value, options?)`       | Same as `save`.                                                                            |
| `set(id, path, value, options?)` | Sets a value at `path`. Only validated when `path` is the root (`$`).                      |
| `fetch(id, { path? })`           | `JSON.GET`. See [Fetching paths](#fetching-paths).                                         |
| `remove(id, options?)`           | `JSON.DEL`. Resolves to the number of removed keys.                                        |
| `expire(id, seconds, mode?)`     | `EXPIRE` on the document key (`mode`: `NX`, `XX`, `GT`, `LT`).                             |
| `createIndex()`                  | `FT.CREATE`.                                                                               |
| `dropIndex(options?)`            | `FT.DROPINDEX`.                                                                            |
| `indexInfo()`                    | `FT.INFO`, or `null` if the index does not exist.                                          |
| `search(query, options?)`        | `FT.SEARCH` on the schema's index.                                                         |
| `fullKey(id)`                    | The full Redis key, `<prefix>:<id>`.                                                       |

Ids can be strings or Buffers. Empty ids and prefixes throw `InvalidKeyError`.

### Fetching paths

The shape of `fetch` depends on `path`, and the TypeScript return type follows it:

| `path`                                      | Result                                     | Validated |
| ------------------------------------------- | ------------------------------------------ | --------- |
| none or `.`                                 | The document                               | yes       |
| `$`                                         | The document wrapped in an array           | yes       |
| other JSONPath starting with `$`            | Array of matches (empty if none)           | no        |
| legacy path (`.artist`, `songDurations[0]`) | The value at that path                     | no        |
| array of paths                              | Object keyed by path, as returned by Redis | no        |

`fetch` resolves to `null` when the document does not exist.

```ts
await Albums.fetch('1', { path: '$.artist' }); // ['Mushroomhead']
await Albums.fetch('1', { path: '$.songDurations[*]' }); // number[]
await Albums.fetch('1', { path: '.artist' }); // 'Mushroomhead'
await Albums.fetch('1', { path: ['artist', 'year'] }); // { artist: 'Mushroomhead', year: 2014 }
```

## Connection pool

`RedisPoolManager` wraps node-redis' `createClientPool`. It has the same API as `RedisManager`, plus `config.poolOptions` for pool settings.

```ts
import { RedisPoolManager, getPoolManager, getPoolConnection } from '@storehouse/redis';

Storehouse.add({
  pool: {
    type: RedisPoolManager,
    config: {
      options: { url: 'redis://localhost:6379' },
      poolOptions: { minimum: 2, maximum: 10 },
    },
  },
});

await getPoolManager(Storehouse, 'pool').connect();
```

A pool is useful for Node.js clusters or worker threads sharing a limited number of connections, high-latency links to Redis, and workloads with blocking commands. Avoid it in serverless environments, where connections can't be reused across invocations. `clientSideCache` is not accepted in `config.options` for a pool; set it in `config.poolOptions` instead.

## Errors

All errors are exported from the package.

| Error                    | Thrown when                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `ServerUnavailableError` | A guarded operation runs while the connection is not open (or not ready). |
| `CommandTimeoutError`    | A guarded operation exceeds the command timeout.                          |
| `InvalidKeyError`        | An id or prefix is null, undefined, an empty string, or an empty buffer.  |
| `ValidationError`        | A document fails schema validation. The failures are in `error.issues`.   |

```ts
import { ValidationError } from '@storehouse/redis';

try {
  await Albums.save('1', invalidAlbum);
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(e.issues);
  }
}
```

## Exports

- Managers: `RedisManager`, `RedisPoolManager`
- Helpers: `getManager`, `getConnection`, `getPoolManager`, `getPoolConnection`
- Models: `Schema`, `Repository`
- Errors: `ServerUnavailableError`, `CommandTimeoutError`, `InvalidKeyError`, `ValidationError`
- Types: `RedisManagerArg`, `RedisPoolManagerArg`, `OperationGuard`, `GetPathType`, `JsonGetResult`, `JsonDocument`, `SanitizedCreateIndexOptions`, `RedisHealthCheckResult`, `RedisClientHealthCheckResult`

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Tests run against a real server. Put your connection settings in a `.env.test` file (loaded by `jest.setup.js` if it exists):

```
TEST_REDIS_HOST=localhost
TEST_REDIS_PORT=6379
TEST_REDIS_PASSWORD=
```

The tests have been run against Redis 8.10.2 and Valkey (Redis 7.2.4 compatible).

## License

[MIT](./LICENSE)
