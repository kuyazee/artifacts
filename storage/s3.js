// S3-compatible object-storage backend. Works against AWS S3 and any S3-compatible
// provider (Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi, GCS via S3
// interop). Uses aws4fetch — a tiny SigV4 request signer — over the heavyweight AWS SDK.
//
// Security notes:
//  - The bucket MUST be private. Objects are only ever served back through the app, so the
//    hardening headers / CSP / noindex / expiry / disable checks all apply. A public bucket
//    (or a browser-facing CDN/presigned URL) would bypass every one of them. See docs.
//  - Key encoding is owned here, once: each path segment is percent-encoded (RFC 3986) and
//    handed to aws4fetch, whose s3 mode re-derives the same canonical form for signing — so
//    the transmitted path is single-encoded and put/get always resolve the same object.
//  - Content-Type is decided by the app from the key (see server.js); this backend never
//    trusts or forwards the object's stored content-type or any x-amz-* header.

import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { AwsClient } from 'aws4fetch';

import { assertSafeKey } from './index.js';

// Mirror of server.js SLUG_RE — used to skip anything in a bucket that is not an artifact
// namespace (e.g. the boot-probe prefix, or unrelated objects sharing the bucket).
const SLUG_LIKE = /^[a-z0-9][a-z0-9-]{2,63}$/;

// Percent-encode one path segment. encodeURIComponent leaves !'()* unescaped but SigV4
// wants them escaped; add them so our encoding matches aws4fetch's canonical form exactly.
function encodeSegment(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeKey(key) {
  return key.split('/').map(encodeSegment).join('/');
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`storage backend "s3" requires ${name}`);
  return v;
}

