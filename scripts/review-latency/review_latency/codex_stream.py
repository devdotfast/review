"""Codex timeline: tool spans from receipt-stamped `codex exec --json` items,
model timing from the rollout's post-launch rows.

`codex exec --json` emits command_execution / file_change items with the
command and aggregated output (start and completion, harness-stamped) and
agent_message items (completion only). It emits no reasoning items and no
first-byte event, so:

  request_start = turn.started, or the previous tool item's completion
  thinking      = request_start -> the rollout `reasoning` row's timestamp
  generation    = thinking end -> next tool item started / message completed
  TTFT          = not observable for Codex (folded into thinking)

Token counts come from rollout `token_count` events (cumulative; deltas are
taken per turn).
"""

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from review_latency.claude_stream import StreamBlock, StreamRequest
from review_latency.claude_transcript import Span

TOOL_ITEMS = {"command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"}
SHELL_WRAPPER = re.compile(r"""^/bin/(?:zsh|bash|sh)\s+-lc\s+(['"])(.*)\1$""", re.S)


def unwrap_shell(command: str) -> str:
    match = SHELL_WRAPPER.match(command.strip())
    return match.group(2) if match else command


def parse_ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


@dataclass
class RolloutSignals:
    reasoning_ms: list[float]
    token_counts: list[tuple[float, dict]]  # (ts, total_token_usage)
    model: str | None


def rollout_signals(path: Path, since_ms: float) -> RolloutSignals:
    reasoning: list[float] = []
    counts: list[tuple[float, dict]] = []
    model: str | None = None
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("type") == "turn_context":
                model = (record.get("payload") or {}).get("model") or model
            if not record.get("timestamp"):
                continue
            ts = parse_ts(record["timestamp"])
            if ts < since_ms:
                continue
            payload = record.get("payload") or {}
            if record.get("type") == "response_item" and payload.get("type") == "reasoning":
                reasoning.append(ts)
            elif record.get("type") == "event_msg" and payload.get("type") == "token_count":
                total = ((payload.get("info") or {}).get("total_token_usage")) or {}
                counts.append((ts, total))
    return RolloutSignals(reasoning, counts, model)


def load_stream(path: Path) -> list[tuple[float, dict]]:
    rows = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if line:
                record = json.loads(line)
                rows.append((float(record["t"]), record["e"]))
    return rows


def codex_timeline(
    stream_path: Path, rollout_path: Path, launched_ms: float, lane: str, span_prefix: str
) -> tuple[list[Span], list[StreamRequest]]:
    rows = load_stream(stream_path)
    signals = rollout_signals(rollout_path, launched_ms)
    tool_spans: list[Span] = []
    requests: list[StreamRequest] = []
    open_tools: dict[str, Span] = {}
    request_start: float | None = None
    trigger = "session start"
    last_tool_name = ""
    last_counts: dict = {}

    def close_request(first_output_ms: float, message_id: str) -> None:
        nonlocal request_start
        if request_start is None:
            return
        request = StreamRequest(
            message_id=message_id,
            request_start_ms=request_start,
            first_byte_ms=request_start,  # TTFT is not observable for Codex
            end_ms=first_output_ms,
            trigger=trigger,
        )
        thinking_end = [t for t in signals.reasoning_ms if request_start < t <= first_output_ms + 50]
        cursor = request_start
        if thinking_end:
            cursor = max(thinking_end)
            request.blocks.append(StreamBlock("thinking", request_start, cursor))
        request.blocks.append(StreamBlock("text", cursor, first_output_ms))
        requests.append(request)
        request_start = None

    for t, event in rows:
        kind = event.get("type")
        item = event.get("item") or {}
        item_type = item.get("type")
        if kind == "turn.started":
            request_start = t
            trigger = "user prompt"
        elif kind == "item.started" and item_type in TOOL_ITEMS:
            close_request(t, item.get("id", ""))
            command = unwrap_shell(str(item.get("command", "")))
            name = f"Bash: {command.strip()[:160]}" if item_type == "command_execution" else item_type
            span = Span(
                id=f"{span_prefix}tool-{item.get('id', len(tool_spans))}",
                lane=lane,
                category="tool",
                name=name,
                start_ms=t,
                end_ms=t,
                attrs={
                    "tool": "Bash" if item_type == "command_execution" else item_type,
                    "input": {"command": command} if item_type == "command_execution" else item,
                    "tool_use_id": item.get("id"),
                },
            )
            open_tools[item.get("id", "")] = span
            tool_spans.append(span)
            last_tool_name = item_type
        elif kind == "item.completed" and item_type in TOOL_ITEMS:
            span = open_tools.pop(item.get("id", ""), None)
            if span is None:
                # Completed without a started event: synthesize from completion.
                span = Span(
                    id=f"{span_prefix}tool-{item.get('id', len(tool_spans))}",
                    lane=lane,
                    category="tool",
                    name=f"{item_type}",
                    start_ms=t,
                    end_ms=t,
                    attrs={"tool": item_type, "input": item},
                )
                tool_spans.append(span)
            span.end_ms = t
            span.attrs["output"] = str(item.get("aggregated_output", ""))[:4000]
            exit_code = item.get("exit_code")
            span.attrs["is_error"] = exit_code not in (None, 0)
            request_start = t
            trigger = f"tool_result <- {last_tool_name}"
        elif kind == "item.completed" and item_type == "agent_message":
            close_request(t, item.get("id", ""))
            request_start = t
            trigger = "assistant message"
        elif kind == "turn.completed":
            request_start = None

    # Token deltas per request from the rollout's cumulative counters.
    for request in requests:
        before = last_counts
        after = None
        for ts, total in signals.token_counts:
            if ts <= request.request_start_ms:
                before = total
            elif ts <= request.end_ms + 2000 and after is None:
                after = total
        if after is not None:
            request.output_tokens = max(0, (after.get("output_tokens") or 0) - (before.get("output_tokens") or 0))
            request.thinking_tokens = max(
                0, (after.get("reasoning_output_tokens") or 0) - (before.get("reasoning_output_tokens") or 0)
            )
            request.cache_read_input_tokens = max(
                0, (after.get("cached_input_tokens") or 0) - (before.get("cached_input_tokens") or 0)
            )
            last_counts = after
    return tool_spans, requests


def codex_result_summary(stream_path: Path) -> dict:
    for _t, event in load_stream(stream_path):
        if event.get("type") == "turn.completed":
            usage = event.get("usage") or {}
            return {
                "output_tokens": usage.get("output_tokens"),
                "reasoning_output_tokens": usage.get("reasoning_output_tokens"),
                "cached_input_tokens": usage.get("cached_input_tokens"),
            }
    return {}
