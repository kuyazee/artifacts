// Pluggable storage layer.
//
// Artifacts are addressed by object *keys* of the shape `<slug>/<relpath>` — e.g.
// `my-slug/meta.json`, `my-slug/index.html`, `my-slug/site/assets/app.css`. Keys mirror
// the original on-disk layout so an existing local `/data` volume needs no migration.
//
// Backends implement the small interface below; business logic (validation, rendering,
// meta shape) stays in server.js. Selecting a backend loads only that backend's optional
// dependency — a plain `local` install pulls nothing extra.
//
//   interface Storage {
//     getBuffer(key)            -> Buffer | null                 // small reads (meta.json)
//     get(key, { range })       -> { stream, size } | null       // streamed body for serving
//     head(key)                 -> { size } | null               // existence / size, no body
//     put(key, data, { contentType })                            // MUST await a durable write
//     listMetas()               -> [{ slug, buffer }]            // every artifact's meta.json
//     move(oldSlug, newSlug)                                     // rename a whole namespace
//     deleteSlug(slug)                                           // remove a whole namespace
//   }
//
// Write-ordering contract (crash-consistency without transactions): callers write all
// content objects first and `<slug>/meta.json` LAST as a commit marker, because readMeta
// and listMetas key off meta.json — a namespace with no meta is invisible (404), never
// half-served. deleteSlug removes meta first. See server.js for where this is applied.

// A key/segment that fails validation. Callers map this to 404 (it only reaches a backend
// via user-controlled zip sub-paths); it must never surface as a 500.
export class UnsafeKeyError extends Error {}

// NUL, other C0 control chars, and DEL — never legitimate in an artifact key.
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// The single choke-point guard, applied by every backend method on the raw key before it
// is joined to any root. Defense in depth on top of SLUG_RE (server.js) and the zip-ingest
// guards. Segment-based, so `..` can never be smuggled through normalization.
export function assertSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new UnsafeKeyError('empty key');
  }
  if (CONTROL_RE.test(key)) throw new UnsafeKeyError('control character in key');
  if (key.includes('\\')) throw new UnsafeKeyError('backslash in key');
  if (key.startsWith('/')) throw new UnsafeKeyError('absolute key');
  for (const segment of key.split('/')) {
    // Rejects leading/trailing slash and `//` (empty segment) plus `.` / `..`.
    if (segment === '') throw new UnsafeKeyError('empty path segment');
    if (segment === '.' || segment === '..') throw new UnsafeKeyError('relative path segment');
  }
  return key;
}

const BACKENDS = {
  local: () => import('./local.js'),
  s3: () => import('./s3.js'),
  // git, postgres, sqlite are added in later phases; each is loaded on demand so a
  // backend's dependency is only required when that backend is selected.
};

// Instantiate the configured backend and run its boot check (fail-fast, like the
// ARTIFACTS_API_KEY check) so a misconfigured store crashes at startup, not first request.
export async function createStorage() {
  const name = process.env.STORAGE_BACKEND || 'local';
  const loader = BACKENDS[name];
  if (!loader) {
    const known = Object.keys(BACKENDS).join(', ');
    throw new Error(`unknown STORAGE_BACKEND "${name}" (available: ${known})`);
  }
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    throw new Error(
      `storage backend "${name}" could not be loaded — is its dependency installed? (${err.message})`,
    );
  }
  const storage = await mod.create();
  await storage.init?.();
  return storage;
}
