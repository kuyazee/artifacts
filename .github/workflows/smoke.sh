#!/usr/bin/env bash
# End-to-end smoke test against a running artifacts-host instance.
# Usage: smoke.sh <base-url> <api-key>
set -euo pipefail

BASE=$1
KEY=$2
AUTH="Authorization: Bearer $KEY"
JSON="Content-Type: application/json"
fail() { echo "FAIL: $1" >&2; exit 1; }

expect_code() { # expect_code <expected> <actual> <label>
  [ "$2" = "$1" ] || fail "$3: expected $1, got $2"
  echo "ok: $3 -> $1"
}

# unauthenticated write -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$JSON" -d '{"content":"<h1>x</h1>","type":"html"}')
expect_code 401 "$code" "unauth publish"

# publish html -> 201
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d '{"content":"<h1>smoke</h1>","type":"html","slug":"ci-smoke"}')
expect_code 201 "$code" "publish html"

# public read -> 200 and body contains content
body=$(curl -s "$BASE/a/ci-smoke")
echo "$body" | grep -q "smoke" || fail "artifact body missing content"
echo "ok: artifact body served"

# source endpoint -> 200
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke/source")
expect_code 200 "$code" "source endpoint"

# disable -> public read 404
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"disabled":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 404 "$code" "disabled artifact"

# re-enable + expire in the past -> 410
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"disabled":false,"expiresAt":"2020-01-01"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 410 "$code" "expired artifact"

# clear expiry + rename -> new slug serves, old 404
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"expiresAt":null,"slug":"ci-smoke-2"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 200 "$code" "renamed artifact"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke")
expect_code 404 "$code" "old slug gone"

# tags: publish with tags -> stored lowercased + deduped
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>tags</h1>","type":"html","slug":"ci-tags","tags":["Demo","ci","demo"]}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"tags":["demo","ci"]' || fail "tags not normalized/stored"
echo "ok: tags stored + normalized"

# invalid tag -> 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>x</h1>","type":"html","tags":["bad tag!"]}')
expect_code 400 "$code" "invalid tag rejected"

# ?tag= filter includes matches and excludes non-matches
curl -s "$BASE/api/artifacts?tag=ci" -H "$AUTH" | grep -q '"ci-tags"' || fail "tag filter missed match"
if curl -s "$BASE/api/artifacts?tag=nope" -H "$AUTH" | grep -q '"ci-tags"'; then fail "tag filter false positive"; fi
echo "ok: tag filter"

# PUT without tags preserves them
curl -sf -X PUT "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>tags v2</h1>","type":"html"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"tags":["demo","ci"]' || fail "PUT dropped tags"
echo "ok: PUT preserves tags"

# PATCH replaces the whole tag list; empty array clears
curl -sf -X PATCH "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" -d '{"tags":["swapped"]}' > /dev/null
curl -s "$BASE/api/artifacts?tag=swapped" -H "$AUTH" | grep -q '"ci-tags"' || fail "PATCH tags replace failed"
curl -sf -X PATCH "$BASE/api/artifacts/ci-tags" -H "$AUTH" -H "$JSON" -d '{"tags":[]}' > /dev/null
if curl -s "$BASE/api/artifacts?tag=swapped" -H "$AUTH" | grep -q '"ci-tags"'; then fail "PATCH tags clear failed"; fi
echo "ok: PATCH tags replace/clear"
curl -sf -X DELETE "$BASE/api/artifacts/ci-tags" -H "$AUTH" > /dev/null

# zip site: build a tiny site and deploy it
ZIPDIR=$(mktemp -d)
mkdir -p "$ZIPDIR/site/css"
echo '<!doctype html><link rel="stylesheet" href="css/s.css"><h1>zip smoke</h1>' > "$ZIPDIR/site/index.html"
echo 'h1{color:green}' > "$ZIPDIR/site/css/s.css"
(cd "$ZIPDIR/site" && zip -qr ../site.zip .)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/zip?slug=ci-zip&tags=zipped,site" -H "$AUTH" -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site.zip")
expect_code 201 "$code" "zip deploy"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/css/s.css")
expect_code 200 "$code" "zip asset"
curl -s "$BASE/api/artifacts?tag=zipped" -H "$AUTH" | grep -q '"ci-zip"' || fail "zip tags not stored"
echo "ok: zip tags"

# delete both -> 404
curl -sf -X DELETE "$BASE/api/artifacts/ci-smoke-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 404 "$code" "deleted artifact"

# CLI round-trip (cli.js lives next to this checkout; skipped when deps absent,
# e.g. the container-smoke job which doesn't run npm ci)
CLI_DIR=$(cd "$(dirname "$0")/../.." && pwd)
if [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "skip: cli smoke (no node_modules)"
  echo "all smoke tests passed"
  exit 0
fi
export ARTIFACTS_URL=$BASE ARTIFACTS_API_KEY=$KEY
echo '<h1>cli smoke</h1>' > "$ZIPDIR/cli.html"
url=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.html" --slug ci-cli --tags cli,smoke)
[ "$url" = "$BASE/a/ci-cli" ] || fail "cli publish: unexpected url $url"
node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli' || fail "cli --tags not stored"
node "$CLI_DIR/cli.js" tag ci-cli none > /dev/null
if node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli'; then fail "cli tag clear failed"; fi
echo "ok: cli publish + tags"
node "$CLI_DIR/cli.js" rename ci-cli ci-cli-2 > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 200 "$code" "cli rename"
node "$CLI_DIR/cli.js" deploy "$ZIPDIR/site" --slug ci-cli-zip > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-zip/css/s.css")
expect_code 200 "$code" "cli zip deploy"
node "$CLI_DIR/cli.js" delete ci-cli-2 > /dev/null
node "$CLI_DIR/cli.js" delete ci-cli-zip > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 404 "$code" "cli delete"

echo "all smoke tests passed"
