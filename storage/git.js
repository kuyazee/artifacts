// Git-backed storage. Keeps a local working copy (a normal filesystem tree, so reads reuse
// the hardened local backend) and mirrors every change to a remote repository. On boot it
// clones/pulls the remote to rehydrate that working copy — which is what lets artifacts
// survive a fresh container with no persistent disk. Writes are committed and pushed on
// flush(), serialized through a mutex.
//
// Uses isomorphic-git: pure JS, no `git` binary and no shell — so a slug, filename, or
// commit message can never be interpreted as a shell command. The residual risks the design
// addresses explicitly: credentials must never land in the remote URL or logs (H4), the
// remote must be private (H5), a poisoned checkout must not escape the namespace (H6), and
// there must be a single writer (H8).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

import { createAt } from './local.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`storage backend "git" requires ${name}`);
  return v;
}

// Strip anything credential-shaped from a string before it is logged (H4): URL userinfo and
// common token query params. Errors from isomorphic-git / fetch often embed the remote URL.
function scrub(message) {
  return String(message ?? '')
    .replace(/\/\/[^/@\s]*@/g, '//') // https://user:pass@host -> https://host
    .replace(/([?&](?:token|access_token|private_token|x-oauth-basic)=)[^&\s]*/gi, '$1***');
}

// The remote URL must not embed credentials — those come only from the onAuth callback.
function validateRemoteUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('GIT_REMOTE_URL is not a valid URL');
  }
  if (u.username || u.password) {
    throw new Error('GIT_REMOTE_URL must not contain credentials — set GIT_TOKEN (or GIT_USERNAME/GIT_PASSWORD) instead');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('GIT_REMOTE_URL must be http(s)');
  }
  return u;
}

// A tiny promise mutex: commit+push must never run concurrently on one working copy.
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    // keep the chain alive even if fn rejects, but don't swallow the caller's error
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export async function create() {
  const workDir = path.resolve(process.env.GIT_WORK_DIR || process.env.DATA_DIR || '/data/git');
  const remoteUrl = requireEnv('GIT_REMOTE_URL');
  validateRemoteUrl(remoteUrl);
  const branch = process.env.GIT_BRANCH || 'main';
  const author = {
    name: process.env.GIT_AUTHOR_NAME || 'artifacts-host',
    email: process.env.GIT_AUTHOR_EMAIL || 'artifacts@localhost',
  };

  // Credentials are supplied ONLY through this callback, never in the URL (H4).
  const token = process.env.GIT_TOKEN;
  const username = process.env.GIT_USERNAME || (token ? 'x-access-token' : undefined);
  const password = process.env.GIT_PASSWORD || token;
  const onAuth = username || password ? () => ({ username, password }) : undefined;
  const onAuthFailure = () => {
    throw new Error('git authentication failed — check GIT_TOKEN / GIT_USERNAME / GIT_PASSWORD');
  };

  const common = { fs, http, dir: workDir, url: remoteUrl, onAuth, onAuthFailure };
  const artifactsRoot = path.join(workDir, 'artifacts');

  async function hasRepo() {
    try {
      await fsp.stat(path.join(workDir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  // Does the remote already have our branch? (An empty repo has no refs.) This drives the
  // clone-vs-init decision and avoids attempting to clone a branchless remote.
  async function remoteHasBranch() {
    try {
      const refs = await git.listServerRefs({
        http,
        url: remoteUrl,
        onAuth,
        onAuthFailure,
        prefix: `refs/heads/${branch}`,
      });
      return refs.some((r) => r.ref === `refs/heads/${branch}`);
    } catch (err) {
      throw new Error(`cannot reach git remote: ${scrub(err.message)}`);
    }
  }

  // Bring the working copy to match the remote branch. Boot-only, before serving.
  async function rehydrate() {
    await fsp.mkdir(workDir, { recursive: true });
    const populated = await remoteHasBranch();
    if (await hasRepo()) {
      if (populated) {
        // Remote is the source of truth: fetch it and hard-checkout the branch.
        await git.fetch({ ...common, ref: branch, singleBranch: true, tags: false });
        await git.checkout({ fs, dir: workDir, ref: branch, force: true });
      }
      return;
    }
    if (populated) {
      await git.clone({ ...common, ref: branch, singleBranch: true, depth: 1 });
    } else {
      // Empty remote: initialize a fresh repo wired to it; the first flush() creates the branch.
      await git.init({ fs, dir: workDir, defaultBranch: branch });
      await git.addRemote({ fs, dir: workDir, remote: 'origin', url: remoteUrl });
    }
  }

  // Guard the rehydrated tree the same way zip ingest guards uploads (H6): a remote must not
  // be able to introduce a symlink or an escaping path that the serving layer would follow.
  // (createAt's reads also refuse symlinks at request time; this fails fast at boot.)
  async function assertCleanCheckout() {
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          throw new Error(`refusing to serve: symlink in rehydrated repo at ${path.relative(workDir, full)}`);
        }
        if (e.isDirectory()) await walk(full);
      }
    }
    await walk(artifactsRoot).catch((err) => {
      if (/refusing to serve/.test(err.message)) throw err;
    });
  }

  await rehydrate();
  await fsp.mkdir(artifactsRoot, { recursive: true });
  await assertCleanCheckout();

  // Reads, writes-to-working-copy, symlink refusal and containment all come from the local
  // backend rooted at the working copy's artifacts dir.
  const files = await createAt(artifactsRoot);
  const withLock = createMutex();

  // Stage every add/modify/delete under artifacts/ (git.add alone does not stage deletes).
  async function stageAll() {
    const matrix = await git.statusMatrix({ fs, dir: workDir, filter: (f) => f.startsWith('artifacts/') });
    let changes = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === workdir && workdir === stage) continue; // unchanged
      if (workdir === 0) {
        await git.remove({ fs, dir: workDir, filepath });
      } else {
        await git.add({ fs, dir: workDir, filepath });
      }
      changes++;
    }
    return changes;
  }

  async function commitAndPush() {
    const changes = await stageAll();
    if (!changes) return; // nothing to persist
    await git.commit({ fs, dir: workDir, message: 'update artifacts', author });
    try {
      await git.push({ ...common, ref: branch, remoteRef: branch });
    } catch (err) {
      // Durability failed. Surface it (the API returns 5xx, never a false 201). The local
      // commit stays and a later successful flush will carry it; on restart the remote is
      // the source of truth. A non-fast-forward here means a second writer exists — the git
      // backend requires a single writer (documented).
      throw new Error(`git push failed (is the remote reachable and are you the only writer?): ${scrub(err.message)}`);
    }
  }

  return {
    kind: 'git',
    streams: true,

    get: (key, opts) => files.get(key, opts),
    getBuffer: (key) => files.getBuffer(key),
    head: (key) => files.head(key),
    listMetas: () => files.listMetas(),
    put: (key, data, opts) => files.put(key, data, opts),
    move: (oldSlug, newSlug) => files.move(oldSlug, newSlug),
    copySlug: (src, dst) => files.copySlug(src, dst),
    deleteSlug: (slug) => files.deleteSlug(slug),

    // Commit the completed write and push it, serialized so two operations never race the
    // index/working copy. Awaited by server.js before it returns success (durable-on-return).
    flush: () => withLock(commitAndPush),
  };
}
