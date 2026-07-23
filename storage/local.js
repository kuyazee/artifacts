// Local-filesystem backend (default). Stores each artifact as plain files under
// `${DATA_DIR}/artifacts/<slug>/...`, exactly as the server always has — so an existing
// `/data` volume keeps working with zero migration.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { assertSafeKey, UnsafeKeyError } from './index.js';

function isMissing(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

export async function create() {
  const dataDir = path.resolve(process.env.DATA_DIR || '/data');
  return createAt(path.join(dataDir, 'artifacts'));
}

// Build a filesystem-backed store rooted at an arbitrary directory. Exported so other
// backends (e.g. git, whose working copy is a local tree) can reuse the hardened read/
// write/serve logic — streaming range reads, symlink refusal, realpath containment — and
// layer their own durability on top.
export async function createAt(root) {
  await fs.mkdir(root, { recursive: true });
  // Resolve the root through any symlinks once (e.g. /tmp -> /private/tmp) so containment
  // checks compare real paths against a real base.
  const realRoot = await fs.realpath(root);

  // Map a validated key to an absolute path and confirm it stays within `root`. The guard
  // already rejects `..`/absolute/backslash segments; this is belt-and-suspenders against
  // path.join surprises.
  function resolveKey(key) {
    assertSafeKey(key);
    const abs = path.join(root, key);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new UnsafeKeyError('key escapes storage root');
    }
    return abs;
  }

  // Refuse symlinks and confirm the real path is still inside realRoot, so a symlink
  // planted out-of-band can never be followed out of the namespace. Returns the lstat, or
  // null if the target is missing / a symlink / a directory (not a servable object).
  async function statFile(abs) {
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (st.isSymbolicLink() || st.isDirectory()) return null;
    let real;
    try {
      real = await fs.realpath(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return st;
  }

  return {
    kind: 'local',
    streams: true,

    async getBuffer(key) {
      const abs = resolveKey(key);
      if (!(await statFile(abs))) return null;
      try {
        return await fs.readFile(abs);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async head(key) {
      const st = await statFile(resolveKey(key));
      return st ? { size: st.size } : null;
    },

    async get(key, { range } = {}) {
      const abs = resolveKey(key);
      const st = await statFile(abs);
      if (!st) return null;
      if (range) {
        return {
          stream: createReadStream(abs, { start: range.start, end: range.end }),
          size: st.size,
        };
      }
      return { stream: createReadStream(abs), size: st.size };
    },

    async put(key, data) {
      const abs = resolveKey(key);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, data);
    },

    async listMetas() {
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
      const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const metas = await Promise.all(
        slugs.map(async (slug) => {
          const buffer = await this.getBuffer(`${slug}/meta.json`).catch(() => null);
          return buffer ? { slug, buffer } : null;
        }),
      );
      return metas.filter(Boolean);
    },

    async move(oldSlug, newSlug) {
      await fs.rename(resolveKey(oldSlug), resolveKey(newSlug));
    },

    // Copy a whole namespace's content objects to a new slug. Skips the top-level
    // meta.json so the caller can write the copy's meta LAST (the commit marker) — a crash
    // mid-copy then leaves the destination invisible (no meta), never half-served.
    async copySlug(srcSlug, dstSlug) {
      const absSrc = resolveKey(srcSlug);
      const absDst = resolveKey(dstSlug);
      const skipMeta = path.join(absSrc, 'meta.json');
      await fs.cp(absSrc, absDst, {
        recursive: true,
        filter: (source) => source !== skipMeta,
      });
    },

    async deleteSlug(slug) {
      // meta.json first so a crash mid-delete leaves an invisible (404) namespace, never a
      // live artifact with missing files.
      await fs.rm(resolveKey(`${slug}/meta.json`), { force: true });
      await fs.rm(resolveKey(slug), { recursive: true, force: true });
    },
  };
}
