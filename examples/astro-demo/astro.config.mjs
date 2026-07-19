import { defineConfig } from 'astro/config';

// Artifacts serves every zip site under `/a/<slug>/`, so Astro must be built
// with `base` set to that exact subpath. Without it Astro emits root-absolute
// asset URLs (`/_astro/*.css`) that 404 when the site lives under `/a/<slug>/`.
//
// `base` must equal `/a/<your-slug>/`. Override the slug at build time with:
//   ARTIFACT_SLUG=my-slug npm run build
const slug = process.env.ARTIFACT_SLUG || 'astro-demo';

export default defineConfig({
  base: `/a/${slug}/`,
  // Emit CSS as an external /_astro/*.css file (instead of inlining it) so the
  // build exercises real subpath-relative asset loading — the exact thing that
  // 404s on a naive, base-less build.
  build: { inlineStylesheets: 'never' },
});
