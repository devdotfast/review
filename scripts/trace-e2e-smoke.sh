#!/usr/bin/env bash
#
# End-to-end smoke for the hosted trace store.
#
# The smoke onboards one repository, ships one real agent session, checks the
# object in S3 and in the replica, pulls the session back, checks the two
# unauthorized cases, deletes the store, and logs out. It repeats rows 3 to 13
# of the E1 pass table. Row 1 (login) and row 2 (whoami) need a browser, so run
# `review login` once before this script.
#
# Usage:
#   scripts/trace-e2e-smoke.sh [options]
#
# Options:
#   --origin <url>      store origin (default https://app.dev.fast)
#   --repo <path>       Git working tree to onboard (default: current directory)
#   --session <id>      agent session id to ship (default: newest small session)
#   --cli <path>        built CLI (default: packages/progressive-review/dist/cli.js)
#   --bucket <name>     primary bucket (default devfast-review-traces)
#   --replica <name>    replica bucket (default devfast-review-traces-replica)
#   --keep-store        skip the DELETE of the store (row 12)
#   --keep-login        skip `review logout` (row 13)
#
# Environment:
#   DEV_REVIEW_HOME               isolated Review home that holds auth.json
#   REVIEW_TEST_TRACE_SEARCH_DIR  corpus root for `trace pull`; without it the
#                                 CLI reads $DEV_REVIEW_HOME/trace-search
#                                 (default $HOME/.dev/trace-search)
#   AWS_PROFILE                   profile for the two head-object checks

set -euo pipefail

ORIGIN="https://app.dev.fast"
REPO_PATH="$PWD"
SESSION=""
CLI=""
BUCKET="devfast-review-traces"
REPLICA="devfast-review-traces-replica"
REPLICA_REGION="us-east-2"
KEEP_STORE=0
KEEP_LOGIN=0
REPLICA_WAIT=300

while [ $# -gt 0 ]; do
  case "$1" in
    --origin) ORIGIN="$2"; shift 2 ;;
    --repo) REPO_PATH="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --cli) CLI="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --replica) REPLICA="$2"; shift 2 ;;
    --keep-store) KEEP_STORE=1; shift ;;
    --keep-login) KEEP_LOGIN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$CLI" ]; then
  CLI="$SCRIPT_DIR/../packages/progressive-review/dist/cli.js"
fi
if [ ! -f "$CLI" ]; then
  echo "Build the CLI first: pnpm --filter @dev.fast/review build" >&2
  exit 2
fi

HOME_DIR="${DEV_REVIEW_HOME:-$HOME/.dev}"
AUTH_FILE="$HOME_DIR/auth.json"
CORPUS_DIR="${REVIEW_TEST_TRACE_SEARCH_DIR:-${DEV_REVIEW_HOME:-$HOME/.dev}/trace-search}"
WORK_DIR="$(mktemp -d)"
# curl reads the bearer token from this file, so no token reaches `ps`.
AUTH_HEADER="$HOME_DIR/trace-smoke-auth.header"
FAILURES=0

rv() { node "$CLI" "$@"; }
cleanup() { rm -rf "$WORK_DIR"; rm -f "$AUTH_HEADER"; }
trap cleanup EXIT

