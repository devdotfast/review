"""Locate, cut, and fork an implementation session so a review can be requested
from inside its context.

Raw transcripts come from the harness's native store when present, else from
R2 (`by-session/<id>/trace.jsonl`, a byte-for-byte copy). The fork is a new
session id in the native store with `cwd` rewritten to the run's worktree and
everything from the first review activity onward dropped.
"""

import glob
import json
import os
import re
import subprocess
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

HOME = Path.home()
TRACE_ENV_PATH = HOME / ".config" / "dev-trace" / "env"
# A *request* for a review, not a mention of the dev-review product (these
# repos develop it, so bare mentions are everywhere).
REVIEW_REQUEST = re.compile(
    r"(?:^|\n)\s*(?:/|\$)dev-review\b"  # slash/skill invocation
    r"|(?:^|\n)\s*dev.?review\s*\d*\s*(?:$|\n)"  # bare "dev review 2"
    r"|(?:write|create|make|author|publish|do|give me|can you .{0,30})[^.\n]{0,40}\b(?:dev.?review|review)\b[^.\n]{0,30}(?:of th|for th|this|it\b|change|commit|branch|pr\b)"
    r"|\buse the dev-review skill\b",
    re.IGNORECASE,
)
REVIEW_CLI = re.compile(
    r"(?:^|[\s;&|(\"'])review\s+(?:scaffold|info|publish|wait|rebind|app\s+(?:launch|pick)|map\s+(?:open|check|publish))(?:\s|$|[\"'|;&])"
)
HARNESS_NOISE = ("<task-notification>", "<system-reminder>", "<local-command", "<command-name>")


@dataclass(frozen=True)
class RawSession:
    harness: str
    session_id: str
    path: Path
    source: str  # local | r2


@dataclass(frozen=True)
class CutPoint:
    index: int  # first record index dropped; len(records) when nothing is cut
    reason: str


def load_trace_env() -> dict[str, str]:
    if not TRACE_ENV_PATH.exists():
        raise FileNotFoundError(f"{TRACE_ENV_PATH} missing; R2 traces are unavailable.")
    env: dict[str, str] = {}
    for line in TRACE_ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def find_local_raw(harness: str, session_id: str) -> Path | None:
    if harness == "claude-code":
        pattern = f"{HOME}/.claude/projects/*/{session_id}.jsonl"
    elif harness == "codex":
        pattern = f"{HOME}/.codex/sessions/*/*/*/rollout-*-{session_id}.jsonl"
    elif harness == "pi":
        pattern = f"{HOME}/.pi/agent/sessions/**/*{session_id}*.jsonl"
    else:
        raise ValueError(f"unknown harness {harness}")
    matches = sorted(glob.glob(pattern, recursive=True))
    return Path(matches[0]) if matches else None


def download_raw_from_r2(session_id: str, dest: Path) -> Path:
    env = load_trace_env()
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "aws",
            "--region",
            "auto",
            "--endpoint-url",
            env["TRACE_R2_ENDPOINT"],
            "s3api",
            "get-object",
            "--bucket",
            env["TRACE_R2_BUCKET"],
            "--key",
            f"by-session/{session_id}/trace.jsonl",
            str(dest),
        ],
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "AWS_ACCESS_KEY_ID": env["TRACE_R2_ACCESS_KEY_ID"],
            "AWS_SECRET_ACCESS_KEY": env["TRACE_R2_SECRET_ACCESS_KEY"],
        },
    )
    return dest


def resolve_raw_session(harness: str, session_id: str, cache_dir: Path) -> RawSession:
    local = find_local_raw(harness, session_id)
    if local is not None:
        return RawSession(harness, session_id, local, "local")
    dest = cache_dir / f"{session_id}.jsonl"
    if not dest.exists():
        download_raw_from_r2(session_id, dest)
    return RawSession(harness, session_id, dest, "r2")


def read_jsonl(path: Path) -> list[dict]:
    records = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


