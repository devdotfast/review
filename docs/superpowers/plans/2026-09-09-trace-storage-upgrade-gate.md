# Trace storage rewrite: upgrade gate evidence

Date: 2026-09-09. Branch `feat/trace-storage-rewrite`, head `8179393a` plus the
doctor fix committed with this document. Governing design:
`/Users/aiansiti/workable/trace-storage-design.md`.

## Mandatory criterion: an existing direct setup works unchanged

Result: **passed**. A S3/R2 installation made with the pre-upgrade
CLI kept capturing, uploading, indexing, discovering, and reading traces
after only the CLI was replaced. No configuration file changed, no login,
consent, credential change, or object migration happened, and the guarded
process made no non-loopback network request.

| Item | Value |
| --- | --- |
| Pre-upgrade CLI | `origin/main` at `317bc7f0`, built with `pnpm --filter @dev.fast/review build` |
| Upgraded CLI | this branch, same build command |
| Bucket | MinIO (`minio/minio`, Docker 29.7.2) on `127.0.0.1:9000`, bucket `review-traces-gate`, region `us-east-1` |
| Transport | `aws-cli/2.34.60` as shipped; Node `v24.15.0` |
| Home | disposable `HOME` and `DEV_REVIEW_HOME`; `AWS_PROFILE` and agent-session variables unset |
| Hosted network | every non-loopback `fetch`, `http(s).request`, and socket connect throws and is logged (`no-network.cjs`) |
| Commands run | 32, all exit 0 (`evidence.log`) |

### Procedure and observations

1. **Pre-upgrade setup** with the original flow: `review install claude --trace-endpoint … --trace-bucket … --trace-key … --trace-secret … --trace-region us-east-1`, then `review trace enable .` in a scratch repository with a local bare `origin` and `GITHUB_REPOSITORY=acme/gate`.
2. **Pre-upgrade capture**: a synthetic session transcript under `~/.claude/projects`, a commit made with `AGENT_SESSION_ID` (the `prepare-commit-msg` hook added the `Agent-Session` trailer), and `git push` (the `pre-push` hook wrote `by-commit/<sha>.json` and uploaded `by-session/<id>/trace.jsonl` and `meta.json`). `review trace sync` reported `unchanged`; `trace list --commit HEAD`, `trace show`, `trace status`, and `review scaffold` (the Desktop discovery and materialization path) all read the session back.
3. **Config file hashes and modes recorded** for `env`, `settings.json`, and `repositories.json` (all `0600`).
4. **Upgrade in place**: the `review` wrapper's target was switched to the new build. Nothing else changed.
5. **Post-upgrade reads with the network guard on**: `trace status` names the legacy env file as the credential source and `config.json (not present)`; `trace list --commit HEAD`, `trace pull --commit HEAD` (forced refresh from the bucket), and `trace show` returned the pre-upgrade session with `cache: "current"`.
6. **Post-upgrade capture**: a second session, commit, and push wrote `by-commit/<sha2>.json`, `by-session/<id2>/trace.jsonl`, and `meta.json`; `trace sync`, `trace list`, `trace show`, and `review scaffold --new` read it back.
7. **Checks**: the three configuration files hashed identically before and after; `~/.dev/trace/config.json` was not created; the network log stayed empty.

Bucket contents after step 6:

```text
by-commit/310d61c722b22a78f85a0eac37f33f8d5606b83d.json
by-commit/df3ee4f38881de6acf4205180a5f2fed973c89f9.json
by-session/aaaa1111-0000-4000-8000-000000000001/meta.json
by-session/aaaa1111-0000-4000-8000-000000000001/trace.jsonl
by-session/bbbb2222-0000-4000-8000-000000000002/meta.json
by-session/bbbb2222-0000-4000-8000-000000000002/trace.jsonl
```

Configuration file digests (identical before and after the upgrade):

```text
72e777ee685ebdc738dfb429779274e1a6f896e8634d5a649ff07675ffdce19c -rw------- ~/.config/dev-trace/env
fb2906a181923fd51bfff88f2a31f5c2d63ba42bec264f1d398519aa79d83d25 -rw------- ~/.config/dev-trace/settings.json
03523e19539b58aa87fa9b80445d96422270f8993ddc524edace898e2bfed1d3 -rw------- ~/.config/dev-trace/repositories.json
```

