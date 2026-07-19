# astro-demo

A minimal [Astro](https://astro.build) site showing how to deploy a static
framework build to a self-hosted **artifacts** instance.

Artifacts hosts zipped static sites under **`/a/<slug>/`**. Astro's default
build emits **root-absolute** asset URLs (`/_astro/*.css`, `/favicon.svg`),
which resolve to the domain root and 404 under that subpath. The fix is to build
Astro with [`base`](https://docs.astro.build/en/reference/configuration-reference/#base)
set to the artifact's path — see [`astro.config.mjs`](./astro.config.mjs).

> **Rule:** `base` must equal `/a/<your-slug>/`, and you must deploy to that same
> `<slug>`. The two have to match.

## Build & deploy

Build for the default slug (`astro-demo`):

```bash
npm install
npm run build          # outputs ./dist with base=/a/astro-demo/
```

Deploy the build with the [CLI](../../docs/cli.md) (from this directory):

```bash
export ARTIFACTS_URL=https://artifacts.example.com
export ARTIFACTS_API_KEY=your-key
artifacts deploy ./dist --slug astro-demo
# https://artifacts.example.com/a/astro-demo/ (N files)
```

…or with plain `curl` against the [zip endpoint](../../docs/api.md#zip-sites-multi-file-static-projects):

```bash
cd dist && zip -qr ../site.zip . && cd ..
curl -s -X POST "$ARTIFACTS_URL/api/artifacts/zip?slug=astro-demo" \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip
```

## Using a different slug

Pass the slug at build time so `base` matches your deploy target:

```bash
ARTIFACT_SLUG=my-cool-site npm run build
artifacts deploy ./dist --slug my-cool-site
```
