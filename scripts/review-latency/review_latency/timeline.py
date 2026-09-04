"""Assemble one run's timeline: agent spans + CLI spans + derived phases."""

import json
import re
import subprocess
from dataclasses import asdict
from pathlib import Path

from review_latency.claude_transcript import (
    Span,
    first_user_prompt_ts,
    transcript_bounds,
    transcript_spans,
)
from review_latency.claude_stream import StreamRequest, parse_stream_requests
from review_latency.cli_traces import CliTrace, load_cli_traces
from review_latency.codex_stream import codex_result_summary, codex_timeline

REVIEW_COMMAND = re.compile(r"""(?:^|[\s;&|("'])review\s+(\S+)(?:\s+(\S+))?""")
AUTHORED_FILES = ("review.mdx", "data.ts")


def review_verbs(command: str) -> list[str]:
    """Every review verb in a shell command: a call chaining `review info` and
    `review scaffold` yields both. `present` is the publish alias."""
    if "--help" in command or " help " in f" {command} ":
        return []
    verbs: list[str] = []
    for match in REVIEW_COMMAND.finditer(command):
        verb, sub = match.group(1), match.group(2)
        if verb == "present":
            verb = "publish"
        if verb in ("map", "app", "threads", "trace") and sub and not sub.startswith("-"):
            verb = f"{verb} {sub}"
        if verb not in verbs:
            verbs.append(verb)
    return verbs


def writes_authored_file(span: Span) -> bool:
    """Write/Edit of review.mdx or data.ts (Claude tools, Codex file_change items, or shell patches)."""
    tool = span.attrs.get("tool")
    payload = span.attrs.get("input") or {}
    if tool in ("Write", "Edit", "MultiEdit"):
        return str(payload.get("file_path", "")).endswith(AUTHORED_FILES)
    if tool == "file_change":
        return any(str(c.get("path", "")).endswith(AUTHORED_FILES) for c in payload.get("changes") or [])
    if tool == "Bash":
        command = str(payload.get("command", ""))
        return ("apply_patch" in command or "Begin Patch" in command or "cat >" in command) and any(
            name in command for name in AUTHORED_FILES
        )
    return False


def review_tool_calls(spans: list[Span]) -> list[tuple[Span, str]]:
    calls = []
    for span in spans:
        if span.category != "tool" or span.attrs.get("tool") != "Bash":
            continue
        for verb in review_verbs(str(span.attrs.get("input", {}).get("command", ""))):
            calls.append((span, verb))
    return calls


def attach_cli_traces(tool_calls: list[tuple[Span, str]], traces: list[CliTrace]) -> None:
    """Parent each CLI trace under the Bash call whose window contains it."""
    for trace in traces:
        owner = None
        for span, _verb in tool_calls:
            if span.start_ms - 1500 <= trace.time_origin_ms <= span.end_ms + 1500:
                owner = span
                break
        for span in trace.spans:
            if span.parent is None:
                span.parent = owner.id if owner else None
                span.attrs["orphan"] = owner is None
        trace.attributes["owner_tool_use"] = owner.id if owner else None