# --- cut point --------------------------------------------------------------


def claude_user_prompt_text(record: dict) -> str | None:
    """Text of a real user prompt; None for tool results and harness notices."""
    if record.get("type") != "user" or record.get("isSidechain"):
        return None
    content = (record.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(block.get("type") == "tool_result" for block in content):
            return None
        text = "\n".join(block.get("text", "") for block in content if block.get("type") == "text")
    else:
        return None
    stripped = text.lstrip()
    if not stripped or stripped.startswith(HARNESS_NOISE):
        return None
    return text


def claude_record_review_activity(record: dict) -> str | None:
    kind = record.get("type")
    content = (record.get("message") or {}).get("content")
    prompt = claude_user_prompt_text(record)
    if prompt is not None and REVIEW_REQUEST.search(prompt):
        return "user asked for a review"
    # Skill expansion: the harness injects SKILL.md as a user message when the
    # skill is invoked — unambiguous review activity.
    if kind == "user":
        raw = content if isinstance(content, str) else json.dumps(content or "")
        if re.search(r"Base directory for this skill: \S*dev-review\b", raw):
            return "dev-review skill was invoked"
    if kind == "assistant" and isinstance(content, list):
        for block in content:
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            payload = block.get("input") or {}
            if name == "Skill" and "dev-review" in str(payload.get("skill", "")):
                return "agent invoked the dev-review skill"
            if name == "Bash" and REVIEW_CLI.search(str(payload.get("command", ""))):
                return "agent ran the review CLI"
            # Reading SKILL.md is not review activity: sessions in these
            # repos read it while developing the product itself.
    return None


def codex_record_review_activity(record: dict) -> str | None:
    payload = record.get("payload") or {}
    kind = record.get("type")
    if kind == "event_msg" and payload.get("type") == "user_message":
        if REVIEW_REQUEST.search(str(payload.get("message", ""))):
            return "user asked for a review"
    if kind == "response_item" and payload.get("type") in ("function_call", "custom_tool_call"):
        args = str(payload.get("arguments", "")) + str(payload.get("input", ""))
        if REVIEW_CLI.search(args):
            return "agent ran the review CLI"
    return None


def find_cut_point(harness: str, records: list[dict]) -> CutPoint:
    detect = claude_record_review_activity if harness == "claude-code" else codex_record_review_activity
    if harness == "pi":
        raise NotImplementedError("pi cut-point detection is not implemented yet")
    for index, record in enumerate(records):
        reason = detect(record)
        if reason:
            # Cut before the user turn that led here: back up to the nearest
            # preceding user record so the fork ends on an assistant turn.
            cut = index
            if harness == "claude-code":
                while cut > 0 and claude_user_prompt_text(records[cut]) is None:
                    cut -= 1
            else:
                while cut > 0 and not (
                    records[cut].get("type") == "event_msg"
                    and (records[cut].get("payload") or {}).get("type") == "user_message"
                ):
                    cut -= 1
            return CutPoint(index=cut, reason=f"{reason} (record {index})")
    return CutPoint(index=len(records), reason="no review activity; whole session kept")


# --- forks ------------------------------------------------------------------


def claude_project_dir(cwd: Path) -> Path:
    return HOME / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def fork_claude(records: list[dict], cut: int, worktree: Path) -> str:
    new_id = str(uuid.uuid4())
    prompt_id = str(uuid.uuid4())
    forked = []
    for record in records[:cut]:
        copy = dict(record)
        if "sessionId" in copy:
            copy["sessionId"] = new_id
        if "session_id" in copy:
            copy["session_id"] = new_id
        if "cwd" in copy:
            copy["cwd"] = str(worktree)
        if "promptId" in copy:
            copy["promptId"] = prompt_id
        forked.append(copy)
    project_dir = claude_project_dir(worktree)
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / f"{new_id}.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in forked)
    )
    return new_id


