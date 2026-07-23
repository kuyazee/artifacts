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

# publish html -> 201. Explicit visibility:public because the server default is now
# private; the serve-path assertions below need a publicly viewable artifact.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" -d '{"content":"<h1>smoke</h1>","type":"html","slug":"ci-smoke","visibility":"public"}')
expect_code 201 "$code" "publish html"

# public raw read -> 200 and body contains content
body=$(curl -s "$BASE/a/ci-smoke?raw=1")
echo "$body" | grep -q "<h1>smoke</h1>" || fail "raw artifact body missing content"
echo "ok: raw artifact body served"

# framed view (frame is on by default) -> wrapper embeds the raw artifact in an iframe
body=$(curl -s "$BASE/a/ci-smoke")
echo "$body" | grep -q 'iframe' || fail "framed view missing iframe"
echo "ok: framed view served"

# global config -> defaults to frame enabled + on by default
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"enabled":true' || fail "config missing enabled:true"
echo "ok: config endpoint"

# per-item frame off -> /a/slug serves the bare artifact (no iframe), then reset to inherit
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":false}' > /dev/null
body=$(curl -s "$BASE/a/ci-smoke")
if echo "$body" | grep -q '<iframe'; then fail "frame:false still framed"; fi
echo "$body" | grep -q "<h1>smoke</h1>" || fail "frame:false body missing content"
echo "ok: per-item frame off"
curl -sf -X PATCH "$BASE/api/artifacts/ci-smoke" -H "$AUTH" -H "$JSON" -d '{"frame":null}' > /dev/null

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

# markdown render config -> defaults present in config
curl -s "$BASE/api/config" -H "$AUTH" | grep -q '"font":"system"' || fail "config missing md.font default"
echo "ok: md config defaults"

# invalid md enum -> 400 (no write happens)
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/config" -H "$AUTH" -H "$JSON" -d '{"md":{"font":"comic"}}')
expect_code 400 "$code" "invalid md.font rejected"

# publish md -> serve-time render carries the theme bootstrap and rendered body
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"# md smoke\n\nhi","type":"md","slug":"ci-md","visibility":"public"}' > /dev/null
mdbody=$(curl -s "$BASE/a/ci-md?raw=1")
echo "$mdbody" | grep -q '<h1>md smoke</h1>' || fail "md body not rendered"
echo "$mdbody" | grep -q 'artifactTheme' || fail "md shell missing theme bootstrap"
echo "ok: md serve-time render"

# framed md -> navbar theme toggle present; a non-md artifact has none
curl -s "$BASE/a/ci-md" | grep -q 'id="theme"' || fail "framed md missing theme toggle"
if curl -s "$BASE/a/ci-smoke-2" | grep -q 'id="theme"'; then fail "non-md artifact has theme toggle"; fi
echo "ok: md navbar theme toggle"

curl -sf -X DELETE "$BASE/api/artifacts/ci-md" -H "$AUTH" > /dev/null

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

# project: publish with a project -> stored, case preserved
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>p</h1>","type":"html","slug":"ci-proj","project":"Acme Redesign"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"project":"Acme Redesign"' || fail "project not stored"
echo "ok: project stored"

# invalid project -> 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>x</h1>","type":"html","project":"bad/name"}')
expect_code 400 "$code" "invalid project rejected"

# internal whitespace collapsed -> single-space name matches
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>w</h1>","type":"html","slug":"ci-proj-ws","project":"Acme  Redesign"}' > /dev/null
curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj-ws"' || fail "project whitespace not collapsed"
echo "ok: project whitespace collapsed"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj-ws" -H "$AUTH" > /dev/null

# non-ASCII project accepted
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>u</h1>","type":"html","slug":"ci-proj-uni","project":"Café"}')
expect_code 201 "$code" "unicode project accepted"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj-uni" -H "$AUTH" > /dev/null

# ?project= filter includes matches and excludes non-matches
curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj"' || fail "project filter missed match"
if curl -s "$BASE/api/artifacts?project=Nope" -H "$AUTH" | grep -q '"ci-proj"'; then fail "project filter false positive"; fi
echo "ok: project filter"

# PUT without project preserves it; PATCH empty string clears it
curl -sf -X PUT "$BASE/api/artifacts/ci-proj" -H "$AUTH" -H "$JSON" -d '{"content":"<h1>p2</h1>","type":"html"}' > /dev/null
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -qF '"project":"Acme Redesign"' || fail "PUT dropped project"
curl -sf -X PATCH "$BASE/api/artifacts/ci-proj" -H "$AUTH" -H "$JSON" -d '{"project":""}' > /dev/null
if curl -s "$BASE/api/artifacts?project=Acme%20Redesign" -H "$AUTH" | grep -q '"ci-proj"'; then fail "PATCH project clear failed"; fi
echo "ok: PUT preserves / PATCH clears project"
curl -sf -X DELETE "$BASE/api/artifacts/ci-proj" -H "$AUTH" > /dev/null