def derive_phases(
    prompt_ms: float,
    end_ms: float,
    main_spans: list[Span],
    tool_calls: list[tuple[Span, str]],
    pick_process_windows: list[tuple[float, float]] = (),
) -> tuple[list[Span], dict]:
    """Phase boundaries on the main agent's timeline.

    skill+setup : prompt -> scaffold call starts
    scaffold    : the scaffold call
    exploration : scaffold end -> first write to review.mdx / data.ts
    authoring   : first write -> first publish call
    publish loop: first publish call -> last successful publish end
    show        : publish end -> `review app pick` end (document visible)
    """
    scaffold = next((s for s, v in tool_calls if v == "scaffold"), None)
    publishes = [s for s, v in tool_calls if v == "publish"]
    successful_publish = next(
        (
            s
            for s in publishes
            if '"event":"published"' in str(s.attrs.get("output", ""))
            and not s.attrs.get("is_error")
        ),
        None,
    )
    picks = [
        s
        for s, v in tool_calls
        if v == "app pick" and (successful_publish is None or s.start_ms >= successful_publish.start_ms)
    ]
    visible = picks[0] if picks else successful_publish
    # The pick is often chained with other commands in one Bash call; end the
    # phase at the pick CLI process itself, not the whole tool call.
    visible_end = visible.end_ms if visible else None
    if visible is not None:
        for start, end in pick_process_windows:
            if visible.start_ms - 1500 <= start <= visible.end_ms + 1500:
                visible_end = end
                break
    first_write = next((s for s in main_spans if s.category == "tool" and writes_authored_file(s)), None)
    marks = [
        ("skill+setup", prompt_ms),
        ("scaffold", scaffold.start_ms if scaffold else None),
        ("exploration", scaffold.end_ms if scaffold else None),
        ("authoring", first_write.start_ms if first_write else None),
        ("publish loop", publishes[0].start_ms if publishes else None),
        ("show", successful_publish.end_ms if successful_publish else None),
        ("done", visible_end),
    ]
    phases: list[Span] = []
    for index, (name, start) in enumerate(marks[:-1]):
        if start is None:
            continue
        next_start = next((m[1] for m in marks[index + 1 :] if m[1] is not None), end_ms)
        if next_start < start:
            next_start = start
        phases.append(
            Span(
                id=f"phase-{name}",
                lane="phases",
                category="phase",
                name=name,
                start_ms=start,
                end_ms=next_start,
            )
        )
    summary = {
        "prompt_ms": prompt_ms,
        "visible_ms": visible_end,
        "time_to_visible_s": (visible_end - prompt_ms) / 1000 if visible_end is not None else None,
        "session_end_ms": end_ms,
        "publish_attempts": len(publishes),
        "publish_succeeded": successful_publish is not None,
        "map_worker_joined_before_publish": None,
    }
    return phases, summary


def publish_attempt_rows(tool_calls: list[tuple[Span, str]]) -> list[dict]:
    rows = []
    for span, verb in tool_calls:
        if verb != "publish":
            continue
        output = str(span.attrs.get("output", ""))
        errors = []
        for line in output.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            event = json.loads(line)
            if event.get("event") == "error":
                if "diagnostics" in event:
                    errors.extend(event["diagnostics"])
                elif "message" in event:
                    errors.append(f"{event.get('file', '')}:{event.get('line', '')} {event['message']}")
                elif "error" in event:
                    errors.append(event["error"].get("message", json.dumps(event["error"])))
        rows.append(
            {
                "start_ms": span.start_ms,
                "duration_ms": span.duration_ms,
                "ok": '"event":"published"' in output and not span.attrs.get("is_error"),
                "errors": errors,
            }
        )
    return rows


def map_worker_check(
    tool_calls: list[tuple[Span, str]], main_spans: list[Span], summary: dict
) -> None:
    """Flag a run where the main agent waited on the map worker before publishing."""
    successful_publish_start = next(
        (
            s.start_ms
            for s, v in tool_calls
            if v == "publish" and '"event":"published"' in str(s.attrs.get("output", ""))
        ),
        None,
    )
    workers = [
        s
        for s in main_spans
        if s.category == "tool" and s.attrs.get("tool") in ("Task", "Agent")
    ]
    if successful_publish_start is None or not workers:
        summary["map_worker_joined_before_publish"] = None
        return
    # A synchronous Task call whose window ends before publish started means
    # the main agent blocked on it.
    summary["map_worker_joined_before_publish"] = any(
        w.end_ms <= successful_publish_start and w.duration_ms > 30_000 for w in workers
    )


def stream_model_spans(requests: list[StreamRequest]) -> list[Span]:
    """One `model` span per API request with ttft/thinking/generation children."""
    spans: list[Span] = []
    for index, request in enumerate(requests):
        parent_id = f"stream-{index}"
        kinds = "+".join(dict.fromkeys(b.kind for b in request.blocks)) or "empty"
        spans.append(
            Span(
                id=parent_id,
                lane="agent",
                category="model",
                name=f"model: {kinds}",
                start_ms=request.request_start_ms,
                end_ms=request.end_ms,
                attrs={
                    "message_id": request.message_id,
                    "trigger": request.trigger,
                    "ttft_ms": request.ttft_ms,
                    "thinking_ms": request.block_ms("thinking"),
                    "generation_ms": request.block_ms("text") + request.block_ms("tool_use"),
                    "output_tokens": request.output_tokens,
                    "thinking_tokens": request.thinking_tokens,
                    "cache_read_input_tokens": request.cache_read_input_tokens,
                    "cache_creation_input_tokens": request.cache_creation_input_tokens,
                    "tools": [b.tool_name for b in request.blocks if b.kind == "tool_use"],
                },
            )
        )
        spans.append(
            Span(
                id=f"{parent_id}-ttft",
                lane="agent",
                category="model-ttft",
                name="ttft",
                start_ms=request.request_start_ms,
                end_ms=request.first_byte_ms,
                parent=parent_id,
                depth=1,
            )
        )
        for b_index, block in enumerate(request.blocks):
            spans.append(
                Span(
                    id=f"{parent_id}-b{b_index}",
                    lane="agent",
                    category="model-thinking" if block.kind == "thinking" else "model-generation",
                    name=block.kind if block.kind != "tool_use" else f"tool_use {block.tool_name}",
                    start_ms=block.start_ms,
                    end_ms=block.end_ms,
                    parent=parent_id,
                    depth=1,
                )
            )
    return spans


