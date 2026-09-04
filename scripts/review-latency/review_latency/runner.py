"""Execute one authoring run: prepare the machine, drive Claude Code, collect artifacts."""

import json
import os
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from review_latency.config import REPO_ROOT, SOURCE_CLI, RunSpec
from review_latency.sessions import (
    codex_session_model,
    cut_timestamp_ms,
    fork_session,
    find_cut_point,
    find_local_raw,
    prepare_worktree,
    read_jsonl,
    representative_commit,
    resolve_raw_session,
)
from review_latency.surface import surface_fingerprint

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
# Environment that would make the nested Claude Code think it is inside this
# one, or make the review CLI attribute commands to the outer session.
INHERITED_SESSION_ENV = (
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "DEV_FAST_AGENT_SESSION",
    "CODEX_THREAD_ID",
    "PI_SESSION_ID",
    "DEV_FAST_REVIEW_TRACE",
)


def claude_project_dir(cwd: Path) -> Path:
    return CLAUDE_PROJECTS_DIR / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))


def read_desktop_discovery(home: Path) -> dict:
    path = home / "review-desktop" / "server.json"
    if not path.exists():
        raise RuntimeError(f"Review Desktop discovery file missing at {path}.")
    return json.loads(path.read_text())


def desktop_request(method: str, route: str, home: Path) -> dict | None:
    discovery = read_desktop_discovery(home)
    request = urllib.request.Request(
        f"{discovery['url']}{route}",
        method=method,
        headers={"x-review-token": discovery["token"]},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
    return json.loads(body) if body else None


# Each run gets its own review app: DEV_REVIEW_HOME (reviews store + desktop
# discovery) under the run dir, and the desktop's Electron state under a short
# /tmp path — the user-data dir carries a unix socket capped at 103 chars.
PACKAGED_DESKTOP = Path("/Applications/dev.fast Review.app/Contents/MacOS/Review")
# Development desktop from this checkout: the Code OSS shell built by
# `pnpm --filter @dev-fast/review-desktop app:build`, serving this checkout's
# review server, so desktop-side instrumentation is measurable. run.sh honors
# DEV_REVIEW_HOME and DEV_FAST_REVIEW_DESKTOP_STATE_ROOT and execs the binary.
DEV_DESKTOP_RUN = REPO_ROOT / "apps" / "review-desktop" / "scripts" / "run.sh"
STATE_ROOTS = Path("/tmp/review-latency")


def desktop_command(mode: str, state: Path) -> list[str]:
    if mode == "packaged":
        if not PACKAGED_DESKTOP.exists():
            raise RuntimeError(f"Packaged Review app missing at {PACKAGED_DESKTOP}.")
        return [
            str(PACKAGED_DESKTOP),
            "--disable-telemetry",
            "--skip-welcome",
            f"--user-data-dir={state / 'user-data'}",
            f"--extensions-dir={state / 'extensions'}",
        ]
    if mode == "dev":
        if not DEV_DESKTOP_RUN.exists():
            raise RuntimeError(f"{DEV_DESKTOP_RUN} is missing.")
        return ["bash", str(DEV_DESKTOP_RUN)]
    raise ValueError(f"desktop must be packaged|dev, got {mode}")


def launch_desktop(home: Path, state: Path, mode: str, log) -> subprocess.Popen:
    home.mkdir(parents=True, exist_ok=True)
    for sub in ("user-data", "extensions"):
        (state / sub).mkdir(parents=True, exist_ok=True)
    desktop_log = (home / "desktop.log").open("w")
    process = subprocess.Popen(
        desktop_command(mode, state),
        cwd=REPO_ROOT,
        env=os.environ
        | {
            "DEV_REVIEW_HOME": str(home),
            "DEV_FAST_REVIEW_DESKTOP_STATE_ROOT": str(state),
        },
        stdout=desktop_log,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"isolated desktop exited with {process.returncode}; see {home / 'desktop.log'}"
            )
        if (home / "review-desktop" / "server.json").exists():
            try:
                health = desktop_request("GET", "/health", home)
            except (urllib.error.URLError, ConnectionError):
                health = None  # server.json written before the port listens
            if health and health.get("ok") and health.get("desktopAttached"):
                log(f"isolated {mode} desktop up at {read_desktop_discovery(home)['url']} (pid {process.pid})")
                return process
        time.sleep(0.5)
    process.terminate()
    raise RuntimeError(f"isolated desktop not healthy after 120s; see {home / 'desktop.log'}")


def shutdown_desktop(process: subprocess.Popen, log) -> None:
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("isolated desktop ignored SIGTERM; killing")
        process.kill()
        process.wait(timeout=10)


def write_review_shim(bin_dir: Path, calls_log: Path) -> Path:
    """`review` on the agent's PATH runs the instrumented source CLI.

    Every invocation is journaled to `calls_log` (start + exit code), which is
    how the runner knows the document was published and shown regardless of
    how the agent filters the CLI's output.
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    shim = bin_dir / "review"
    tsx = REPO_ROOT / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        raise RuntimeError(f"{tsx} is missing; run pnpm install at the repo root.")
    shim.write_text(
        "#!/bin/sh\n"
        "# review-latency harness shim: instrumented source CLI, no desktop delegation.\n"
        "export DEV_FAST_REVIEW_CLI_NO_DELEGATE=1\n"
        f'printf \'%s start %s\\n\' "$(date +%s)" "$*" >> "{calls_log}"\n'
        f'errlog="{calls_log.parent / "review-shim-stderr.log"}"\n'
        'tmp="$(mktemp)"\n'
        # tsx reads tsconfig from the *cwd*; inside a fork worktree's package
        # dir the worktree's `paths` would remap workspace packages onto that
        # worktree's (older) sources. Pin the instrumented checkout's tsconfig.
        f'"{tsx}" --tsconfig "{SOURCE_CLI.parent.parent / "tsconfig.json"}" "{SOURCE_CLI}" "$@" 2>"$tmp"\n'
        "code=$?\n"
        # Keep the CLI's stderr for the agent and a copy for the runner, which
        # aborts the run if the CLI itself fails to load (see shim_load_failure).
        'cat "$tmp" >&2; cat "$tmp" >> "$errlog"; rm -f "$tmp"\n'
        f'printf \'%s exit %s %s\\n\' "$(date +%s)" "$code" "$*" >> "{calls_log}"\n'
        "exit $code\n"
    )
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    # ast-grep rides along on the same PATH so the skill can ask for AST
    # spans; the app will bundle it the same way once the skill relies on it.
    # The npm shim in node_modules/.bin only becomes real after a postinstall
    # pnpm refuses to run here; link the platform package's binary directly.
    binary = ast_grep_binary()
    for name in ("ast-grep", "sg"):
        link = bin_dir / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(binary)
    return shim


def ast_grep_binary() -> Path:
    import platform
    system = {"Darwin": "darwin", "Linux": "linux"}[platform.system()]
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}[platform.machine()]
    binary = REPO_ROOT / "node_modules" / "@ast-grep" / f"cli-{system}-{arch}" / "ast-grep"
    if not binary.exists():
        raise RuntimeError(f"{binary} is missing; run pnpm install at the repo root.")
    return binary


def write_zdotdir(zdotdir: Path, bin_dir: Path) -> Path:
    zdotdir.mkdir(parents=True, exist_ok=True)
    home = Path.home()
    for name in (".zshenv", ".zprofile", ".zshrc", ".zlogin"):
        user_file = home / name
        lines = ["# review-latency harness: user startup file, then the review shim first on PATH."]
        if user_file.exists():
            lines.append(f'source "{user_file}"')
        lines.append(f'export PATH="{bin_dir}:$PATH"')
        (zdotdir / name).write_text("\n".join(lines) + "\n")
    return zdotdir


def review_verb(args: str) -> str:
    """`publish --review X` -> publish; `app pick --review X` -> app pick."""
    tokens = [token for token in args.split() if not token.startswith("-")]
    if not tokens:
        return ""
    if tokens[0] in ("app", "map", "trace") and len(tokens) > 1:
        return f"{tokens[0]} {tokens[1]}"
    return tokens[0]


SHIM_LOAD_FAILURE = re.compile(r"^(SyntaxError|ReferenceError|TypeError|Error \[ERR_MODULE_NOT_FOUND\]|Error: Cannot find module).*", re.M)


def shim_load_failure(calls_log: Path) -> str | None:
    """A CLI that fails to load (missing export, unresolved module) makes the
    agent route around the shim with whatever CLI it finds, which silently
    changes what the run measures. Abort instead."""
    errlog = calls_log.parent / "review-shim-stderr.log"
    if not errlog.exists():
        return None
    match = SHIM_LOAD_FAILURE.search(errlog.read_text(errors="replace"))
    return match.group(0) if match else None


def journal_lines(calls_log: Path, offset: int) -> list[list[str]]:
    """Journal rows appended after byte `offset` (the journal's size at agent
    launch). Earlier rows are the harness's own calls — `review publish --help`
    from the surface fingerprint — and can share the launch second, so a
    timestamp filter is not enough."""
    if not calls_log.exists():
        return []
    with calls_log.open("rb") as handle:
        handle.seek(offset)
        text = handle.read().decode("utf8")
    rows = []
    for line in text.splitlines():
        parts = line.split(" ", 3)
        if len(parts) >= 3:
            rows.append(parts)
    return rows


def stop_reason_from_calls(calls_log: Path, offset: int) -> str | None:
    """Stop once the document is published and shown, or the agent blocks in wait."""
    published = False
    for parts in journal_lines(calls_log, offset):
        kind = parts[1]
        if kind == "exit":
            code, args = parts[2], parts[3] if len(parts) > 3 else ""
            verb = review_verb(args)
            if verb == "publish" and code == "0":
                published = True
            elif verb == "app pick" and published:
                return "document published and shown"
        elif kind == "start" and published and review_verb(parts[2] + (" " + parts[3] if len(parts) > 3 else "")) == "wait":
            return "agent entered review wait after publish"
    return None


def published_in(calls_log: Path, offset: int) -> bool:
    for parts in journal_lines(calls_log, offset):
        if len(parts) == 4 and parts[1] == "exit" and parts[2] == "0" and review_verb(parts[3]) == "publish":
            return True
    return False


def build_env(run_dir: Path, spec: RunSpec, home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in INHERITED_SESSION_ENV}
    env["DEV_FAST_REVIEW_TRACE_DIR"] = str(run_dir / "cli-traces")
    env["DEV_REVIEW_HOME"] = str(home)
    # Trace storage is part of the experiment: "on" gets a fresh per-run corpus
    # (so every run pulls, like a first review of a PR would), "off" removes
    # trace storage end to end (see reviewTracesDisabled in the CLI).
    env["REVIEW_TEST_TRACE_SEARCH_DIR"] = str(run_dir / "profile" / "trace-search")
    if not spec.traces:
        env["DEV_FAST_REVIEW_TRACES"] = "off"
    if spec.review_cli == "source":
        bin_dir = run_dir / "bin"
        write_review_shim(bin_dir, run_dir / "review-calls.log")
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        # Codex runs tools through `zsh -lc`: a login shell re-sources the
        # profile (and macOS path_helper reorders PATH), which pushed the
        # installed `review` ahead of the shim. A harness-owned ZDOTDIR sources
        # the user's real startup files and then puts the shim back first.
        env["ZDOTDIR"] = str(write_zdotdir(run_dir / "zdotdir", bin_dir))
    elif spec.review_cli != "installed":
        raise ValueError(f"review_cli must be source|installed, got {spec.review_cli}")
    return env


def claude_command(spec: RunSpec, resume: str | None) -> list[str]:
    command = ["claude", "-p", spec.prompt, "--model", spec.model, "--effort", spec.effort]
    if resume:
        command += ["--resume", resume]
    return command + [
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        "--max-turns",
        str(spec.max_turns),
    ]


def codex_command(spec: RunSpec, resume: str | None, cwd: Path) -> list[str]:
    # -C and the sandbox bypass are global options; --json/-c/-m belong to
    # `exec` and `exec resume` alike.
    command = ["codex", "-C", str(cwd), "--dangerously-bypass-approvals-and-sandbox", "exec"]
    if resume:
        command += ["resume", resume]
    command += ["--json", "--skip-git-repo-check", "-c", f'model_reasoning_effort="{spec.effort}"']
    if spec.model != "default":
        command += ["-m", spec.model]
    return command + [spec.prompt]


def agent_command(spec: RunSpec, resume: str | None, cwd: Path) -> list[str]:
    if spec.harness == "claude-code":
        return claude_command(spec, resume)
    if spec.harness == "codex":
        return codex_command(spec, resume, cwd)
    raise NotImplementedError(f"harness {spec.harness} is not runnable yet")


def session_id_from_event(harness: str, event: dict) -> str | None:
    if harness == "claude-code" and event.get("type") == "system" and event.get("subtype") == "init":
        return event["session_id"]
    if harness == "codex" and event.get("type") == "thread.started":
        return event["thread_id"]
    return None


def is_result_event(harness: str, event: dict) -> bool:
    if harness == "claude-code":
        return event.get("type") == "result"
    return event.get("type") == "turn.completed"


def run_agent(
    spec: RunSpec, run_dir: Path, env: dict[str, str], log, cwd: Path, resume: str | None, model: str | None = None
) -> dict:
    stream_path = run_dir / "claude-stream.jsonl"
    stderr_path = run_dir / "claude-stderr.log"
    if model:
        spec = RunSpec(**{**spec.__dict__, "model": model})
    command = agent_command(spec, resume, cwd)
    shown = [("'<prompt>'" if part == spec.prompt else part) for part in command]
    log(f"$ {' '.join(shown)}")
    started_at = time.time()
    session_id: str | None = None
    result: dict | None = None
    stop_reason: str | None = None
    calls_log = run_dir / "review-calls.log"
    journal_offset = calls_log.stat().st_size if calls_log.exists() else 0
    with stream_path.open("w") as stream, stderr_path.open("w") as stderr:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )
        assert process.stdout is not None
        deadline = started_at + spec.timeout_minutes * 60
        for line in process.stdout:
            received_ms = time.time() * 1000
            event = json.loads(line)
            # Receipt time is the only clock for stream events; keep it next
            # to every event so claude_stream can time TTFT and thinking.
            stream.write(json.dumps({"t": received_ms, "e": event}) + "\n")
            stream.flush()
            if event.get("type") == "stream_event":
                continue
            found = session_id_from_event(spec.harness, event)
            if found:
                session_id = found
                log(f"{spec.harness} session {session_id}")
            elif event.get("type") == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        summary = summarize_tool_use(block)
                        log(f"  [{elapsed(started_at)}] {summary}")
            elif event.get("type") == "item.started" and event.get("item", {}).get("type") == "command_execution":
                log(f"  [{elapsed(started_at)}] Bash: {str(event['item'].get('command', ''))[:120]}")
            if is_result_event(spec.harness, event):
                result = event
            # The shim journal is the source of truth (the agent may filter
            # the CLI's JSON out of its tool output). The tool_use text check
            # catches `review wait` before it blocks the stream.
            stop_reason = stop_reason_from_calls(calls_log, journal_offset)
            if stop_reason is None and published_in(calls_log, journal_offset) and re.search(r"review\s+wait\b", json.dumps(event)):
                stop_reason = "agent entered review wait after publish"
            if stop_reason:
                log(f"stopping run: {stop_reason}")
                process.terminate()
                break
            broken = shim_load_failure(calls_log)
            if broken:
                process.kill()
                raise RuntimeError(f"review shim CLI failed to load during the run: {broken}")
            if time.time() > deadline:
                process.kill()
                raise TimeoutError(
                    f"claude exceeded {spec.timeout_minutes} minutes; killed."
                )
        exit_code = process.wait()
        if stop_reason is not None and result is None:
            result = {"stopped_by_harness": stop_reason}
    ended_at = time.time()
    if session_id is None:
        raise RuntimeError(
            f"{spec.harness} produced no session id; see {stderr_path} and {stream_path}"
        )
    if result is None:
        raise RuntimeError(
            f"{spec.harness} exited ({exit_code}) without a result event; see {stderr_path}"
        )
    return {
        "session_id": session_id,
        "started_at": started_at,
        "ended_at": ended_at,
        "exit_code": exit_code,
        "result": result,
    }


def summarize_tool_use(block: dict) -> str:
    name = block.get("name", "?")
    payload = block.get("input", {})
    if name == "Bash":
        return f"Bash: {str(payload.get('command', ''))[:120]}"
    if name in ("Read", "Edit", "Write", "MultiEdit"):
        return f"{name}: {payload.get('file_path', '')}"
    if name in ("Task", "Agent"):
        return f"{name}: {payload.get('description', '')}"
    if name == "Skill":
        return f"Skill: {payload.get('skill', '')}"
    return f"{name}"


def elapsed(started_at: float) -> str:
    seconds = int(time.time() - started_at)
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def collect_transcripts(spec: RunSpec, session_id: str, run_dir: Path, log, cwd: Path) -> dict:
    dest = run_dir / "transcripts"
    dest.mkdir(exist_ok=True)
    if spec.harness == "codex":
        rollout = find_local_raw("codex", session_id)
        if rollout is None:
            raise FileNotFoundError(f"Codex rollout not found for {session_id}")
        shutil.copy2(rollout, dest / "main.jsonl")
        log("copied codex rollout")
        return {"main": str(dest / "main.jsonl"), "subagents": []}
    project_dir = claude_project_dir(cwd)
    main = project_dir / f"{session_id}.jsonl"
    if not main.exists():
        raise FileNotFoundError(f"Claude transcript not found: {main}")
    shutil.copy2(main, dest / "main.jsonl")
    subagents: list[str] = []
    subagent_dir = project_dir / session_id / "subagents"
    if subagent_dir.exists():
        (dest / "subagents").mkdir(exist_ok=True)
        for file in sorted(subagent_dir.glob("*.jsonl")):
            shutil.copy2(file, dest / "subagents" / file.name)
            subagents.append(file.name)
    log(f"copied transcript + {len(subagents)} subagent transcript(s)")
    return {"main": str(dest / "main.jsonl"), "subagents": subagents}


def collect_review(run_dir: Path, home: Path, log) -> dict | None:
    """The review the agent created, discovered from CLI trace attributes."""
    uuids: set[str] = set()
    for trace_file in (run_dir / "cli-traces").glob("*.json"):
        trace = json.loads(trace_file.read_text())
        uuid = trace.get("attributes", {}).get("reviewUuid")
        if uuid:
            uuids.add(uuid)
    if not uuids:
        log("no review uuid found in CLI traces")
        return None
    if len(uuids) > 1:
        log(f"warning: multiple review uuids in traces: {sorted(uuids)}")
    uuid = sorted(uuids)[0]
    review_dir = home / "reviews" / uuid
    if not review_dir.exists():
        log(f"review dir {review_dir} does not exist (deleted?)")
        return {"uuid": uuid, "dir": str(review_dir), "record": None, "revisions": []}
    dest = run_dir / "review"
    dest.mkdir(exist_ok=True)
    for name in ("review.json", "review.mdx", "data.ts"):
        source = review_dir / name
        if source.exists():
            shutil.copy2(source, dest / name)
    git_log = subprocess.run(
        ["git", "-C", str(review_dir), "log", "--format=%H%x00%cI%x00%s", "--reverse"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    revisions = []
    for line in git_log.splitlines():
        sha, committed_at, subject = line.split("\0")
        revisions.append({"sha": sha, "committed_at": committed_at, "subject": subject})
    record = json.loads((review_dir / "review.json").read_text())
    return {"uuid": uuid, "dir": str(review_dir), "record": record, "revisions": revisions}


def install_worktree_dependencies(worktree: Path, log) -> None:
    """A developer's checkout has its dependencies installed; a fresh fork
    worktree does not, and agents that decide to typecheck or run tests spent
    minutes on `pnpm install` plus the failures before it (review#83 runs)."""
    if not (worktree / "pnpm-lock.yaml").exists() or (worktree / "node_modules").exists():
        return
    started = time.time()
    subprocess.run(
        ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
        cwd=worktree, check=True, capture_output=True, text=True,
    )
    log(f"installed worktree dependencies in {time.time() - started:.0f}s")


def harness_version(harness: str) -> str:
    binary = "claude" if harness == "claude-code" else harness
    return subprocess.run([binary, "--version"], capture_output=True, text=True, check=True).stdout.strip()


def execute_run(spec: RunSpec, runs_dir: Path, log) -> Path:
    if spec.mode == "update":
        raise NotImplementedError(
            "update mode is not implemented yet; see README.md 'Update runs' for the design."
        )
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir = runs_dir / f"{stamp}-{spec.id}"
    run_dir.mkdir(parents=True)
    (run_dir / "cli-traces").mkdir()
    log(f"run dir {run_dir}")

    home = run_dir / "profile" / "home"
    state = STATE_ROOTS / f"{stamp}-{spec.id}" / "state"
    env = build_env(run_dir, spec, home)
    manifest: dict = {
        "run": spec.__dict__ | {"repo_path": str(spec.repo_path)},
        "profile": {"home": str(home), "state": str(state), "desktop": spec.desktop, "traces": spec.traces},
        "review_cli": str(SOURCE_CLI) if spec.review_cli == "source" else shutil.which("review"),
        "harness_version": harness_version(spec.harness),
        "surface": surface_fingerprint(str(run_dir / "bin" / "review") if spec.review_cli == "source" else "review"),
    }
    cwd = spec.repo_path
    resume: str | None = None
    model_override: str | None = None
    if spec.mode == "fork":
        assert spec.session is not None
        raw = resolve_raw_session(spec.harness, spec.session, runs_dir / "raw-sessions")
        records = read_jsonl(raw.path)
        cut = find_cut_point(spec.harness, records)
        cut_index = spec.cut if spec.cut is not None else cut.index
        worktree = runs_dir / "worktrees" / spec.id
        cut_ms = cut_timestamp_ms(spec.harness, records, cut_index)
        if spec.worktree_commit:
            head, head_rule = spec.worktree_commit, "configured worktree override"
        else:
            head, head_rule = representative_commit(spec.repo_path, spec.session, cut_ms, spec.pr)
        prepare_worktree(spec.repo_path, head, worktree, f"review-latency/{spec.id}")
        install_worktree_dependencies(worktree, log)
        resume = fork_session(spec.harness, records, cut_index, worktree)
        cwd = worktree
        if spec.harness == "codex" and spec.model == "default":
            session_model = codex_session_model(records[:cut_index])
            if session_model:
                model_override = session_model
                log(f"resuming on the session's model {session_model}")
        shutil.copy2(raw.path, run_dir / "source-session.jsonl")
        manifest["fork"] = {
            "source_session": spec.session,
            "source_path": str(raw.path),
            "source_origin": raw.source,
            "records": len(records),
            "cut_index": cut_index,
            "cut_reason": cut.reason if spec.cut is None else f"configured cut={spec.cut}",
            "forked_session": resume,
            "model": model_override or spec.model,
            "worktree": str(worktree),
            "head_commit": head,
            "head_rule": head_rule,
            "cut_at": datetime.fromtimestamp(cut_ms / 1000, UTC).isoformat(),
        }
        log(f"forked {spec.harness} session {spec.session[:8]} -> {resume[:8]} at record {cut_index}/{len(records)} ({manifest['fork']['cut_reason']})")
        log(f"worktree {worktree} @ {head[:12]} ({head_rule})")
    desktop = launch_desktop(home, state, spec.desktop, log)
    try:
        agent = run_agent(spec, run_dir, env, log, cwd, resume, model_override)
    finally:
        (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        shutdown_desktop(desktop, log)
    manifest["claude"] = agent  # key kept for older run dirs
    manifest["transcripts"] = collect_transcripts(spec, agent["session_id"], run_dir, log, cwd)
    manifest["review"] = collect_review(run_dir, home, log)
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return run_dir