### Gates

`review trace disable .` stopped the commit hook from adding a trailer;
`review trace enable .` restored it; `TRACE_DISABLE=1` stopped it again on an
enabled repository.

### Migration acceptance

`review trace config migrate --dry-run --json` wrote nothing and printed the
key prefix only. `review trace config migrate --json` wrote
`~/.dev/trace/config.json` (`current-store: "s3"` plus `stores.s3`) with
mode `0600`, retired the legacy `env` and `settings.json` to `legacy_env`
and `legacy_settings.json` byte-identical, and never printed the secret.
With only the new file active, `trace status` named the config profile as
the credential source and the bucket stayed reachable; `trace list`, `trace show` of the pre-upgrade session, and a
fourth captured, pushed, and synced session all worked. Renaming the retired
files back and deleting `config.json` returned status to the legacy
configuration.

The first run of this phase found a defect: the doctor still required the
legacy env file to exist and reported "No trace configuration found" on a
migrated machine. The doctor now reports the resolved source; the regression
test lives in `trace-storage-cli.test.ts`.

### Hosted contract check

The Dev alpha branch (`fix/hosted-traces-alpha` in `../dev-hosted-traces`,
copied read-only to scratch) installed against the `@dev.fast/trace-shared@0.2.0`
tarball packed from this branch. Its `trace-api` unit tests (22 passed,
4 live-S3 tests skipped) and worker tests (27 passed) pass. This establishes
client/server agreement on the revised contract, not deployment.

## Real installation check

Result: **passed** (repeated after the `current-store`/`stores` schema
revision with the same outcome). The same comparison was repeated on a developer machine
with a real, pre-existing direct setup (`~/.config/dev-trace/env` and
`settings.json` from the original setup flow, a Cloudflare R2 bucket, this
repository registered for capture) and two sessions already in the bucket.
Review Desktop was running, so `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1` kept the
standalone builds from deferring to the app's bundled CLI; without it every
"new CLI" command silently ran the bundled older CLI, which is the intended
delegation behavior and worth knowing when testing.

| Step (new CLI, network guard on) | Result |
| --- | --- |
| `trace status` | legacy env file named as the credential source, `config.json (not present)`, bucket reachable |
| `trace show <s1>`, `trace show <s2>` | both sessions read from the bucket; `show --json` identical to the pre-upgrade CLI apart from the new `cache` field |
| `trace pull --session <s1>` | materialized into the existing corpus |
| `trace sync <s2>` | main and two subagent objects reported `unchanged` |
| `trace show <s2> --storage s3` | works |
| `trace show <s2> --storage hosted` | refused: hosted not configured, no fallback |
| `trace config migrate --dry-run` | preview only, no file written, key prefix only |
| Config files | `env`, `settings.json`, `repositories.json` hash-identical before and after; no `config.json` created |
| Non-loopback requests from Node | none |

Note: the machine's `repositories.json` already contained many
`trace-cli-test-*` temporary paths before this branch. The existing test
suite registers scratch repositories through the real home; that is a
pre-existing test hygiene issue, not a behavior of this change.

## Limitations

- The packaged Desktop application was not exercised end to end. Desktop's
  discovery and materialization path ran through `review scaffold`, and the
  `/agent-traces` routes are covered by unit tests; opening a review in the
  headless Desktop server requires a published revision, which this gate did
  not create.
- The bucket was a local MinIO instance, not the production R2 bucket.
- Hosted storage end to end against a deployed backend remains blocked on Dev
  delivery: push the alpha fixes to PR #1052, publish `@dev.fast/trace-shared@0.2.0`,
  grant `s3:GetObjectAttributes`, apply migration 0003, and deploy. Until then
  `review trace storage use hosted` refuses to select an origin that answers
  the older contract.

## Rerunning the gate

Start MinIO and create the bucket:

```sh
docker run -d --name review-trace-gate -p 127.0.0.1:9000:9000 \
  -e MINIO_ROOT_USER=gateadmin -e MINIO_ROOT_PASSWORD=gateadminsecret minio/minio server /data
AWS_ACCESS_KEY_ID=gateadmin AWS_SECRET_ACCESS_KEY=gateadminsecret \
  aws --region us-east-1 --endpoint-url http://127.0.0.1:9000 s3api create-bucket --bucket review-traces-gate
```

