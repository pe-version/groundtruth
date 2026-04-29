#!/usr/bin/env bash
#
# End-to-end smoke test for groundtruth.
#
# Exercises the paths most likely to break in real use:
#   1. Service health
#   2. Register → JWT
#   3. Upload PDF → async processing → status=ready
#   4. Query (RAG round-trip with Claude)
#   5. DLQ path: broken PDF → status=failed
#   6. Per-user isolation: user B can't read user A's document
#
# Prerequisites:
#   - Stack already running (see README "Quick Start")
#   - curl + python3 installed (python3 ships with macOS / most Linuxes)
#   - A valid PDF to test against (passed as $1)
#
# Usage:
#   scripts/smoke-test.sh path/to/document.pdf
#   API=http://localhost:8080/api scripts/smoke-test.sh ~/Downloads/some.pdf
#
# Exit code is 0 on success, non-zero on the first failed step.

set -euo pipefail

API="${API:-http://localhost:8080/api}"
PDF="${1:-./test-fixtures/sample.pdf}"
PASSWORD="smoke-test-password-12345"

# Random per-run usernames so reruns don't collide with prior records.
RUN_ID="$(date +%s)-$$"
USER_A="alice-${RUN_ID}"
USER_B="bob-${RUN_ID}"

red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }

trap 'red "FAILED at line $LINENO"' ERR

require() { command -v "$1" >/dev/null || { red "missing dependency: $1"; exit 1; }; }
require curl
require python3

# Tiny JSON helper. Reads JSON from stdin, prints the value at the given
# dotted path (e.g. ".token" or ".sources | length"). Avoids depending on
# jq, which on Apple Silicon machines with Intel-only Homebrew can hang
# in Rosetta translation. python3 ships with the OS and is always native.
jpath() {
  python3 -c "
import json, sys
data = json.load(sys.stdin)
path = sys.argv[1].lstrip('.')
if path.endswith(' | length'):
    key = path[:-len(' | length')]
    print(len(data.get(key, [])) if key else len(data))
else:
    cur = data
    for part in path.split('.') if path else []:
        cur = cur[part] if isinstance(cur, dict) and part in cur else None
        if cur is None: break
    print('' if cur is None else cur)
" "$1"
}

# ── 0. Preconditions ────────────────────────────────────────────────
step "Preconditions"
[[ -f "$PDF" ]] || { red "Test PDF not found: $PDF — pass a path as \$1"; exit 1; }
# /health is registered without the /api prefix (it's deliberately
# outside the auth-protected scope), so probe it directly rather than
# through $API.
HEALTH="${API%/api}/health"
curl -fsS --max-time 5 "$HEALTH" >/dev/null \
  || { red "API not reachable at $HEALTH — is the stack running?"; exit 1; }
green "  API reachable, PDF present ($PDF)"

# ── 1. Register user A ──────────────────────────────────────────────
step "Register user A ($USER_A)"
TOKEN_A="$(curl -fsS --max-time 30 -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER_A\",\"password\":\"$PASSWORD\"}" \
  | jpath .token)"
[[ -n "$TOKEN_A" && "$TOKEN_A" != "None" ]] \
  || { red "  no token returned"; exit 1; }
green "  got JWT (len=${#TOKEN_A})"

# ── 2. Upload PDF ───────────────────────────────────────────────────
step "Upload PDF as user A"
DOC_A="$(curl -fsS --max-time 60 -X POST "$API/documents/upload" \
  -H "Authorization: Bearer $TOKEN_A" \
  -F "file=@${PDF}" \
  | jpath .id)"
[[ -n "$DOC_A" && "$DOC_A" != "None" ]] \
  || { red "  no document id returned"; exit 1; }
green "  documentId=$DOC_A"

# ── 3. Wait for processing ──────────────────────────────────────────
# Up to ~3 minutes — first run downloads the embedding model (~33 MB)
# before processing, so the first poll cycle is the slow one.
step "Wait for status=ready (≤ 3 min)"
for i in $(seq 1 90); do
  STATUS="$(curl -fsS --max-time 10 "$API/documents/$DOC_A" \
    -H "Authorization: Bearer $TOKEN_A" | jpath .status)"
  printf "  poll %02d: %s\n" "$i" "$STATUS"
  case "$STATUS" in
    ready)  break ;;
    failed) red "  unexpected failure on the test PDF"; exit 1 ;;
  esac
  sleep 2
