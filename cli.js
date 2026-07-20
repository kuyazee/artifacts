#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import AdmZip from 'adm-zip';

const USAGE = `artifacts — publish to a self-hosted artifacts instance

Usage:
  artifacts publish <file> [--slug s] [--title t] [--tags a,b] [--project p] [--expires ISO] [--type html|jsx|tsx|md] [--frame on|off]
  artifacts deploy <dir|zip> [--slug s] [--title t] [--tags a,b] [--project p] [--expires ISO]
  artifacts update <slug> <file> [--title t] [--tags a,b] [--project p] [--type html|jsx|tsx|md]
  artifacts list [--tag t] [--project p]
  artifacts rename <slug> <new-slug>
  artifacts disable <slug>
  artifacts enable <slug>
  artifacts frame <slug> <on|off|default>
  artifacts expire <slug> <ISO-date|never>
  artifacts tag <slug> <a,b,c|none>
  artifacts project <slug> <name|none>
  artifacts delete <slug>
  artifacts source <slug> [-o file]
  artifacts config [--frame-enabled true|false] [--frame-default true|false]
  artifacts keys list
  artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]
  artifacts keys revoke <id>

Connection (flags override env):
  --url   server origin        [env: ARTIFACTS_URL]
  --key   API key              [env: ARTIFACTS_API_KEY]

The key can be a managed key (scoped) or the bootstrap ARTIFACTS_API_KEY.
Minting keys (keys create/list/revoke) requires the bootstrap admin key.`;

const EXT_TYPES = { '.html': 'html', '.htm': 'html', '.jsx': 'jsx', '.tsx': 'tsx', '.md': 'md', '.markdown': 'md' };

const { values: opts, positionals } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    tags: { type: 'string' },
    tag: { type: 'string' },
    project: { type: 'string' },
    expires: { type: 'string' },
    scopes: { type: 'string' },
    type: { type: 'string' },
    frame: { type: 'string' },
    'frame-enabled': { type: 'string' },
    'frame-default': { type: 'string' },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

const [command, ...args] = positionals;

if (opts.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const url = (opts.url || process.env.ARTIFACTS_URL || '').replace(/\/$/, '');
const key = opts.key || process.env.ARTIFACTS_API_KEY;

if (!url) fail('server URL required: pass --url or set ARTIFACTS_URL');

async function api(method, apiPath, { body, contentType, auth = true } = {}) {
  if (auth && !key) fail('API key required: pass --key or set ARTIFACTS_API_KEY');
  const headers = {};
  if (auth) headers.authorization = `Bearer ${key}`;
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(url + apiPath, { method, headers, body });
  const text = await res.text();
  if (!res.ok) fail(`${res.status} ${res.statusText}: ${text.trim()}`);
  return text;
}

async function apiJson(method, apiPath, body) {
  const text = await api(method, apiPath, {
    body: body === undefined ? undefined : JSON.stringify(body),
    contentType: body === undefined ? undefined : 'application/json',
  });
  return JSON.parse(text);
}

function fail(message) {
  console.error(`artifacts: ${message}`);
  process.exit(1);
}

function inferType(file) {
  if (opts.type) return opts.type;
  const type = EXT_TYPES[path.extname(file).toLowerCase()];
  if (!type) fail(`cannot infer type from "${file}" — pass --type html|jsx|tsx|md`);
  return type;
}

function need(count, hint) {
  if (args.length < count) fail(`usage: artifacts ${command} ${hint}`);
}

function parseBool(value, name) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  fail(`${name} must be true or false`);
}