Lay out a gate directory with `bin/review` (a wrapper that runs
`node "$(cat bin/review.target)" "$@"`), a detached `pre-upgrade` checkout of
the previous release built with `pnpm --filter @dev.fast/review build`, the
`no-network.cjs` guard, and `run-gate.sh` below. Update the two `review.target`
paths in the script, then run `bash run-gate.sh`; it ends with `GATE PASSED`
or the first failing step.

`no-network.cjs`:

```js
// Fails every non-loopback network request from Node and logs the attempt,
// so the upgrade gate can prove the direct-storage flow makes no hosted calls.
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const logPath = process.env.GATE_NETWORK_LOG;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
function record(kind, target) {
  const line = `${new Date().toISOString()} ${kind} ${target}\n`;
  if (logPath) fs.appendFileSync(logPath, line);
  return new Error(`network blocked by the upgrade gate: ${kind} ${target}`);
}
function hostOf(input) {
  try {
    return new URL(String(input)).hostname;
  } catch {
    return String(input);
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const host = hostOf(input instanceof Request ? input.url : input);
  if (!LOOPBACK.has(host)) throw record("fetch", host);
  return originalFetch(input, init);
};
for (const mod of [http, https]) {
  const original = mod.request;
  mod.request = function (...args) {
    const first = args[0];
    const host =
      typeof first === "string" || first instanceof URL
        ? hostOf(first)
        : (first && (first.hostname || first.host)) || "";
    if (host && !LOOPBACK.has(host)) throw record("http", host);
    return original.apply(this, args);
  };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = typeof args[0] === "object" && args[0] ? args[0] : {};
  const host = options.host || (typeof args[1] === "string" ? args[1] : "");
  if (host && !LOOPBACK.has(host)) throw record("socket", host);
  return originalConnect.apply(this, args);
};
```

`run-gate.sh`:

