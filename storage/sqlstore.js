// Shared core for the SQL-backed stores (sqlite, postgres). Both keep every object as a row
// in one table `artifacts(key, data, content_type)`, keyed by `<slug>/<relpath>`. A driver
// supplies the six data operations; this module wraps them with the key guard and the stream
// shape the serving layer expects.
//
// Note [streaming]: unlike local/s3, SQL rows are read whole — get() buffers the entire object
// in memory (there is no partial-row streaming), so these backends rely on the upload size
// caps rather than true streaming. Fine for artifacts, which are bounded (10 MB JSON / 100 MB
// unzipped), but worth knowing.
//
// Note [atomicity]: because writes are single SQL statements, move and delete are naturally
// atomic here — no partial-namespace states, unlike object stores.

import { Readable } from 'node:stream';

import { assertSafeKey } from './index.js';

function toBuffer(data) {
  return typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
}

// driver: {
//   kind,
//   get(key)         -> Promise<Buffer|null>
//   size(key)        -> Promise<number|null>
//   put(key, buf, contentType) -> Promise<void>   (upsert)
//   listMetas()      -> Promise<[{slug, buffer}]>
//   move(oldSlug, newSlug) -> Promise<void>
//   deleteSlug(slug) -> Promise<void>
//   init()           -> Promise<void>             (create table + connectivity probe)
//   close?()         -> Promise<void>
// }
export function makeSqlStore(driver) {
  return {
    kind: driver.kind,
    streams: false,

    async getBuffer(key) {
      assertSafeKey(key);
      return driver.get(key);
    },

    async head(key) {
      assertSafeKey(key);
      const size = await driver.size(key);
      return size == null ? null : { size };
    },

    async get(key, { range } = {}) {
      assertSafeKey(key);
      const buf = await driver.get(key);
      if (!buf) return null;
      const body = range ? buf.subarray(range.start, range.end + 1) : buf;
      return { stream: Readable.from(body), size: buf.length };
    },

    async put(key, data, { contentType } = {}) {
      assertSafeKey(key);
      await driver.put(key, toBuffer(data), contentType);
    },

    async listMetas() {
      return driver.listMetas();
    },

    async move(oldSlug, newSlug) {
      assertSafeKey(oldSlug);
      assertSafeKey(newSlug);
      await driver.move(oldSlug, newSlug);
    },

    async deleteSlug(slug) {
      assertSafeKey(slug);
      await driver.deleteSlug(slug);
    },

    init: () => driver.init(),
  };
}

// A meta.json object is exactly `<slug>/meta.json` — one slash, slug has no slash. Given a
// full key, return the slug, or null if it isn't a top-level meta key.
export function slugFromMetaKey(key) {
  const suffix = '/meta.json';
  if (!key.endsWith(suffix)) return null;
  const slug = key.slice(0, -suffix.length);
  return slug.includes('/') ? null : slug;
}
