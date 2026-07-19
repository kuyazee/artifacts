// PostgreSQL backend. Stores every object as a row in one table; blobs live in a `bytea`
// column. Popular on managed-Postgres PaaS (Railway, Render, Fly, Supabase, Neon) where a
// durable database is one click away — and, being an external server, it survives a fresh
// container with no local disk, like s3 and git.
//
// All queries are parameterized; prefix operations use range predicates rather than LIKE, so
// a key is never interpreted as a LIKE pattern.

import { makeSqlStore, slugFromMetaKey } from './sqlstore.js';

export async function create() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('storage backend "postgres" requires DATABASE_URL');
  }

  const { default: pg } = await import('pg');
  const ssl =
    process.env.PGSSLMODE === 'disable' || /\bsslmode=disable\b/.test(connectionString)
      ? false
      : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString, ssl, max: Number(process.env.PG_POOL_MAX || 8) });

  const q = (text, params) => pool.query(text, params);

  const driver = {
    kind: 'postgres',

    async get(key) {
      const { rows } = await q('SELECT data FROM artifacts WHERE key = $1', [key]);
      return rows.length ? Buffer.from(rows[0].data) : null;
    },

    async size(key) {
      const { rows } = await q('SELECT length(data) AS n FROM artifacts WHERE key = $1', [key]);
      return rows.length ? Number(rows[0].n) : null;
    },

    async put(key, buf, contentType) {
      await q(
        'INSERT INTO artifacts (key, data, content_type) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, content_type = EXCLUDED.content_type',
        [key, buf, contentType ?? null],
      );
    },

    async listMetas() {
      const { rows } = await q("SELECT key, data FROM artifacts WHERE key LIKE '%/meta.json'");
      const out = [];
      for (const row of rows) {
        const slug = slugFromMetaKey(row.key);
        if (slug) out.push({ slug, buffer: Buffer.from(row.data) });
      }
      return out;
    },

    async move(oldSlug, newSlug) {
      // Range predicates: all keys under `slug/` satisfy `slug/` <= key < `slug0`.
      await q(
        'UPDATE artifacts SET key = $1 || substr(key, $2) WHERE key >= $3 AND key < $4',
        [newSlug, oldSlug.length + 1, `${oldSlug}/`, `${oldSlug}0`],
      );
    },

    async deleteSlug(slug) {
      await q('DELETE FROM artifacts WHERE key >= $1 AND key < $2', [`${slug}/`, `${slug}0`]);
    },

    async init() {
      // Create the table and confirm connectivity — fail fast at boot if either is impossible.
      await q(
        'CREATE TABLE IF NOT EXISTS artifacts (key TEXT PRIMARY KEY, data BYTEA NOT NULL, content_type TEXT)',
      );
    },

    async close() {
      await pool.end();
    },
  };

  return makeSqlStore(driver);
}
