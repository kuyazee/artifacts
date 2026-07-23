// SQLite backend, using Node's built-in node:sqlite (no external dependency; requires the
// Node >=22 the project already targets). Stores every object as a row in one table.
//
// Durability note: an SQLite file lives on local disk, so like the `local` backend it only
// survives a restart if that file is on durable storage (a mounted volume, or replicated with
// something like Litestream). For durability on hosts that wipe local disk, use s3, git, or
// postgres. SQLite's draw is a single portable file with transactional writes.

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { makeSqlStore, slugFromMetaKey } from './sqlstore.js';

export async function create() {
  const file =
    process.env.SQLITE_PATH || path.join(path.resolve(process.env.DATA_DIR || '/data'), 'artifacts.db');

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS artifacts (key TEXT PRIMARY KEY, data BLOB NOT NULL, content_type TEXT)',
  );

  const getStmt = db.prepare('SELECT data FROM artifacts WHERE key = ?');
  const sizeStmt = db.prepare('SELECT length(data) AS n FROM artifacts WHERE key = ?');
  const putStmt = db.prepare(
    'INSERT INTO artifacts (key, data, content_type) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET data = excluded.data, content_type = excluded.content_type',
  );
  const listStmt = db.prepare("SELECT key, data FROM artifacts WHERE key LIKE '%/meta.json'");
  // Prefix range predicates instead of LIKE, so a key can never be read as a LIKE pattern:
  // all keys under `slug/` satisfy `slug/` <= key < `slug0` ('/' is 0x2F, just below '0').
  const moveStmt = db.prepare(
    'UPDATE artifacts SET key = ? || substr(key, ?) WHERE key >= ? AND key < ?',
  );
  const deleteStmt = db.prepare('DELETE FROM artifacts WHERE key >= ? AND key < ?');
  const copyStmt = db.prepare(
    'INSERT INTO artifacts (key, data, content_type) ' +
      'SELECT ? || substr(key, ?), data, content_type FROM artifacts ' +
      'WHERE key >= ? AND key < ? AND key <> ? ' +
      'ON CONFLICT(key) DO UPDATE SET data = excluded.data, content_type = excluded.content_type',
  );

  const driver = {
    kind: 'sqlite',

    get(key) {
      const row = getStmt.get(key);
      return row ? Buffer.from(row.data) : null;
    },

    size(key) {
      const row = sizeStmt.get(key);
      return row ? Number(row.n) : null;
    },

    put(key, buf, contentType) {
      putStmt.run(key, buf, contentType ?? null);
    },

    listMetas() {
      const out = [];
      for (const row of listStmt.all()) {
        const slug = slugFromMetaKey(row.key);
        if (slug) out.push({ slug, buffer: Buffer.from(row.data) });
      }
      return out;
    },

    move(oldSlug, newSlug) {
      moveStmt.run(newSlug, oldSlug.length + 1, `${oldSlug}/`, `${oldSlug}0`);
    },

    copySlug(srcSlug, dstSlug) {
      copyStmt.run(dstSlug, srcSlug.length + 1, `${srcSlug}/`, `${srcSlug}0`, `${srcSlug}/meta.json`);
    },

    deleteSlug(slug) {
      deleteStmt.run(`${slug}/`, `${slug}0`);
    },

    init() {
      // Table already created above; a trivial query confirms the DB is usable.
      db.prepare('SELECT 1').get();
    },
  };

  return makeSqlStore(driver);
}
