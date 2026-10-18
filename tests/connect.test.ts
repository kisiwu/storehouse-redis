import { Storehouse } from '@storehouse/core';
import { RedisManager, getManager, getConnection } from '../src/index';
import type { RedisClientType } from 'redis';
import { logger } from './logger';
import { AlbumSchema } from './models';

describe('connect', function () {
  test('should establish a connection to Redis', async () => {
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

      // Initialize the Albums repository (REDIS JSON and REDIS SEARCH with schema-driven approach)

      const Albums = AlbumSchema.createRepository(conn, manager);

      // Creating indexes before saving to avoid a potential search issue (backfilling)

      // await manager.dropIndexes() // force dropping indexes
      // await manager.createIndexes()

      // Drop existing index before creating new one
      if (await Albums.indexInfo()) {
        await Albums.dropIndex();
      }
      // Create new index
      await Albums.createIndex();
      logger.info('created indexes for all repositories (to use RedisSearch)');

      /***** REDIS JSON *****/

      // Saving a new album to the repository

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

      // Fetching the album after saving it

      const fetchedAlbum = await Albums.fetch('test');
      if (fetchedAlbum) {
        logger.info('fetched album titled:', fetchedAlbum.title);
      }

      // Fetching various parts of the album using JSON paths
      // Noting that any path starting with '$' will return an array of results

      const rootAlbum = await Albums.fetch('test', { path: '$' });
      expect(rootAlbum).toEqual([{
        artist: 'Mushroomhead',
        title: 'The Righteous & The Butterfly',
        year: 2014,
        genres: ['metal'],
        songDurations: [204, 290, 196, 210, 211, 105, 244, 245, 209, 252, 259, 200, 215, 219],
      }]);

      const artist = await Albums.fetch('test', { path: '$.artist' });
      expect(artist).toEqual(['Mushroomhead']);

      const firstSongDuration = await Albums.fetch('test', { path: '$.songDurations[0]' });
      expect(firstSongDuration).toEqual([204]);

      const allSongDurations = await Albums.fetch('test', { path: '$.songDurations[*]' });
      expect(allSongDurations).toHaveLength(14);

      const missing = await Albums.fetch('test', { path: '$.missing' });
      expect(missing).toEqual([]);

      // Legacy unwrapped fetches

      const legacyArtist = await Albums.fetch('test', { path: '.artist' });
      expect(legacyArtist).toBe('Mushroomhead'); // legacy: unwrapped

      const legacyFirstSongDuration = await Albums.fetch('test', { path: 'songDurations[0]' });
      expect(legacyFirstSongDuration).toBe(204); // legacy: unwrapped

      const artistAndYear = await Albums.fetch('test', {
        path: [
          'artist',
          'year'
        ]
      });
      expect(artistAndYear).toEqual({ artist: 'Mushroomhead', year: 2014 });

      /***** REDIS SEARCH *****/

      // Searching for albums by title

      const found = await Albums.search('@title:Righteous @title:Butterfly');
      logger.info('nb of found albums:', found.total);
      expect(found.total).toBeGreaterThan(0);
      expect(found.documents[0].value).toEqual({
        artist: 'Mushroomhead',
        title: 'The Righteous & The Butterfly',
        year: 2014,
        genres: ['metal'],
        songDurations: [204, 290, 196, 210, 211, 105, 244, 245, 209, 252, 259, 200, 215, 219],
      });

      // Deleting the album after the search

      logger.info('deleted album', await Albums?.remove('test'));

      // Checking the number of albums after deletion

      logger.info('current nb albums:', (await Albums.search('@title:Righteous @title:Butterfly')).total);

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
      if (e instanceof Error) {
        logger.error('error constructor name:', e.constructor.name);
        logger.error('error name:', e.name);
        logger.error('error message:', e.message);
      }
      throw e;
    }
  });
});