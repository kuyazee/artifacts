# Content formats

How each artifact type is rendered. ([← back to README](../README.md))

## HTML

Served as-is on its own page. No processing.

## Markdown

Rendered server-side (via marked) into a styled page. The original source stays available at `/a/:slug/source`.

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

## Viewer frame

Any of the above can render inside a slim top **frame** — a toolbar with the title, a copy-link button, and a hide toggle — with the artifact itself isolated in an iframe. Toggle it globally from the web UI's **Settings** panel (or `artifacts config`), and override it per artifact (`artifacts frame <slug> on|off|default`). Append `?raw=1` to any URL to view the artifact with no frame. Full behavior in [docs/api.md](api.md#viewer-frame).