// A normalized key prefix inside the bucket: no leading slash, no . / .. segments, exactly
// one trailing slash (or empty). Validated at boot so put and get stay symmetric.
function normalizePrefix(raw) {
  if (!raw) return '';
  if (raw.startsWith('/')) throw new Error('S3_PREFIX must not start with "/"');
  let p = raw.replace(/\/+/g, '/').replace(/^\//, '');
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') throw new Error('S3_PREFIX must not contain "." or ".." segments');
  }
  if (!p.endsWith('/')) p += '/';
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function create() {
  const endpoint = requireEnv('S3_ENDPOINT').replace(/\/+$/, '');
  const bucket = requireEnv('S3_BUCKET');
  const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
  const region = process.env.S3_REGION || 'us-east-1';
  const prefix = normalizePrefix(process.env.S3_PREFIX || '');

  const client = new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });

  function objectUrl(key) {
    assertSafeKey(key);
    return `${endpoint}/${bucket}/${encodeKey(prefix + key)}`;
  }

  // Drain a response body we don't need, so the underlying socket is released.
  async function drain(res) {
    try {
      if (res.body) await res.arrayBuffer();
    } catch {
      /* ignore */
    }
  }

  // Paginated ListObjectsV2. `delimiter` groups by "folder" (returns CommonPrefixes);
  // without it, returns every Key under the prefix. Handles >1000 keys via continuation.
  async function* listPages(fullPrefix, delimiter) {
    let token;
    do {
      const u = new URL(`${endpoint}/${bucket}`);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', fullPrefix);
      if (delimiter) u.searchParams.set('delimiter', delimiter);
      if (token) u.searchParams.set('continuation-token', token);
      const res = await client.fetch(u.toString());
      if (!res.ok) {
        await drain(res);
        throw new Error(`s3 list failed: ${res.status}`);
      }
      const xml = await res.text();
      yield xml;
      token = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml)
        ? decodeXml(xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/s)?.[1] ?? '')
        : undefined;
    } while (token);
  }

  // Top-level artifact namespaces (slugs), via delimiter grouping.
  async function listSlugs() {
    const slugs = [];
    for await (const xml of listPages(prefix, '/')) {
      for (const block of xml.matchAll(/<CommonPrefixes>(.*?)<\/CommonPrefixes>/gs)) {
        const p = block[1].match(/<Prefix>(.*?)<\/Prefix>/s)?.[1];
        if (p == null) continue;
        const slug = decodeXml(p).slice(prefix.length).replace(/\/$/, '');
        if (SLUG_LIKE.test(slug)) slugs.push(slug); // skip probe/junk objects
      }
    }
    return slugs;
  }

  // Every storage key (slug/relpath) under one slug namespace.
  async function listKeys(slug) {
    const keys = [];
    for await (const xml of listPages(`${prefix}${slug}/`, undefined)) {
      for (const block of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
        const k = block[1].match(/<Key>(.*?)<\/Key>/s)?.[1];
        if (k != null) keys.push(decodeXml(k).slice(prefix.length));
      }
    }
    return keys;
  }

  async function copyObject(srcKey, destKey) {
    const res = await client.fetch(objectUrl(destKey), {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `/${bucket}/${encodeKey(prefix + srcKey)}` },
    });
    if (!res.ok) {
      await drain(res);
      throw new Error(`s3 copy ${srcKey} -> ${destKey}: ${res.status}`);
    }
    await drain(res);
  }

  async function deleteKeys(keys) {
    for (const key of keys) {
      const res = await client.fetch(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        await drain(res);
        throw new Error(`s3 delete ${key}: ${res.status}`);
      }
      await drain(res);
    }
  }

  const backend = {
    kind: 's3',
    streams: true,

    async getBuffer(key) {
      const res = await client.fetch(objectUrl(key));
      if (res.status === 404) {
        await drain(res);
        return null;
      }
      if (!res.ok) {
        await drain(res);
        throw new Error(`s3 get ${key}: ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async head(key) {
      const res = await client.fetch(objectUrl(key), { method: 'HEAD' });
      await drain(res);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 head ${key}: ${res.status}`);
      const len = res.headers.get('content-length');
      return { size: len == null ? undefined : Number(len) };
    },

    async get(key, { range } = {}) {
      const headers = {};
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;
      const res = await client.fetch(objectUrl(key), { headers });
      if (res.status === 404) {
        await drain(res);
        return null;
      }
      if (res.status !== 200 && res.status !== 206) {
        await drain(res);
        throw new Error(`s3 get ${key}: ${res.status}`);
      }
      const len = res.headers.get('content-length');
      return {
        stream: Readable.fromWeb(res.body),
        size: len == null ? undefined : Number(len),
      };
    },

    async put(key, data, { contentType } = {}) {
      const body = typeof data === 'string' ? Buffer.from(data) : data;
      const headers = {};
      if (contentType) headers['Content-Type'] = contentType;
      const res = await client.fetch(objectUrl(key), { method: 'PUT', headers, body });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`s3 put ${key}: ${res.status} ${detail}`.trim());
      }
      await drain(res);
    },

    async listMetas() {
      const slugs = await listSlugs();
      const metas = await Promise.all(
        slugs.map(async (slug) => {
          const buffer = await this.getBuffer(`${slug}/meta.json`).catch(() => null);
          return buffer ? { slug, buffer } : null; // skip in-flight/corrupt items
        }),
      );
      return metas.filter(Boolean);
    },

    // Rename a whole namespace. No atomic multi-object rename exists on S3, so: copy every
    // object (meta.json LAST so the destination only becomes visible once complete), then
    // delete the source (meta.json FIRST). A crash between copy and delete leaves BOTH slugs
    // briefly serving — a transient duplicate, never data loss. Server-side CopyObject keeps
    // bytes off this process.
    async move(oldSlug, newSlug) {
      const keys = await listKeys(oldSlug);
      const metaLastForCopy = [...keys].sort(
        (a, b) => (a.endsWith('/meta.json') ? 1 : 0) - (b.endsWith('/meta.json') ? 1 : 0),
      );
      for (const key of metaLastForCopy) {
        const rel = key.slice(oldSlug.length + 1);
        await copyObject(key, `${newSlug}/${rel}`);
      }
      const metaFirstForDelete = [...keys].sort(
        (a, b) => (a.endsWith('/meta.json') ? -1 : 0) - (b.endsWith('/meta.json') ? -1 : 0),
      );
      await deleteKeys(metaFirstForDelete);
    },

    // Copy every content object under src/ to dst/, skipping src/meta.json (the caller writes
    // the copy's meta last). Server-side CopyObject keeps bytes off this process.
    async copySlug(srcSlug, dstSlug) {
      const keys = await listKeys(srcSlug);
      for (const key of keys) {
        if (key === `${srcSlug}/meta.json`) continue;
        const rel = key.slice(srcSlug.length + 1);
        await copyObject(key, `${dstSlug}/${rel}`);
      }
    },

    async deleteSlug(slug) {
      const keys = await listKeys(slug);
      const meta = `${slug}/meta.json`;
      if (keys.includes(meta)) await deleteKeys([meta]); // invisibility first
      await deleteKeys(keys.filter((k) => k !== meta));
    },

    async init() {
      // Boot probe: prove the bucket is reachable and writable before accepting traffic, so
      // a misconfigured store crashes at startup (like the ARTIFACTS_API_KEY check) rather
      // than on first publish. The probe key is random and lives outside any slug namespace
      // (SLUG_LIKE also filters it from listings), so concurrent/rolling boots never race.
      const probeKey = `_boot_probe/${randomUUID()}`;
      const url = `${endpoint}/${bucket}/${encodeKey(prefix + probeKey)}`;
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const put = await client.fetch(url, { method: 'PUT', body: Buffer.from('ok') });
          // 4xx is a hard config error (bad creds, missing bucket, denied) — fail fast, no
          // retry. Only network errors and 5xx are transient and worth backing off on.
          if (put.status >= 400 && put.status < 500) {
            await drain(put);
            throw new Error(
              `S3 boot probe rejected (${put.status}) — check S3_BUCKET, credentials, and bucket policy`,
            );
          }
          if (!put.ok) {
            await drain(put);
            throw new Error(`transient S3 error ${put.status}`);
          }
          await drain(put);
          const del = await client.fetch(url, { method: 'DELETE' });
          await drain(del); // best-effort; a leftover probe object is harmless
          return;
        } catch (err) {
          if (/boot probe rejected/.test(err.message)) throw err; // config error: don't retry
          lastErr = err;
          if (attempt < 3) await sleep(250 * 2 ** attempt);
        }
      }
      throw new Error(`S3 storage unreachable after retries: ${lastErr?.message ?? 'unknown error'}`);
    },
  };

  return backend;
}
