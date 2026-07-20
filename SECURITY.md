# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/kuyazee/artifacts/security/advisories/new) — do not open a public issue. You should get a response within a few days.

## Security model (what is and isn't a bug)

This service intentionally executes uploaded HTML/JS in the visitor's browser — that's the product. The boundaries that **are** enforced:

- **Writes require a valid credential.** Any way to create, modify, or delete artifacts without a valid API key (a scoped [managed key](docs/auth.md) or the bootstrap `ARTIFACTS_API_KEY`) is a vulnerability. Key scopes are enforced server-side: a `read` or `publish` key performing an action above its scope is a vulnerability.
- **Reads are gated by unguessable slugs.** Any way to enumerate or list artifacts without a key is a vulnerability.
- **Visibility gates are enforced on every serve path.** An artifact set to `private` or `password` ([visibility](docs/api.md#visibility)) must not serve its body without a valid unlock cookie — via `/a/:slug`, `?raw=1`, `/a/:slug/source`, or any zip sub-asset. Serving a locked artifact through any of those paths is a vulnerability, as is `private` returning anything but `404` for a sub-resource (it must not leak existence). Unlock passwords are scrypt-hashed and never returned by the API; the unlock cookie is HMAC-signed and scoped to one slug. The unlock and login endpoints are rate-limited (10 failures per window per client IP; see [deploying](docs/deploy.md#rate-limiting-and-the-edge)) and scrypt runs off the event loop, so a flood degrades those two routes rather than stalling the process. A determined attacker with many IPs can still grind a weak per-artifact password — use a strong one.
- **Admin session isolation.** The dashboard authenticates with a scrypt-hashed password and a signed, HttpOnly, `SameSite=Strict` session cookie. Artifact responses never set or depend on the **dashboard session** cookie; the only cookie an artifact response sets is the unlock cookie for a `private`/`password` artifact — HttpOnly, `SameSite=Lax`, and scoped to `Path=/a/<slug>`, so it neither rides to `/api/*` nor to another slug. Minting/listing/revoking keys requires the admin session or the bootstrap key — a managed key, even `full`, must not be able to. Managed keys are stored only as sha256 hashes; the password is never stored in the clear.
- **The filesystem is contained.** Path traversal out of an artifact's directory (via URLs or zip contents) is a vulnerability.
- **Artifacts must not be indexable** (`X-Robots-Tag`, `robots.txt`).
- **Hardening headers stay on artifact responses:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that limits external requests to esm.sh and major CDNs. Regressions here are vulnerabilities.

Not vulnerabilities:

- Uploaded content doing arbitrary things *within its own page* (that's by design — deploy on a dedicated subdomain that serves nothing else and sets no cookies, as [docs/deploy.md](docs/deploy.md) instructs).
- Ambient authority from co-hosting. If you ignore that rule and serve artifacts from the **same origin** as the dashboard/API, an uploaded page's JavaScript runs same-origin and can ride the admin's session cookie to call `/api/*`. The origin-separation deployment rule is the mitigation; co-hosting is a misconfiguration, not a server bug.
- Issues requiring possession of an API key.
