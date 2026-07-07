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

# zip site: build a tiny site and deploy it
ZIPDIR=$(mktemp -d)
mkdir -p "$ZIPDIR/site/css"
echo '<!doctype html><link rel="stylesheet" href="css/s.css"><h1>zip smoke</h1>' > "$ZIPDIR/site/index.html"
echo 'h1{color:green}' > "$ZIPDIR/site/css/s.css"
(cd "$ZIPDIR/site" && zip -qr ../site.zip .)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/zip?slug=ci-zip" -H "$AUTH" -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site.zip")
expect_code 201 "$code" "zip deploy"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/css/s.css")
expect_code 200 "$code" "zip asset"

# delete both -> 404
curl -sf -X DELETE "$BASE/api/artifacts/ci-smoke-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 404 "$code" "deleted artifact"

echo "all smoke tests passed"
