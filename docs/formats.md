# Content formats

How each artifact type is rendered. ([← back to README](../README.md))

## HTML

Served as-is on its own page. No processing.

## Markdown

Rendered server-side (via marked) into a styled page. The original source stays available at `/a/:slug/source`. Markdown renders from its source on every view, so the settings below apply to existing artifacts the next time they load, with no re-publish.

### Markdown render settings

Four global knobs, set in the dashboard Settings popover or with `PUT /api/config`:

- `md.font`: `system`, `serif`, or `mono`.
- `md.width`: `narrow` (640px), `normal` (760px), or `wide` (900px).
- `md.size`: `small`, `normal`, or `large` base font size.
- `md.theme`: `auto` (follow the reader's OS), `light`, or `dark` as the starting theme.

Example:

```bash
curl -s -X PUT https://artifacts.example.com/api/config \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"md":{"font":"serif","width":"wide","size":"large","theme":"auto"}}'
```

A bad value on any key returns 400; absent keys keep their current value.

When the viewer frame is on, a Markdown artifact gets a navbar button that cycles Auto, Light, and Dark. The choice is saved in that reader's browser and overrides `md.theme` for them only. With the frame off there is no button, and the artifact uses `md.theme` (and the reader's OS when that is `auto`).

## JSX/TSX artifacts

Upload a single React component with a **default export**. Imports of `react`, `react-dom`, `recharts`, `lucide-react` are pinned; any other package import resolves via `https://esm.sh/<pkg>?external=react,react-dom` automatically. Tailwind classes work out of the box.

```jsx
import { useState } from 'react';
import { Rocket } from 'lucide-react';

export default function Demo() {
  const [n, setN] = useState(0);
  return (
    <button className="m-8 px-4 py-2 rounded bg-blue-600 text-white" onClick={() => setN(n + 1)}>
      <Rocket className="inline w-4 h-4 mr-2" />clicked {n}
    </button>
  );
}
```

Note: rendering uses esm.sh + Tailwind CDN, so artifacts need internet to render and take ~1–3 s on first load.

## Zip sites

A zipped static project (HTML + CSS + JS + images) served under `/a/{slug}/`. Upload via the web UI (drop a `.zip`), the [CLI](cli.md) (`artifacts deploy ./dir`), or the [zip endpoint](api.md#zip-sites-multi-file-static-projects) — validation rules and limits are documented there.

### Static framework builds (Astro, Vite, etc.)

Output from static site generators drops straight into the zip endpoint — an Astro `astro build` (or Vite/Eleventy/etc.) `dist/` folder is just HTML + CSS + JS. The one thing to watch: because sites are served under the `/a/{slug}/` **subpath**, a build that emits **root-absolute** asset URLs (`/_astro/app.css`, `/assets/index.js`) will 404 — those resolve to the domain root, not the artifact. Build with the framework's base/subpath option set to `/a/{slug}/`:

- **Astro** — `base: '/a/{slug}/'` in `astro.config.mjs`
- **Vite** — `base: '/a/{slug}/'` in `vite.config.js`
- **Next.js** (`next export`) — `basePath` + `assetPrefix` of `/a/{slug}/`

The slug you build for must match the slug you deploy to. See [`examples/astro-demo`](../examples/astro-demo) for a working Astro project.

### Flutter web (SPA)

A `flutter build web` output hosts as a zip site, but Flutter needs a bit more than a base path
because its engine pulls resources from Google CDNs by default. Build it **self-contained**:

- **Base href** — `flutter build web --base-href /a/{slug}/` (same subpath rule as above).
- **Local engine** — add `--no-web-resources-cdn` so CanvasKit/skwasm is served from the artifact
  rather than `gstatic.com` (which the artifact [CSP](../SECURITY.md) blocks).
- **Bundled font** — bundle a text font and set it as the app's default `fontFamily`, so the engine
  doesn't fetch its Roboto fallback from Google Fonts.

Use Flutter's default **hash** routing (`/#/…`); deep links then need no server-side SPA fallback.

The zip validator accepts Flutter's build artifacts (`AssetManifest.bin`, `NOTICES`, `*.frag`
shaders, `*.js.symbols`, the local `canvaskit/` wasm). See [`examples/flutter-demo`](../examples/flutter-demo)
for a working, fully self-contained Flutter web app.

> **Full-screen apps and the viewer frame:** by default artifacts render inside the viewer frame
> (below). A full-page app like Flutter runs fine inside the frame's iframe, but if you want it
> edge-to-edge, append `?raw=1` to the URL or turn the frame off for that artifact
> (`artifacts frame <slug> off`).

## Viewer frame

Any of the above can render inside a slim top **frame** — a toolbar with the title, a copy-link button, and a hide toggle — with the artifact itself isolated in an iframe. Toggle it globally from the web UI's **Settings** panel (or `artifacts config`), and override it per artifact (`artifacts frame <slug> on|off|default`). Append `?raw=1` to any URL to view the artifact with no frame. Full behavior in [docs/api.md](api.md#viewer-frame).
