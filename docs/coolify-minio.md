# Coolify + MinIO (durable storage without AWS)

Run artifacts on [Coolify](https://coolify.io) with [MinIO](https://min.io) as the durable object
store. MinIO speaks the S3 API, so this is the `s3` backend pointed at your own box instead of AWS
— every artifact lives in MinIO, and the app container holds no state. ([← back to README](../README.md))

Reach for this when the app host wipes local disk on redeploy, when you want your data on
hardware you control, or when you already run Coolify and would rather not depend on a cloud
bucket. For the AWS/R2/B2 version of the same backend, see [S3](deploy.md#s3-and-s3-compatible-r2-b2-minio-spaces-wasabi-gcs-interop).

## The shape

Two Coolify resources on one project, talking over the internal Docker network:

```
MinIO  (minio/minio)  ── volume /data  ← the durable store, back this up
  ▲  S3 API :9000 (internal)
  │
artifacts  (this repo) ── STORAGE_BACKEND=s3 → MinIO ── no volume, stateless
  ▲  :3000 → your reverse proxy → https://artifacts.example.com
```

Because artifacts state (every artifact **and** the reserved `auth.json` — admin account,
session secret, managed keys) all go through the storage backend, once the backend is MinIO the
app container is throwaway. Back up MinIO's volume and you have backed up everything.

## Why MinIO "just works" here

The `s3` backend addresses objects **path-style** (`ENDPOINT/BUCKET/key`), not virtual-hosted
(`BUCKET.ENDPOINT/key`). That is MinIO's native style, so `S3_ENDPOINT` is just the MinIO host
with **no bucket in the hostname** and no wildcard DNS to set up. Requests are signed SigV4 via
`aws4fetch`, which ships in the Docker image (`npm ci --omit=dev` keeps optional deps), so there
is nothing extra to install.

## Step 1 — MinIO on Coolify

Add a resource for MinIO. Coolify has a MinIO service template; or add a Docker-image resource:

- **Image:** `minio/minio`
- **Command:** `server /data --console-address ":9001"`
- **Volume:** persistent volume mounted at **`/data`** — this is the real durable store, so put it
  on disk you back up.
- **Env:**
  ```
  MINIO_ROOT_USER=<admin-user>
  MINIO_ROOT_PASSWORD=<strong-password>
  ```
- **Ports:** API `9000`, console `9001`. Give the **console** a domain (or a Coolify-tunneled URL)
  so you can reach the web UI; the **API** can stay internal — see step 3.

Bring it up, open the console (`:9001`), log in with the root creds, then:

1. **Create a bucket** named `artifacts`. Leave its access policy **private** (the default). Never
   set a public / anonymous download policy — artifacts are only ever served back *through* the
   app so their `noindex`, expiry, disable, and visibility checks apply; a public bucket bypasses
   all of it.
2. **Create an access key** for the app (Access Keys → Create). Use this scoped key in step 2,
   **not** the MinIO root credentials. Give it read/write on the `artifacts` bucket only.

(CLI alternative with `mc`: `mc alias set local http://minio:9000 <root-user> <root-pass>` then
`mc mb local/artifacts` and `mc admin user svcacct add …`.)

## Step 2 — artifacts on Coolify

Add a second resource for this app:

- **Source:** this repo with Build Pack **Dockerfile**, or the prebuilt image
  `ghcr.io/kuyazee/artifacts:latest`.
- **Port:** `3000`. Point a domain at it (`https://artifacts.example.com`) through Coolify's proxy.
- **No `/data` volume needed** — state lives in MinIO. (A volume does no harm, it just goes unused.)
- **Healthcheck:** leave Coolify's container healthcheck **disabled**. `node:22-slim` has no
  `curl`/`wget`, so an enabled healthcheck marks the container unhealthy and blocks routing. Point
  an external monitor at `GET /healthz` instead.
- **Env vars:**

  ```
  ARTIFACTS_API_KEY=<openssl rand -hex 32>     # bootstrap admin bearer, required
  BASE_URL=https://artifacts.example.com        # public origin in returned URLs

  STORAGE_BACKEND=s3
  S3_ENDPOINT=http://<minio-service>:9000       # MinIO API, internal (see step 3)
  S3_BUCKET=artifacts
  S3_ACCESS_KEY_ID=<the access key from step 1>
  S3_SECRET_ACCESS_KEY=<the secret from step 1>
  S3_REGION=us-east-1                           # MinIO ignores it; any value, keep the default
  # S3_PREFIX=artifacts/                        # optional, if the bucket is shared
  ```

  Full meaning of every var is in [deploy.md](deploy.md#configuration) and
  [the S3 table](deploy.md#s3-and-s3-compatible-r2-b2-minio-spaces-wasabi-gcs-interop).

## Step 3 — keep S3 traffic on the internal network

Point `S3_ENDPOINT` at MinIO's **internal** address so object bytes never leave the Docker host:
put both resources in the **same Coolify project/network** and use the MinIO service's internal
hostname (`http://<minio-service>:9000`). Internal `http` between the two containers is fine —
it's a private hop, and it dodges TLS-cert hassles on the S3 leg.

Only expose the MinIO **API** publicly if a machine outside the host must reach it. If you do, use
`https://` with a **real certificate** — `aws4fetch` uses `fetch`, which rejects a self-signed
cert, so a bad cert makes the app fail its boot probe. Even then, keep the **bucket private**; the
public S3 endpoint is not a public artifact endpoint.

## Bring up and verify

Deploy MinIO first, then artifacts. On boot the app runs a **write/delete probe** against the
bucket and **refuses to start** if MinIO is unreachable or the creds/bucket are wrong — so a
misconfig fails loudly in the deploy log, it never comes up serving empty. If it crashes at boot,
read the log:

- `S3 boot probe rejected (403)` → bad access key/secret, or the key lacks write on the bucket.
- `S3 boot probe rejected (404)` → `S3_BUCKET` does not exist (create it in step 1).
- `unreachable after retries` → `S3_ENDPOINT` wrong, or the two resources aren't on one network.

Once green, publish a test artifact and confirm it survives a redeploy:

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"<h1>minio ok</h1>","type":"html","slug":"minio-ok","visibility":"public"}'

# Redeploy the artifacts app in Coolify, then:
curl -sS -o /dev/null -w '%{http_code}\n' https://artifacts.example.com/a/minio-ok   # still 200
```

The artifact surviving a redeploy of the **app** (which has no volume) is the whole point — the
bytes were in MinIO the entire time.

## MinIO notes

| Topic | Detail |
|---|---|
| Addressing | Path-style — the backend builds `ENDPOINT/BUCKET/key`. MinIO's native mode; no wildcard DNS. |
| Region | MinIO ignores `S3_REGION`; SigV4 still needs *a* value. Keep `us-east-1`. |
| Rename | Uses server-side `CopyObject` (`x-amz-copy-source`), which MinIO supports. |
| Credentials | Use a scoped access key, never `MINIO_ROOT_*`. Revoke it in the console without touching root. |
| Bucket policy | Private, always. Serving happens through the app, not the bucket. |
| Durability | MinIO's `/data` volume is the source of truth — back it up (or run MinIO distributed/erasure-coded). |
| Prefix | Set `S3_PREFIX=artifacts/` if the bucket holds other things; keys stay namespaced. |

## Behind Cloudflare or a reverse proxy

The app rate-limits its two unauthenticated routes (login, unlock) per client IP. Behind a proxy
that number is only right if you tell it where the real client IP comes from — set `TRUST_PROXY`
(`cloudflare` or `xff`) as covered in [rate limiting and the edge](deploy.md#rate-limiting-and-the-edge).

If Coolify sits behind a **Cloudflare tunnel** that terminates TLS, set the app's FQDN in Coolify
as `http://` (not `https://`) — the tunnel already did TLS, and a second TLS attempt at the proxy
gives `SSL_ERROR_RX_RECORD_TOO_LONG`. This is about the app's public FQDN, separate from the
internal `S3_ENDPOINT` in step 3.

## Security follow-ups

- **Rotate `ARTIFACTS_API_KEY` and the MinIO access key** after setup if either transited a chat,
  a paste, or a shared terminal. Day-to-day, hand CLI/MCP clients scoped [managed keys](auth.md),
  not the bootstrap key.
- **Keep the bucket private and the S3 endpoint internal.** The only public surface should be the
  artifacts app's own origin.
- Serve artifacts from a **dedicated origin** that hosts nothing else — see the
  [deployment rule](deploy.md#deployment-rule-security) and [SECURITY.md](../SECURITY.md).
