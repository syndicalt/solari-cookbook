#!/usr/bin/env bash
# offline-close.sh — `make demo-offline`: close the books with curl only.
# No Solari key, no paid sessions. Proves the twin world end to end:
# portal login -> invoice zip (sha256-pinned) -> reconcile in python ->
# exceptions.csv -> close-pack.pdf -> portal upload -> /close/last confirms.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${NOAPI_PORTAL_PORT:-8787}"
ORIGIN="http://127.0.0.1:${PORT}"
USER="${NOAPI_PORTAL_USER:-reviewer@getsolari.com}"
PASSWORD="${NOAPI_PORTAL_PASSWORD:-reviewer}"
OUT="artifacts/offline"
WORK="$OUT/work"
JAR="$OUT/cookies.jar"

fail() { echo "offline.fail $*" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$WORK/invoices"

# 1. start the portal, kill it on exit no matter what
PORT="$PORT" node apps/portal/server.ts &
PORTAL_PID=$!
trap 'kill "$PORTAL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -sf -o /dev/null "$ORIGIN/login" && break
  sleep 0.1
done
curl -sf -o /dev/null "$ORIGIN/login" || fail "portal did not answer on $ORIGIN"

# 2. login flow: GET form, then POST the seeded creds (expect 302)
curl -sf -c "$JAR" -o /dev/null "$ORIGIN/login" || fail "GET /login"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -b "$JAR" \
  --data-urlencode "email=$USER" --data-urlencode "password=$PASSWORD" \
  "$ORIGIN/login")
[ "$code" = "302" ] || fail "POST /login returned $code, want 302"
grep -q "sid" "$JAR" || fail "no sid cookie after login"

# 3. download the invoice zip, verify against the pinned golden
curl -sf -b "$JAR" -o "$OUT/invoices.zip" "$ORIGIN/invoices/2026-06.zip" \
  || fail "zip download"
got=$(sha256sum "$OUT/invoices.zip" | cut -d' ' -f1)
want=$(tr -d '[:space:]' < fixtures/invoices.sha256)
[ "$got" = "$want" ] || fail "zip sha256 mismatch: got $got want $want"

# 4. stage /work and reconcile (same script the Solari sandbox will run)
python3 -m zipfile -e "$OUT/invoices.zip" "$WORK/invoices"
cp fixtures/ledger.csv fixtures/policy.yaml fixtures/reconcile.py "$WORK/"
python3 "$WORK/reconcile.py" "$WORK" || fail "reconcile.py"

# 5. exceptions.csv must exist with exactly 2 data rows
[ -f "$WORK/exceptions.csv" ] || fail "exceptions.csv missing"
rows=$(( $(wc -l < "$WORK/exceptions.csv") - 1 ))
[ "$rows" -eq 2 ] || fail "exceptions.csv has $rows data rows, want 2"

# 6. build the close-pack PDF (offline stand-in for the LibreOffice step)
node scripts/make-pack.ts "$WORK/exceptions.csv" "$OUT/close-pack.pdf" \
  || fail "make-pack"
[ -f "$OUT/close-pack.pdf" ] || fail "close-pack.pdf missing"

# 7. upload the pack, then confirm the portal recorded it
upload_body=$(curl -sf -b "$JAR" -F "file=@$OUT/close-pack.pdf" \
  "$ORIGIN/close/submit") || fail "upload POST"
echo "$upload_body" | grep -q 'data-testid="upload-status"' \
  || fail "no upload-status in response"
echo "$upload_body" | grep -q "accepted" || fail "upload not accepted"

last=$(curl -sf -b "$JAR" "$ORIGIN/close/last") || fail "GET /close/last"
echo "$last" | grep -q '"ok":true' || fail "/close/last not ok: $last"
local_sha=$(sha256sum "$OUT/close-pack.pdf" | cut -d' ' -f1)
echo "$last" | grep -q "\"sha256\":\"$local_sha\"" \
  || fail "/close/last sha256 mismatch: $last vs $local_sha"

echo "offline.ok exceptions=$rows upload=accepted sha256=${local_sha:0:12}"