def rewrite_cwd(value, old: str, new: str):
    if isinstance(value, str):
        return value.replace(old, new) if old in value else value
    if isinstance(value, list):
        return [rewrite_cwd(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: rewrite_cwd(v, old, new) for k, v in value.items()}
    return value


def fork_codex(records: list[dict], cut: int, worktree: Path) -> str:
    new_id = str(uuid.uuid4())
    meta = next(r for r in records if r.get("type") == "session_meta")
    old_cwd = meta["payload"]["cwd"]
    forked = []
    for record in records[:cut]:
        copy = json.loads(json.dumps(record))
        if copy.get("type") == "session_meta":
            copy["payload"]["id"] = new_id
            copy["payload"]["session_id"] = new_id
        copy = rewrite_cwd(copy, old_cwd, str(worktree))
        forked.append(copy)
    now = datetime.now(UTC)
    session_dir = HOME / ".codex" / "sessions" / now.strftime("%Y") / now.strftime("%m") / now.strftime("%d")
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / f"rollout-{now.strftime('%Y-%m-%dT%H-%M-%S')}-{new_id}.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in forked))
    return new_id


def codex_session_model(records: list[dict]) -> str | None:
    """Model of the last turn before the cut; the fork must resume on it."""
    model = None
    for record in records:
        if record.get("type") == "turn_context":
            model = (record.get("payload") or {}).get("model") or model
    return model


def fork_session(harness: str, records: list[dict], cut: int, worktree: Path) -> str:
    if harness == "claude-code":
        return fork_claude(records, cut, worktree)
    if harness == "codex":
        return fork_codex(records, cut, worktree)
    raise NotImplementedError(f"forking {harness} sessions is not implemented yet")


# --- representative commit + worktree ---------------------------------------


def record_timestamp_ms(harness: str, record: dict) -> float | None:
    value = record.get("timestamp")
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def cut_timestamp_ms(harness: str, records: list[dict], cut: int) -> float:
    """Wall clock of the cut: the first dropped record, else the last kept one."""
    for index in list(range(cut, len(records))) + list(range(cut - 1, -1, -1)):
        ts = record_timestamp_ms(harness, records[index])
        if ts is not None:
            return ts
    raise ValueError("transcript has no timestamps")


def git_out(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


def representative_commit(repo: Path, session_id: str, cut_ms: float, pr: int) -> tuple[str, str]:
    """The checkout state the user was in at the cut.

    1. Latest commit carrying this session's Agent-Session trailer, committed
       at or before the cut (the session's own line of work).
    2. Else the latest commit on the PR branch at or before the cut.
    3. Else the PR head.
    """
    before = datetime.fromtimestamp(cut_ms / 1000, UTC).isoformat()
    subprocess.run(["git", "fetch", "-q", "origin", f"pull/{pr}/head"], cwd=repo, check=True, capture_output=True)
    # Compare AUTHOR dates: rebases move the commit date, and trailer commits
    # are frequently rebased after the session ends.
    listing = git_out(
        repo, "log", "--all", "--format=%H %at", f"--grep=Agent-Session: {session_id}"
    )
    candidates = []
    for line in listing.splitlines():
        sha, authored = line.split()
        if float(authored) * 1000 <= cut_ms:
            candidates.append((float(authored), sha))
    if candidates:
        return max(candidates)[1], "latest session commit (author date) before the cut"
    pr_head = subprocess.run(
        ["gh", "pr", "view", str(pr), "--json", "headRefOid", "--jq", ".headRefOid"],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout.strip()
    on_branch = git_out(repo, "log", "--format=%H", "-1", f"--before={before}", pr_head)
    if on_branch:
        return on_branch, "latest PR-branch commit before the cut"
    return pr_head, "PR head (no commit predates the cut)"


def prepare_worktree(repo: Path, head: str, worktree: Path, branch: str) -> str:
    if worktree.exists():
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree)],
            cwd=repo,
            check=True,
            capture_output=True,
        )
    worktree.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "worktree", "add", "-B", branch, str(worktree), head],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    return head
