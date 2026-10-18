import * as v from 'valibot';
import { SCHEMA_FIELD_TYPE } from 'redis';
import { Schema } from '../src/index';

export const AlbumSchema = new Schema(
  'test:album',
  v.object({
    artist: v.string(),
    title: v.string(),
    year: v.number(),
    genres: v.array(v.string()),
    songDurations: v.array(v.number()),
    outOfPublication: v.optional(v.boolean()),
  }),
  {
    '$.artist': {
      type: SCHEMA_FIELD_TYPE.TEXT,
      SORTABLE: true,
      AS: 'artist'
    },
    '$.title': {
      type: SCHEMA_FIELD_TYPE.TEXT,
      SORTABLE: true,
      AS: 'title',
    },
    '$.year': {
      type: SCHEMA_FIELD_TYPE.NUMERIC,
      SORTABLE: true,
      AS: 'year'
    }
  }
)