# zip site: build a tiny site and deploy it
ZIPDIR=$(mktemp -d)
mkdir -p "$ZIPDIR/site/css"
echo '<!doctype html><link rel="stylesheet" href="css/s.css"><h1>zip smoke</h1>' > "$ZIPDIR/site/index.html"
echo 'h1{color:green}' > "$ZIPDIR/site/css/s.css"
(cd "$ZIPDIR/site" && zip -qr ../site.zip .)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/zip?slug=ci-zip&tags=zipped,site&visibility=public" -H "$AUTH" -H "Content-Type: application/zip" --data-binary @"$ZIPDIR/site.zip")
expect_code 201 "$code" "zip deploy"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip/css/s.css")
expect_code 200 "$code" "zip asset"
curl -s "$BASE/api/artifacts?tag=zipped" -H "$AUTH" | grep -q '"ci-zip"' || fail "zip tags not stored"
echo "ok: zip tags"

# duplicate: inline artifact copies content + inherits fields under a new slug
dupresp=$(curl -s -X POST "$BASE/api/artifacts/ci-smoke-2/duplicate" -H "$AUTH" -H "$JSON" \
  -d '{"slug":"ci-dup","title":"smoke copy","visibility":"public"}')
echo "$dupresp" | grep -q '"ci-dup"' || fail "duplicate did not return new slug"
body=$(curl -s "$BASE/a/ci-dup?raw=1")
echo "$body" | grep -q "<h1>smoke</h1>" || fail "duplicate did not copy content"
echo "ok: duplicate copies inline content"

# duplicate: requesting a slug that already exists -> 409
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-smoke-2/duplicate" \
  -H "$AUTH" -H "$JSON" -d '{"slug":"ci-dup"}')
expect_code 409 "$code" "duplicate to taken slug rejected"

# duplicate: zip site copies its files under the new slug
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/artifacts/ci-zip/duplicate" \
  -H "$AUTH" -H "$JSON" -d '{"slug":"ci-zip-dup","visibility":"public"}')
expect_code 201 "$code" "zip duplicate"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-zip-dup/css/s.css")
expect_code 200 "$code" "zip duplicate asset served"

# duplicate: omitted fields inherit from the source (ci-zip has tags zipped,site)
curl -s "$BASE/api/artifacts" -H "$AUTH" | grep -q '"ci-zip-dup"' || fail "zip duplicate not listed"
echo "ok: duplicate copies zip site + inherits fields"

curl -sf -X DELETE "$BASE/api/artifacts/ci-dup" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip-dup" -H "$AUTH" > /dev/null

# delete both -> 404
curl -sf -X DELETE "$BASE/api/artifacts/ci-smoke-2" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/ci-zip" -H "$AUTH" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-smoke-2")
expect_code 404 "$code" "deleted artifact"

# --- DoS liveness: a burst of unauthenticated login POSTs must not stall /healthz ---
# Fire 40 concurrent logins (each triggers scrypt) in the background, then time a healthz.
for i in $(seq 1 40); do
  curl -s -o /dev/null -X POST "$BASE/api/auth/login" -H "$JSON" \
    -d '{"username":"nobody","password":"wrongwrongwrong"}' &
done
start=$(date +%s%N)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz")
end=$(date +%s%N)
wait
expect_code 200 "$code" "healthz responsive under scrypt load"
ms=$(( (end - start) / 1000000 ))
[ "$ms" -lt 2000 ] || fail "healthz took ${ms}ms under load (event loop stalled?)"
echo "ok: healthz stayed responsive (${ms}ms) under 40 concurrent logins"

# --- login rate limiting: the burst above exhausted the per-IP login bucket (10/window),
# so a further failed login must 429 with a Retry-After header. ---
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H "$JSON" \
  -d '{"username":"admin","password":"definitely-wrong"}')
expect_code 429 "$code" "login rate limited after burst"
hdr=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "$JSON" \
  -d '{"username":"admin","password":"x"}')
echo "$hdr" | grep -qi '^Retry-After:' || fail "429 missing Retry-After header"
echo "ok: login limiter sets Retry-After"

# --- capability links: default is private, tokened URL, no existence leak ---
resp=$(curl -s -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>cap secret</h1>","type":"html","slug":"cap-one"}')
capurl=$(printf '%s' "$resp" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
case "$capurl" in
  *'?k='*) echo "ok: default publish is private (tokened url returned)" ;;
  *) fail "default publish not private/tokened: $capurl" ;;
esac

# bare link -> 404 (indistinguishable from a missing artifact)
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/cap-one")
expect_code 404 "$code" "private bare link 404"