switch (command) {
  case 'publish': {
    need(1, '<file> [--slug s] [--title t] [--expires ISO] [--type t] [--frame on|off]');
    if (opts.frame !== undefined && !['on', 'off', 'default'].includes(opts.frame)) {
      fail('--frame must be on, off, or default');
    }
    const content = await fs.readFile(args[0], 'utf8');
    const out = await apiJson('POST', '/api/artifacts', {
      content,
      type: inferType(args[0]),
      ...(opts.slug && { slug: opts.slug }),
      ...(opts.title && { title: opts.title }),
      ...(opts.tags !== undefined && { tags: opts.tags }),
      ...(opts.project !== undefined && { project: opts.project }),
      ...(opts.expires && { expiresAt: opts.expires }),
      ...(opts.frame && opts.frame !== 'default' && { frame: opts.frame === 'on' }),
    });
    console.log(out.url);
    break;
  }

  case 'deploy': {
    need(1, '<dir|zip> [--slug s] [--title t] [--expires ISO]');
    const target = args[0];
    let zipBuffer;
    if ((await fs.stat(target)).isDirectory()) {
      const zip = new AdmZip();
      zip.addLocalFolder(target);
      zipBuffer = zip.toBuffer();
    } else {
      zipBuffer = await fs.readFile(target);
    }
    const params = new URLSearchParams();
    if (opts.slug) params.set('slug', opts.slug);
    if (opts.title) params.set('title', opts.title);
    if (opts.tags) params.set('tags', opts.tags);
    if (opts.project) params.set('project', opts.project);
    if (opts.expires) params.set('expiresAt', opts.expires);
    const qs = params.size ? `?${params}` : '';
    const out = JSON.parse(await api('POST', `/api/artifacts/zip${qs}`, {
      body: zipBuffer,
      contentType: 'application/zip',
    }));
    console.log(`${out.url} (${out.files} files)`);
    break;
  }

  case 'update': {
    need(2, '<slug> <file> [--title t] [--type t]');
    const content = await fs.readFile(args[1], 'utf8');
    const out = await apiJson('PUT', `/api/artifacts/${args[0]}`, {
      content,
      type: inferType(args[1]),
      ...(opts.title && { title: opts.title }),
      ...(opts.tags !== undefined && { tags: opts.tags }),
      ...(opts.project !== undefined && { project: opts.project }),
    });
    console.log(out.url);
    break;
  }

  case 'list': {
    const params = new URLSearchParams();
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.project) params.set('project', opts.project);
    const qs = params.size ? `?${params}` : '';
    const artifacts = await apiJson('GET', `/api/artifacts${qs}`);
    for (const a of artifacts) {
      const frameFlag = a.frame === true ? 'frame:on' : a.frame === false ? 'frame:off' : null;
      const flags = [a.disabled && 'disabled', frameFlag, a.expiresAt && `expires ${a.expiresAt}`].filter(Boolean);
      const project = a.project ? `@${a.project}` : '';
      const tags = a.tags?.length ? `#${a.tags.join(' #')}` : '';
      const meta = [project, tags].filter(Boolean).join(' ');
      console.log(
        `${a.slug}\t${a.type}\t${a.title || ''}${meta ? `\t${meta}` : ''}${flags.length ? `\t[${flags.join(', ')}]` : ''}`,
      );
    }
    break;
  }

  case 'rename': {
    need(2, '<slug> <new-slug>');
    const out = await apiJson('PATCH', `/api/artifacts/${args[0]}`, { slug: args[1] });
    console.log(out.url);
    break;
  }

  case 'disable':
  case 'enable': {
    need(1, '<slug>');
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { disabled: command === 'disable' });
    console.log(`${args[0]} ${command}d`);
    break;
  }

  case 'frame': {
    need(2, '<slug> <on|off|default>');
    const map = { on: true, off: false, default: null };
    if (!Object.hasOwn(map, args[1])) fail('frame value must be on, off, or default');
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { frame: map[args[1]] });
    console.log(`${args[0]} frame ${args[1]}`);
    break;
  }

  case 'config': {
    const frame = {};
    if (opts['frame-enabled'] !== undefined) frame.enabled = parseBool(opts['frame-enabled'], '--frame-enabled');
    if (opts['frame-default'] !== undefined) frame.default = parseBool(opts['frame-default'], '--frame-default');
    const out = Object.keys(frame).length
      ? await apiJson('PUT', '/api/config', { frame })
      : await apiJson('GET', '/api/config');
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'expire': {
    need(2, '<slug> <ISO-date|never>');
    const expiresAt = args[1] === 'never' ? null : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { expiresAt });
    console.log(expiresAt ? `${args[0]} expires ${expiresAt}` : `${args[0]} expiry cleared`);
    break;
  }

  case 'tag': {
    need(2, '<slug> <a,b,c|none>');
    const tags = args[1] === 'none' ? [] : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { tags });
    console.log(args[1] === 'none' ? `${args[0]} tags cleared` : `${args[0]} tagged: ${args[1]}`);
    break;
  }

  case 'project': {
    need(2, '<slug> <name|none>');
    const project = args[1] === 'none' ? '' : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { project });
    console.log(args[1] === 'none' ? `${args[0]} project cleared` : `${args[0]} → project ${args[1]}`);
    break;
  }

  case 'delete': {
    need(1, '<slug>');
    await apiJson('DELETE', `/api/artifacts/${args[0]}`);
    console.log(`${args[0]} deleted`);
    break;
  }

  case 'keys': {
    const sub = args[0];
    if (sub === 'list') {
      const keys = await apiJson('GET', '/api/keys');
      for (const k of keys) {
        const flags = [
          k.disabled && 'disabled',
          k.expiresAt && `expires ${k.expiresAt.slice(0, 10)}`,
          k.lastUsedAt ? `used ${k.lastUsedAt.slice(0, 10)}` : 'never used',
        ].filter(Boolean);
        console.log(`${k.id}\t${k.name}\t${k.scopes.join('/')}\t${k.prefix}…\t[${flags.join(', ')}]`);
      }
    } else if (sub === 'create') {
      if (!args[1]) fail('usage: artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]');
      const scopes = opts.scopes
        ? opts.scopes.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const out = await apiJson('POST', '/api/keys', {
        name: args[1],
        ...(scopes && { scopes }),
        ...(opts.expires && { expiresAt: opts.expires }),
      });
      // The full token is printed once — store it now, it is not recoverable.
      console.log(out.key);
    } else if (sub === 'revoke') {
      if (!args[1]) fail('usage: artifacts keys revoke <id>');
      await apiJson('DELETE', `/api/keys/${args[1]}`);
      console.log(`${args[1]} revoked`);
    } else {
      fail('usage: artifacts keys <list|create|revoke>');
    }
    break;
  }

  case 'source': {
    need(1, '<slug> [-o file]');
    const text = await api('GET', `/a/${args[0]}/source`, { auth: false });
    if (opts.output) {
      await fs.writeFile(opts.output, text);
      console.log(opts.output);
    } else {
      process.stdout.write(text);
    }
    break;
  }

  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
