import Logger, { Debug } from '@novice1/logger';
import { Storehouse } from '@storehouse/core';
import { RedisManager, getManager, getConnection } from '../src/index';
import { RedisClientType } from 'redis';
import { AlbumSchema } from './models';

Debug.enable('@storehouse/redis*');

describe('connect', function () {
  test('should establish a connection to Redis', async () => {
    const logger = Logger.debugger('@storehouse/redis:manager');
    try {
      Storehouse.add({
        redis: {
          type: RedisManager,
          config: {
            options: {
              password: process.env.TEST_REDIS_PASSWORD,
              socket: {
                host: process.env.TEST_REDIS_HOST,
                port: typeof process.env.TEST_REDIS_PORT === 'string' ? parseInt(process.env.TEST_REDIS_PORT) : undefined
              },
              disableOfflineQueue: true,
              commandOptions: {
                timeout: 5000
              }
            }
          }
        }
      });

      const conn: RedisClientType = getConnection(Storehouse, 'redis')
      await conn.connect();
      logger.info('retrieved connection');
      logger.info('events=', conn.eventNames());

      const manager = getManager(Storehouse);
      // await manager.dropIndexes() // force dropping indexes
      // await manager.createIndexes()

      const Albums = AlbumSchema.createRepository(conn, manager);
      await Albums.dropIndex(); // drop existing index before creating new one
      await Albums.createIndex(); // create new index
      logger.info('created indexes for all repositories (to use RedisSearch)');


      const album = {
        artist: 'Mushroomhead',
        title: 'The Righteous & The Butterfly',
        year: 2014,
        genres: ['metal'],
        songDurations: [204, 290, 196, 210, 211, 105, 244, 245, 209, 252, 259, 200, 215, 219],
        // outOfPublication: true
      };
      const status = await Albums.save('test', album);
      if (status === 'OK') {
        logger.info('album saved successfully');
        Albums.expire('test', 120 * 1000); // set expiration for the saved album
      }

      const fetchedAlbum = await Albums.fetch('test');
      if (fetchedAlbum) {
        logger.info('fetched album titled:', fetchedAlbum.title);
      }

      const artist = await Albums.fetch('test', { path: '$.artist' });
      logger.info('fetched artist value:', artist);

      const found = await Albums.search('@title:The Righteous & The Butterfly');
      logger.info('nb of found albums:', found.total);
      if (found.total > 0) {
        logger.info('first found album value:', found.documents[0].value);
      }

      logger.info('deleted album', await Albums?.remove('test'));

      logger.info('current nb albums:', (await Albums.search('@title:The Righteous & The Butterfly')).total);

      /*
      const AlbumsModel = manager.getModel('album');
      if (AlbumsModel) {
        logger.log('nb albums:', await AlbumsModel.search().return.count());
      }

      const Albums = getModel<{ artist: string; title: string; year: number; genres: string[]; songDurations: number[]; outOfPublication: boolean }>(Storehouse, 'album');

      const album = {
        artist: 'Mushroomhead',
        title: 'The Righteous & The Butterfly',
        year: 2014,
        genres: ['metal'],
        songDurations: [204, 290, 196, 210, 211, 105, 244, 245, 209, 252, 259, 200, 215, 219],
        outOfPublication: true
      }
      const r = await Albums?.save('test', album)
      if (r?.[EntityId])
        Albums?.expire(r[EntityId], 120 * 1000)
      logger.info('added new album from', r?.artist, `ID=${r?.[EntityId]}`);
      logger.log('current nb albums:', await Albums?.search().return.count());

      const fetchedAlbum = await Albums?.fetch('test');
      if (fetchedAlbum) {
        logger.log('found album title:', fetchedAlbum.title);
      }

      logger.info('deleted album', await Albums?.remove('test'));

      logger.log('current nb albums:', await Albums?.search().return.count());
      */

      await Storehouse.close();
    } catch (e) {
      await Storehouse.close();
      logger.info('closed connections');
      throw e;
    }
  });
});