pass() { printf 'PASS row %-2s %s\n' "$1" "$2"; }
fail() { printf 'FAIL row %-2s %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }
check() { if [ "$1" = "0" ]; then pass "$2" "$3"; else fail "$2" "$3"; fi; }

if [ ! -f "$AUTH_FILE" ]; then
  echo "No $AUTH_FILE. Run \`review login\` first." >&2
  exit 2
fi

# ---------------------------------------------------------------- row 3
cd "$REPO_PATH"
if rv trace onboard --json >"$WORK_DIR/onboard.jsonl" 2>"$WORK_DIR/onboard.err"; then
  ID="$(jq -r 'select(.event=="trace.onboard").repositoryId' "$WORK_DIR/onboard.jsonl")"
  NAME="$(jq -r 'select(.event=="trace.onboard").displayName' "$WORK_DIR/onboard.jsonl")"
  if [ -n "$ID" ] && [ "$ID" -gt 0 ] 2>/dev/null; then
    pass 3 "onboard $NAME repositoryId=$ID"
  else
    fail 3 "onboard returned no positive repositoryId"
  fi
else
  fail 3 "onboard exited non-zero: $(cat "$WORK_DIR/onboard.err")"
  echo "Cannot continue without a store." >&2
  exit 1
fi

# ---------------------------------------------------------------- row 4
if rv trace onboard --json >"$WORK_DIR/onboard2.jsonl" 2>"$WORK_DIR/onboard2.err"; then
  CREATED="$(jq -r 'select(.event=="trace.onboard").created' "$WORK_DIR/onboard2.jsonl")"
  if [ "$CREATED" = "false" ]; then
    pass 4 "second onboard is idempotent (created=false)"
  else
    fail 4 "second onboard reported created=$CREATED"
  fi
else
  fail 4 "second onboard exited non-zero"
fi

# ---------------------------------------------------------------- row 5
if rv trace allow . --no-harness-hooks --json >"$WORK_DIR/allow.jsonl" 2>"$WORK_DIR/allow.err"; then
  CONFIG="$HOME_DIR/trace/config.json"
  ALLOWED_ID="$(jq -r --arg n "$NAME" '.repositories[]? | select(.name==$n) | .repositoryId' "$CONFIG" 2>/dev/null || true)"
  HOOKS="$(git rev-parse --git-common-dir)/dev-fast/trace-hooks"
  if [ "$ALLOWED_ID" = "$ID" ] && [ -d "$HOOKS" ]; then
    pass 5 "allow wrote $NAME id=$ALLOWED_ID and $HOOKS"
  else
    fail 5 "allow config id='$ALLOWED_ID' expected '$ID'; hooks dir present: $([ -d "$HOOKS" ] && echo yes || echo no)"
  fi
else
  fail 5 "allow exited non-zero: $(cat "$WORK_DIR/allow.jsonl")"
fi

# ---------------------------------------------------------------- row 6
if [ -z "$SESSION" ]; then
  SESSION_FILE="$(find "$HOME/.claude/projects" -name '*.jsonl' -size -100k -print 2>/dev/null | head -1)"
  if [ -z "$SESSION_FILE" ]; then
    echo "No agent session under ~/.claude/projects. Pass --session." >&2
    exit 2
  fi
  SESSION="$(basename "$SESSION_FILE" .jsonl)"
fi
echo "Session: $SESSION"

if rv trace sync "$SESSION" --json >"$WORK_DIR/sync.jsonl" 2>"$WORK_DIR/sync.err"; then
  STORED="$(jq -r 'select(.event=="trace.sync").stored' "$WORK_DIR/sync.jsonl")"
  OBJECTS="$(jq -r 'select(.event=="trace.sync").objects[]?' "$WORK_DIR/sync.jsonl" | tr '\n' ' ')"
  if [ "$STORED" = "written" ] && printf '%s' "$OBJECTS" | grep -q 'main.jsonl.gz'; then
    pass 6 "sync stored=$STORED objects=$OBJECTS"
  else
    fail 6 "sync stored='$STORED' objects='$OBJECTS'"
  fi
else
  fail 6 "sync exited non-zero: $(cat "$WORK_DIR/sync.err")"
fi

KEY="r$ID/sessions/$SESSION/main.jsonl.gz"

# ---------------------------------------------------------------- row 7
if aws s3api head-object --bucket "$BUCKET" --key "$KEY" >"$WORK_DIR/head.json" 2>"$WORK_DIR/head.err"; then
  SSE="$(jq -r '.ServerSideEncryption' "$WORK_DIR/head.json")"
  LEN="$(jq -r '.ContentLength' "$WORK_DIR/head.json")"
  if [ "$SSE" = "aws:kms" ] && [ "$LEN" -gt 0 ] 2>/dev/null; then
    pass 7 "s3://$BUCKET/$KEY sse=$SSE length=$LEN"
  else
    fail 7 "head-object sse='$SSE' length='$LEN'"
  fi
else
  fail 7 "head-object failed: $(cat "$WORK_DIR/head.err")"
  LEN=""
fi

# ---------------------------------------------------------------- row 8
WAITED=0
REPLICA_LEN=""
while [ "$WAITED" -lt "$REPLICA_WAIT" ]; do
  if REPLICA_LEN="$(aws s3api head-object --region "$REPLICA_REGION" --bucket "$REPLICA" --key "$KEY" --query ContentLength --output text 2>/dev/null)"; then
    break
  fi
  REPLICA_LEN=""
  sleep 15
  WAITED=$((WAITED + 15))
done
if [ -n "$REPLICA_LEN" ] && [ "$REPLICA_LEN" = "$LEN" ]; then
  pass 8 "replica length=$REPLICA_LEN after ${WAITED}s"
else
  fail 8 "replica length='$REPLICA_LEN' expected '$LEN' after ${WAITED}s"
fi

# ---------------------------------------------------------------- row 9
OWNER="${NAME%%/*}"
REPO_NAME="${NAME##*/}"
CORPUS_FILE="$CORPUS_DIR/$OWNER/$REPO_NAME/$SESSION/main.jsonl"
rm -rf "${CORPUS_DIR:?}/${OWNER:?}/${REPO_NAME:?}/${SESSION:?}"
if rv trace pull --session "$SESSION" --json >"$WORK_DIR/pull.jsonl" 2>"$WORK_DIR/pull.err"; then
  if [ -s "$CORPUS_FILE" ]; then
    LINES="$(wc -l <"$CORPUS_FILE" | tr -d ' ')"
    EVENTS="$(rv trace show "$SESSION" --json 2>/dev/null | jq -r '[.events[]?] | length' | head -1)"
    if [ -n "$EVENTS" ] && [ "$LINES" = "$((EVENTS + 1))" ]; then
      pass 9 "pull wrote $CORPUS_FILE with $LINES lines (1 + $EVENTS events)"
    else
      fail 9 "pull wrote $LINES lines; show reported '$EVENTS' events"
    fi
  else
    fail 9 "pull left no $CORPUS_FILE"
  fi
else
  fail 9 "pull exited non-zero: $(cat "$WORK_DIR/pull.err")"
fi

# ---------------------------------------------------------------- row 10
if rv trace show "$SESSION" >"$WORK_DIR/show.txt" 2>&1; then
  if grep -qi 'user' "$WORK_DIR/show.txt" && grep -qi 'assistant' "$WORK_DIR/show.txt"; then
    pass 10 "show printed user and assistant events"
  else
    fail 10 "show printed no user/assistant pair"
  fi
else
  fail 10 "show exited non-zero"
fi

# ---------------------------------------------------------------- row 11
(umask 177; jq -r '"authorization: Bearer " + .token' "$AUTH_FILE" >"$AUTH_HEADER")
chmod 600 "$AUTH_HEADER"
upload_url() { printf '%s/api/trace/v1/stores/%s/sessions/session-00000001/uploads' "$ORIGIN" "$1"; }
NO_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$(upload_url "$ID")")"
PROBE_BODY='{"harness":"claude","objects":[{"name":"main.jsonl.gz","size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}'
BAD_STORE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "@$AUTH_HEADER" -H "Origin: $ORIGIN" -H 'content-type: application/json' -d "$PROBE_BODY" "$(upload_url 999999999)")"
BAD_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer not-a-real-token" -H "Origin: $ORIGIN" "$(upload_url "$ID")")"
if { [ "$NO_TOKEN" = "401" ] || [ "$NO_TOKEN" = "403" ]; } && [ "$BAD_STORE" = "403" ] && [ "$BAD_TOKEN" = "401" ]; then
  pass 11 "no token=$NO_TOKEN, foreign store=$BAD_STORE, bad token=$BAD_TOKEN"