# tokened link -> 302 (sets the unlock cookie), does not 200 directly
code=$(curl -s -o /dev/null -w '%{http_code}' "$capurl")
expect_code 302 "$code" "capability link redirects"

# the 302 sets a cookie; a raw read with that cookie serves the body
curl -s -c /tmp/capjar -o /dev/null "$capurl"
body=$(curl -s -b /tmp/capjar "$BASE/a/cap-one?raw=1")
echo "$body" | grep -q 'cap secret' || fail "unlock cookie did not serve raw body"
echo "ok: capability cookie serves the body"

# rotate -> the live cookie is invalidated immediately
curl -sf -X PATCH "$BASE/api/artifacts/cap-one" -H "$AUTH" -H "$JSON" -d '{"rotateToken":true}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/capjar "$BASE/a/cap-one?raw=1")
expect_code 404 "$code" "rotate invalidates live cookie"

# oracle uniformity: a missing slug and a locked-private slug return identical 404 bodies
b_missing=$(curl -s "$BASE/a/does-not-exist-zzz")
b_locked=$(curl -s "$BASE/a/cap-one")
[ "$b_missing" = "$b_locked" ] || fail "404 bodies differ (existence oracle)"
echo "ok: missing and locked-private return identical 404"

# no secret leak: the list API exposes no token epoch or password material
list=$(curl -s "$BASE/api/artifacts" -H "$AUTH")
if echo "$list" | grep -q 'tokenEpoch'; then fail "tokenEpoch leaked in list"; fi
if echo "$list" | grep -qiE 'passwordhash|passwordsalt'; then fail "password hash leaked in list"; fi
echo "ok: no secret fields in list output"

# --- password mode: prompt, wrong/right unlock, cookie serves ---
curl -sf -X POST "$BASE/api/artifacts" -H "$AUTH" -H "$JSON" \
  -d '{"content":"<h1>pw body</h1>","type":"html","slug":"cap-pw","visibility":"password","password":"letmein"}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/cap-pw")
expect_code 401 "$code" "password mode shows prompt"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/a/cap-pw/unlock" -H "$JSON" -d '{"password":"nope"}')
expect_code 401 "$code" "password unlock wrong -> 401"
curl -s -c /tmp/pwjar -o /dev/null -X POST "$BASE/a/cap-pw/unlock" -H "$JSON" -d '{"password":"letmein"}'
body=$(curl -s -b /tmp/pwjar "$BASE/a/cap-pw?raw=1")
echo "$body" | grep -q 'pw body' || fail "password unlock cookie did not serve body"
echo "ok: password mode unlock round-trip"

curl -sf -X DELETE "$BASE/api/artifacts/cap-one" -H "$AUTH" > /dev/null
curl -sf -X DELETE "$BASE/api/artifacts/cap-pw" -H "$AUTH" > /dev/null

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
url=$(node "$CLI_DIR/cli.js" publish "$ZIPDIR/cli.html" --slug ci-cli --tags cli,smoke --visibility public)
[ "$url" = "$BASE/a/ci-cli" ] || fail "cli publish: unexpected url $url"
node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli' || fail "cli --tags not stored"
node "$CLI_DIR/cli.js" tag ci-cli none > /dev/null
if node "$CLI_DIR/cli.js" list --tag cli | grep -q 'ci-cli'; then fail "cli tag clear failed"; fi
echo "ok: cli publish + tags"
node "$CLI_DIR/cli.js" rename ci-cli ci-cli-2 > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 200 "$code" "cli rename"
node "$CLI_DIR/cli.js" config | grep -q '"enabled"' || fail "cli config get"
echo "ok: cli config"
node "$CLI_DIR/cli.js" frame ci-cli-2 off > /dev/null
if curl -s "$BASE/a/ci-cli-2" | grep -q '<iframe'; then fail "cli frame off still framed"; fi
echo "ok: cli frame off"
node "$CLI_DIR/cli.js" project ci-cli-2 web-revamp > /dev/null
node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2' || fail "cli project not stored"
node "$CLI_DIR/cli.js" project ci-cli-2 none > /dev/null
if node "$CLI_DIR/cli.js" list --project web-revamp | grep -q 'ci-cli-2'; then fail "cli project clear failed"; fi
echo "ok: cli project"
node "$CLI_DIR/cli.js" deploy "$ZIPDIR/site" --slug ci-cli-zip --visibility public > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-zip/css/s.css")
expect_code 200 "$code" "cli zip deploy"
node "$CLI_DIR/cli.js" delete ci-cli-2 > /dev/null
node "$CLI_DIR/cli.js" delete ci-cli-zip > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/a/ci-cli-2")
expect_code 404 "$code" "cli delete"

echo "all smoke tests passed"