done
[[ "$STATUS" == "ready" ]] || { red "  timed out waiting for ready"; exit 1; }
green "  document ready"

# ── 4. Query (RAG round-trip) ───────────────────────────────────────
step "Query (RAG)"
RESPONSE_FILE="$(mktemp)"
curl -fsS --max-time 60 -X POST "$API/query" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"Summarize this document in one sentence.\",\"documentId\":\"$DOC_A\"}" \
  -o "$RESPONSE_FILE"
ANSWER="$(jpath .answer < "$RESPONSE_FILE")"
SOURCES="$(jpath '.sources | length' < "$RESPONSE_FILE")"
rm -f "$RESPONSE_FILE"
[[ -n "$ANSWER" && "$ANSWER" != "None" ]] || { red "  empty answer"; exit 1; }
echo "  answer: $(echo "$ANSWER" | head -c 200)..."
echo "  sources: $SOURCES chunk(s) cited"
green "  query returned non-empty answer"

# ── 5. DLQ path ─────────────────────────────────────────────────────
# A non-PDF disguised as one is either rejected by the API's validation
# (magic-bytes / MIME check, HTTP 400) or accepted and DLQ'd by the
# consumer when unpdf can't parse the body. Both are valid security
# outcomes; the test passes if either happens.
step "Upload broken PDF → expect rejection or status=failed"
BROKEN="$(mktemp -t groundtruth-broken.XXXXXX.pdf)"
printf '%%PDF-1.4\nthis is corrupt and has no body or xref\n%%%%EOF\n' > "$BROKEN"
UPLOAD_FILE="$(mktemp)"
# `-w '%{http_code}'` captures the status; -o writes the body. -f is
# omitted on purpose so 400 doesn't abort the pipeline.
HTTP_BROKEN="$(curl -sS --max-time 30 -X POST "$API/documents/upload" \
  -H "Authorization: Bearer $TOKEN_A" \
  -F "file=@${BROKEN};type=application/pdf" \
  -o "$UPLOAD_FILE" -w '%{http_code}')"
rm -f "$BROKEN"

if [[ "$HTTP_BROKEN" == "400" ]]; then
  rm -f "$UPLOAD_FILE"
  # Validation-time rejection — same security property, one layer earlier.
  green "  broken PDF rejected at upload (HTTP 400 — validation-time guardrail)"
elif [[ "$HTTP_BROKEN" == "202" ]]; then
  DOC_BROKEN="$(jpath .id < "$UPLOAD_FILE")"
  rm -f "$UPLOAD_FILE"
  [[ -n "$DOC_BROKEN" && "$DOC_BROKEN" != "None" ]] \
    || { red "  202 returned but no document id"; exit 1; }
  for i in $(seq 1 30); do
    STATUS="$(curl -fsS --max-time 10 "$API/documents/$DOC_BROKEN" \
      -H "Authorization: Bearer $TOKEN_A" | jpath .status)"
    printf "  poll %02d: %s\n" "$i" "$STATUS"
    [[ "$STATUS" == "failed" ]] && break
    sleep 2
  done
  [[ "$STATUS" == "failed" ]] \
    || { red "  expected failed status, got $STATUS"; exit 1; }
  green "  broken PDF correctly marked failed"
else
  rm -f "$UPLOAD_FILE"
  red "  unexpected HTTP $HTTP_BROKEN on broken-PDF upload"
  exit 1
fi

# ── 6. Per-user isolation ───────────────────────────────────────────
step "Register user B and verify A's doc is invisible"
TOKEN_B="$(curl -fsS --max-time 30 -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER_B\",\"password\":\"$PASSWORD\"}" \
  | jpath .token)"
HTTP="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN_B" \
  "$API/documents/$DOC_A")"
case "$HTTP" in
  403|404) green "  user isolation enforced (HTTP $HTTP)" ;;
  *)       red "  expected 403/404 on cross-user GET, got $HTTP"; exit 1 ;;
esac

# ── Done ────────────────────────────────────────────────────────────
echo
green "✔ all smoke checks passed"
echo "  alice=$USER_A  bob=$USER_B  documentId=$DOC_A"