def stream_is_receipt_stamped(path: Path) -> bool:
    with path.open() as handle:
        first = handle.readline()
    return first.startswith('{"t":')


def realism_check(manifest: dict) -> dict | None:
    """Did the agent review the commit its checkout was at (or one in its history)?"""
    fork = manifest.get("fork")
    review = manifest.get("review") or {}
    record = review.get("record") or {}
    reviewed = record.get("sourceCommit")
    if not fork or not reviewed:
        return None
    repo = Path(manifest["run"]["repo_path"])
    head = fork["head_commit"]
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", reviewed, head], cwd=repo, capture_output=True
    ).returncode == 0
    return {
        "worktree_head": head,
        "worktree_head_rule": fork.get("head_rule"),
        "reviewed_commit": reviewed,
        "reviewed_is_worktree_head": reviewed == head,
        "reviewed_in_worktree_history": ancestor,
        # A mid-implementation fork reviewing the finished PR sees a
        # descendant of its checkout; that is coherent, not a setup error.
        "worktree_in_reviewed_history": subprocess.run(
            ["git", "merge-base", "--is-ancestor", head, reviewed],
            cwd=repo,
            capture_output=True,
        ).returncode
        == 0,
    }


def document_shape(run_dir: Path) -> dict | None:
    """What the run produced, so speed can be read per unit of output: a skill
    version that is faster because it wrote a thinner review shows up here."""
    review_dir = run_dir / "review"
    data = review_dir / "data.ts"
    mdx = review_dir / "review.mdx"
    if not data.exists() or not mdx.exists():
        return None
    data_text = data.read_text()
    mdx_text = mdx.read_text()
    return {
        "bytes": data.stat().st_size + mdx.stat().st_size,
        "anchors": len(re.findall(r"\bpeek:\s*\{", data_text)),
        "diagrams": len(re.findall(r"<(SequenceDiagram|CallStackDiff|DatabaseLens)\b", mdx_text)),
        "anchor_links": len(re.findall(r"<AnchorLink\b", mdx_text)),
        "code_peeks": len(re.findall(r"<CodePeek\b", mdx_text)),
        "trace_quotes": len(re.findall(r"<TraceQuote\b", mdx_text)),
        "sections": len(re.findall(r"(?m)^## ", mdx_text)),
    }


