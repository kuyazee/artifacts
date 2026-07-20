# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/kuyazee/artifacts/security/advisories/new) — do not open a public issue. You should get a response within a few days.

## Security model (what is and isn't a bug)

This service intentionally executes uploaded HTML/JS in the visitor's browser — that's the product. The boundaries that **are** enforced:

- **Writes require a valid credential.** Any way to create, modify, or delete artifacts without a valid API key (a scoped [managed key](docs/auth.md) or the bootstrap `ARTIFACTS_API_KEY`) is a vulnerability. Key scopes are enforced server-side: a `read` or `publish` key performing an action above its scope is a vulnerability.
- **Reads are gated by unguessable slugs.** Any way to enumerate or list artifacts without a key is a vulnerability.
- **Admin session isolation.** The dashboard authenticates with a scrypt-hashed password and a signed, HttpOnly, `SameSite=Strict` session cookie; artifact responses never set or depend on cookies. Minting/listing/revoking keys requires the admin session or the bootstrap key — a managed key, even `full`, must not be able to. Managed keys are stored only as sha256 hashes; the password is never stored in the clear.
- **The filesystem is contained.** Path traversal out of an artifact's directory (via URLs or zip contents) is a vulnerability.
- **Artifacts must not be indexable** (`X-Robots-Tag`, `robots.txt`).
- **Hardening headers stay on artifact responses:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that limits external requests to esm.sh and major CDNs. Regressions here are vulnerabilities.

Not vulnerabilities:

- Uploaded content doing arbitrary things *within its own page* (that's by design — deploy on a dedicated subdomain that serves nothing else and sets no cookies, as [docs/deploy.md](docs/deploy.md) instructs).
- Ambient authority from co-hosting. If you ignore that rule and serve artifacts from the **same origin** as the dashboard/API, an uploaded page's JavaScript runs same-origin and can ride the admin's session cookie to call `/api/*`. The origin-separation deployment rule is the mitigation; co-hosting is a misconfiguration, not a server bug.
- Issues requiring possession of an API key.