```bash
#!/bin/bash
# Upgrade gate: a working direct S3/R2 setup made with the pre-upgrade CLI
# must keep working after replacing only the CLI, with no config edits and
# no hosted requests. Everything runs in a disposable HOME against MinIO.
set -u
GATE="$(cd "$(dirname "$0")" && pwd)"
LOG="$GATE/evidence.log"
: > "$LOG"
say() { printf '\n### %s\n' "$*" | tee -a "$LOG"; }
run() { printf '$ %s\n' "$*" >> "$LOG"; "$@" >> "$LOG" 2>&1; local code=$?; printf '[exit %s]\n' "$code" >> "$LOG"; return $code; }
fail() { printf '\nGATE FAILED: %s\n' "$*" | tee -a "$LOG"; exit 1; }
hashes() { for f in "$HOME/.config/dev-trace/env" "$HOME/.config/dev-trace/settings.json" "$HOME/.config/dev-trace/repositories.json"; do if [ -e "$f" ]; then printf '%s %s %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(stat -f '%Sp' "$f")" "$f"; fi; done; }
bucket_ls() { AWS_ACCESS_KEY_ID=gateadmin AWS_SECRET_ACCESS_KEY=gateadminsecret aws --region us-east-1 --endpoint-url http://127.0.0.1:9000 s3api list-objects-v2 --bucket review-traces-gate --query 'Contents[].Key' --output text | tr '\t' '\n' | sort; }
session_file() { # $1 session id, $2 text
  local dir="$HOME/.claude/projects/-gate-repo"; mkdir -p "$dir"
  printf '%s\n%s\n' \
    "{\"type\":\"session\",\"id\":\"$1\",\"cwd\":\"$REPO\",\"timestamp\":\"2026-09-09T12:00:00Z\"}" \
    "{\"type\":\"message\",\"timestamp\":\"2026-09-09T12:00:05Z\",\"message\":{\"role\":\"user\",\"content\":\"$2\"}}" \
    > "$dir/$1.jsonl"
}

# The developer shell names an AWS profile that does not exist in the
# disposable home; the gate uses only the credentials Review passes.
# The gate runs inside an agent session; the scratch repository must not
# bind to it.
for v in $(env | grep -iE '^(CLAUDE|CODEX|OPENCODE|AGENT_SESSION)' | cut -d= -f1); do unset "$v"; done
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export HOME="$GATE/home"; rm -rf "$HOME"; mkdir -p "$HOME"
export DEV_REVIEW_HOME="$HOME/.dev"
export REVIEW_TRACE_COMMAND="$GATE/bin/review"
export GITHUB_REPOSITORY=acme/gate
export DEV_FAST_REVIEW_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
export PATH="$GATE/bin:$PATH"
REPO="$GATE/repo"; rm -rf "$REPO" "$GATE/remote.git"; mkdir -p "$REPO"
S1=aaaa1111-0000-4000-8000-000000000001
S2=bbbb2222-0000-4000-8000-000000000002
S3=cccc3333-0000-4000-8000-000000000003
S4=dddd4444-0000-4000-8000-000000000004

say "Phase A: pre-upgrade setup with $(cat "$GATE/bin/review.target")"
echo "$GATE/pre-upgrade/packages/progressive-review/dist/cli.js" > "$GATE/bin/review.target"
run review --version || fail "pre-upgrade cli"
run review install claude --trace-endpoint http://127.0.0.1:9000 --trace-bucket review-traces-gate --trace-key gateadmin --trace-secret gateadminsecret --trace-region us-east-1 || fail "install"
git init -q -b main "$GATE/remote.git" --bare
cd "$REPO" && git init -q -b main && git config user.name Gate && git config user.email gate@example.com && git remote add origin "$GATE/remote.git"
echo "# gate" > README.md && git add README.md && git commit -qm "initial" && git push -q origin main
run review trace enable . || fail "trace enable"
session_file "$S1" "first session"
echo "one" > one.txt && git add one.txt && AGENT_SESSION_ID=$S1 git commit -qm "Add one" || fail "commit 1"
git show -s --format=%B HEAD | grep -q "Agent-Session: $S1" || fail "trailer 1 missing"
run git push origin main || fail "push 1"
sleep 1
say "Pre-upgrade explicit sync and reads"
run review trace sync "$S1" --json || fail "sync 1"
run review trace list --commit HEAD --json || fail "list 1"
run review trace show "$S1" --json || fail "show 1"
run review trace status
say "Pre-upgrade bucket objects"; bucket_ls | tee -a "$LOG"
bucket_ls | grep -q "by-session/$S1/trace.jsonl" || fail "trace object 1"
bucket_ls | grep -q "by-commit/$(git rev-parse HEAD).json" || fail "by-commit 1"
say "Pre-upgrade scaffold (Desktop discovery path)"
run review scaffold --base HEAD~1 --head main --json || fail "scaffold pre"
say "Pre-upgrade config file hashes and modes"; hashes | tee "$GATE/hashes-before.txt" | tee -a "$LOG"

say "Phase B: upgrade only the CLI; hosted network blocked"
echo "/Users/aiansiti/workable/review-trace-storage/packages/progressive-review/dist/cli.js" > "$GATE/bin/review.target"
export NODE_OPTIONS="--require $GATE/no-network.cjs" GATE_NETWORK_LOG="$GATE/network.log"; : > "$GATE/network.log"
run review --version || fail "new cli"
run review trace status || fail "status after upgrade"
run review trace list --commit HEAD --json || fail "list after upgrade"
run review trace pull --commit HEAD --json || fail "pull after upgrade"
run review trace show "$S1" --json || fail "show after upgrade"
session_file "$S2" "second session after upgrade"
echo "two" > two.txt && git add two.txt && AGENT_SESSION_ID=$S2 git commit -qm "Add two" || fail "commit 2"
git show -s --format=%B HEAD | grep -q "Agent-Session: $S2" || fail "trailer 2 missing"
run git push origin main || fail "push 2"
sleep 1
run review trace sync "$S2" --json || fail "sync 2"
run review trace list --commit HEAD --json || fail "list 2"
run review trace show "$S2" --json || fail "show 2"
say "Post-upgrade bucket objects"; bucket_ls | tee -a "$LOG"
bucket_ls | grep -q "by-session/$S2/trace.jsonl" || fail "trace object 2"
bucket_ls | grep -q "by-commit/$(git rev-parse HEAD).json" || fail "by-commit 2"
say "Post-upgrade scaffold (Desktop discovery path)"
run review scaffold --base HEAD~2 --head main --new --json || fail "scaffold post"
say "Post-upgrade config file hashes and modes"; hashes | tee "$GATE/hashes-after.txt" | tee -a "$LOG"
diff "$GATE/hashes-before.txt" "$GATE/hashes-after.txt" >> "$LOG" || fail "config files changed"
[ ! -e "$DEV_REVIEW_HOME/trace/config.json" ] || fail "config.json was created without a request"
[ ! -s "$GATE/network.log" ] || { cat "$GATE/network.log" >> "$LOG"; fail "non-loopback network attempt"; }
echo "no non-loopback network attempts" | tee -a "$LOG"

say "Phase C: enable/disable gates"
run review trace disable . || fail "disable"
session_file "$S3" "disabled repository"
echo "three" > three.txt && git add three.txt && AGENT_SESSION_ID=$S3 git commit -qm "Add three" || fail "commit 3"
if git show -s --format=%B HEAD | grep -q "Agent-Session: $S3"; then fail "trailer added while disabled"; fi
run review trace enable . || fail "re-enable"
echo "four" > four.txt && git add four.txt && TRACE_DISABLE=1 AGENT_SESSION_ID=$S3 git commit -qm "Add four" || fail "commit 4"
if git show -s --format=%B HEAD | grep -q "Agent-Session: $S3"; then fail "trailer added under TRACE_DISABLE"; fi
echo "gates ok" | tee -a "$LOG"

say "Phase D: migration acceptance"
run review trace config migrate --dry-run --json || fail "migrate dry-run"
[ ! -e "$DEV_REVIEW_HOME/trace/config.json" ] || fail "dry-run wrote config"
run review trace config migrate --json || fail "migrate"
[ -e "$DEV_REVIEW_HOME/trace/config.json" ] || fail "migrate wrote nothing"
stat -f '%Sp %N' "$DEV_REVIEW_HOME/trace/config.json" | tee -a "$LOG"
# Command output must never carry the secret; only the echoed install
# command line does, by construction.
if grep -v '^\$ ' "$LOG" | grep -q gateadminsecret; then fail "secret leaked into command output"; fi
# Migrate retires the legacy files beside their originals, unchanged.
[ ! -e "$HOME/.config/dev-trace/env" ] || fail "env file still active after migrate"
[ ! -e "$HOME/.config/dev-trace/settings.json" ] || fail "settings file still active after migrate"
[ "$(shasum -a 256 "$HOME/.config/dev-trace/legacy_env" | cut -d' ' -f1)" = "$(head -1 "$GATE/hashes-before.txt" | cut -d' ' -f1)" ] || fail "retired env differs"
run review trace status || fail "status after migrate"
run review trace status || fail "status with new config only"
# HEAD~2 is the traced commit; HEAD and HEAD~1 were made with capture off.
run review trace list --commit HEAD~2 --json || fail "list with new config only"
run review trace show "$S1" --json || fail "old trace read with new config only"
session_file "$S4" "session under migrated config"
echo "five" > five.txt && git add five.txt && AGENT_SESSION_ID=$S4 git commit -qm "Add five" || fail "commit 5"
git show -s --format=%B HEAD | grep -q "Agent-Session: $S4" || fail "trailer 5 missing"
run git push origin main || fail "push 5"
sleep 1
run review trace sync "$S4" --json || fail "sync 5"
bucket_ls | grep -q "by-session/$S4/trace.jsonl" || fail "trace object 5"
run review trace show "$S4" --json || fail "show 5"
say "Rollback: rename the retired files back, remove config.json"
mv "$HOME/.config/dev-trace/legacy_env" "$HOME/.config/dev-trace/env" && mv "$HOME/.config/dev-trace/legacy_settings.json" "$HOME/.config/dev-trace/settings.json" && rm "$DEV_REVIEW_HOME/trace/config.json"
run review trace status || fail "status after rollback"
run review trace list --commit HEAD --json || fail "list after rollback"
[ ! -s "$GATE/network.log" ] || fail "non-loopback network attempt (late)"
say "GATE PASSED"
```