def build_timeline(run_dir: Path) -> dict:
    manifest = json.loads((run_dir / "manifest.json").read_text())
    run = manifest["run"]
    harness = run.get("harness", "claude-code")
    mode = run.get("mode", "create")
    main_path = run_dir / "transcripts" / "main.jsonl"
    stream_path = run_dir / "claude-stream.jsonl"
    launched_ms = float(manifest["claude"]["started_at"]) * 1000
    ended_ms = float(manifest["claude"]["ended_at"]) * 1000
    stream_requests: list[StreamRequest] = []
    if harness == "codex":
        # Tool spans from the receipt-stamped stream; thinking/token signals
        # from rollout rows appended after launch (the forked prefix is
        # re-stamped at resume time and must be ignored).
        main_spans, stream_requests = codex_timeline(
            stream_path, main_path, launched_ms, lane="agent", span_prefix="main-"
        )
        main_spans += stream_model_spans(stream_requests)
        prompt_ms = launched_ms
        end_ms = max([ended_ms] + [s.end_ms for s in main_spans])
    else:
        main_spans = transcript_spans(main_path, lane="agent", span_prefix="main-")
        if stream_path.exists() and stream_is_receipt_stamped(stream_path):
            stream_requests = parse_stream_requests(stream_path)
            # The stream times every request from the harness's clock; drop the
            # coarser transcript-derived model spans for the main agent.
            main_spans = [s for s in main_spans if s.category != "model"] + stream_model_spans(
                stream_requests
            )
        if mode == "fork":
            # The forked prefix is history; the run starts at the appended prompt.
            main_spans = [s for s in main_spans if s.end_ms >= launched_ms - 1000]
            prompt_ms = launched_ms
        else:
            prompt_ms = first_user_prompt_ts(main_path)
        _start, end_ms = transcript_bounds(main_path)
        end_ms = max(end_ms, ended_ms)

    subagent_spans: list[Span] = []
    subagent_dir = run_dir / "transcripts" / "subagents"
    if subagent_dir.exists():
        for index, path in enumerate(sorted(subagent_dir.glob("*.jsonl"))):
            lane = f"subagent {index + 1} ({path.stem})"
            spans = transcript_spans(path, lane=lane, span_prefix=f"{path.stem}-")
            subagent_spans.extend(spans)

    all_agent_spans = main_spans + subagent_spans
    tool_calls = review_tool_calls(all_agent_spans)
    traces = load_cli_traces(run_dir / "cli-traces")
    attach_cli_traces(tool_calls, traces)
    cli_spans = [span for trace in traces for span in trace.spans]

    pick_windows = [
        (trace.time_origin_ms, trace.end_ms)
        for trace in traces
        if trace.command.startswith("app pick")
    ]
    phases, summary = derive_phases(prompt_ms, end_ms, main_spans, tool_calls, pick_windows)
    map_worker_check(tool_calls, main_spans, summary)

    spans = phases + all_agent_spans + cli_spans
    lanes = ["phases", "agent"] + sorted({s.lane for s in subagent_spans}) + ["review cli"]

    model_ms = sum(s.duration_ms for s in main_spans if s.category == "model")
    turns = [
        {
            "start_ms": r.request_start_ms,
            "trigger": r.trigger,
            "ttft_ms": r.ttft_ms,
            "thinking_ms": r.block_ms("thinking"),
            "generation_ms": r.block_ms("text") + r.block_ms("tool_use"),
            "total_ms": r.end_ms - r.request_start_ms,
            "output_tokens": r.output_tokens,
            "thinking_tokens": r.thinking_tokens,
            "cache_read_input_tokens": r.cache_read_input_tokens,
            "cache_creation_input_tokens": r.cache_creation_input_tokens,
            "tools": [b.tool_name for b in r.blocks if b.kind == "tool_use"],
        }
        for r in stream_requests
    ]
    tool_ms = sum(s.duration_ms for s in main_spans if s.category == "tool")
    review_cli_ms = sum(t.duration_ms for t in traces if not t.delegated)
    summary.update(
        {
            "main_model_s": model_ms / 1000,
            "main_ttft_s": sum(t["ttft_ms"] for t in turns) / 1000,
            "main_thinking_s": sum(t["thinking_ms"] for t in turns) / 1000,
            "main_generation_s": sum(t["generation_ms"] for t in turns) / 1000,
            "thinking_tokens": sum(t["thinking_tokens"] for t in turns),
            "turns": turns,
            "main_tool_s": tool_ms / 1000,
            "review_cli_process_s": review_cli_ms / 1000,
            "review_commands": [
                {
                    "command": t.command,
                    "duration_s": t.duration_ms / 1000,
                    "attributes": t.attributes,
                }
                for t in traces
                if not t.delegated
            ],
            "publish_attempts_detail": publish_attempt_rows(tool_calls),
            "output_tokens": sum(
                s.attrs.get("output_tokens") or 0 for s in main_spans if s.category == "model"
            ),
            "claude_result": (
                codex_result_summary(stream_path)
                if harness == "codex"
                else {
                    key: manifest.get("claude", {}).get("result", {}).get(key)
                    for key in ("duration_ms", "duration_api_ms", "num_turns", "total_cost_usd", "is_error")
                }
            ),
        }
    )
    summary["realism"] = realism_check(manifest)
    summary["document"] = document_shape(run_dir)
    return {
        "run": manifest["run"],
        "fork": manifest.get("fork"),
        "surface": manifest.get("surface"),
        "review": manifest.get("review"),
        "t0_ms": prompt_ms,
        "t_end_ms": max([end_ms] + [s.end_ms for s in spans]),
        "lanes": lanes,
        "summary": summary,
        "spans": [asdict(s) for s in spans],
    }


def write_timeline(run_dir: Path) -> dict:
    timeline = build_timeline(run_dir)
    (run_dir / "timeline.json").write_text(json.dumps(timeline, indent=1))
    return timeline