else
  fail 11 "no token=$NO_TOKEN (want 401/403), foreign store=$BAD_STORE (want 403), bad token=$BAD_TOKEN (want 401)"
fi

# ---------------------------------------------------------------- row 12
if [ "$KEEP_STORE" = "1" ]; then
  echo "SKIP row 12 (--keep-store)"
else
  DELETED="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "@$AUTH_HEADER" -H "Origin: $ORIGIN" "$ORIGIN/api/trace/v1/stores/$ID")"
  if [ "$DELETED" = "204" ]; then
    COUNT="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "r$ID/" --query 'KeyCount' --output text)"
    check "$([ "$COUNT" = "0" ] || [ "$COUNT" = "None" ] && echo 0 || echo 1)" 12 "DELETE=204, keys left=${COUNT:-0}"
  elif [ "$DELETED" = "403" ]; then
    fail 12 "DELETE=403 (not admin); the store stays"
  else
    fail 12 "DELETE=$DELETED"
  fi
fi
rm -f "$AUTH_HEADER"

# ---------------------------------------------------------------- row 13
if [ "$KEEP_LOGIN" = "1" ]; then
  echo "SKIP row 13 (--keep-login)"
else
  rv logout >/dev/null 2>&1 || true
  if [ ! -f "$AUTH_FILE" ] && ! rv whoami >/dev/null 2>&1; then
    pass 13 "logout removed $AUTH_FILE and whoami exits non-zero"
  else
    fail 13 "auth.json present: $([ -f "$AUTH_FILE" ] && echo yes || echo no)"
  fi
fi

echo
if [ "$FAILURES" = "0" ]; then
  echo "Smoke passed."
else
  echo "Smoke failed: $FAILURES row(s)."
fi
exit "$FAILURES"
