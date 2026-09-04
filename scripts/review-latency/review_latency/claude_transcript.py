"""Turn a Claude Code JSONL transcript into timed spans.

Each transcript record carries an ISO `timestamp` written when the record
landed. An assistant record with content blocks ends a model generation; a
user record carrying `tool_result` blocks ends the tool call it references.
So:

  model span  = previous record ts -> assistant record ts
  tool span   = assistant record ts (tool_use) -> user record ts (tool_result)
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass
class Span:
    id: str
    lane: str
    category: str  # model | tool | cli | phase | subagent
    name: str
    start_ms: float
    end_ms: float
    parent: str | None = None
    depth: int = 0
    attrs: dict = field(default_factory=dict)

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms


def parse_ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def load_records(path: Path) -> list[dict]:
    records = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("type") in ("user", "assistant") and record.get("timestamp"):
                records.append(record)
    records.sort(key=lambda record: parse_ts(record["timestamp"]))
    return records


def tool_title(block: dict) -> str:
    name = block.get("name", "tool")
    payload = block.get("input") or {}
    if name == "Bash":
        return f"Bash: {str(payload.get('command', '')).strip()[:160]}"
    if name in ("Read", "Edit", "Write", "MultiEdit"):
        return f"{name}: {payload.get('file_path', '')}"
    if name in ("Task", "Agent"):
        return f"{name}: {payload.get('description', '')}"
    if name == "Skill":
        return f"Skill: {payload.get('skill', '')}"
    if name in ("Grep", "Glob"):
        return f"{name}: {payload.get('pattern', '')}"
    if name.startswith("mcp__"):
        return name
    return name


def result_text(block: dict) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return ""


def transcript_spans(path: Path, lane: str, span_prefix: str) -> list[Span]:
    records = load_records(path)
    spans: list[Span] = []
    pending_tools: dict[str, Span] = {}
    previous_ts: float | None = None
    seen_message_ids: set[str] = set()
    for index, record in enumerate(records):
        ts = parse_ts(record["timestamp"])
        message = record.get("message") or {}
        content = message.get("content")
        if record["type"] == "assistant":
            if previous_ts is not None and ts > previous_ts:
                usage = message.get("usage") or {}
                message_id = message.get("id")
                first_for_message = message_id not in seen_message_ids
                if message_id:
                    seen_message_ids.add(message_id)
                kinds = [block.get("type") for block in content] if isinstance(content, list) else []
                spans.append(
                    Span(
                        id=f"{span_prefix}model-{index}",
                        lane=lane,
                        category="model",
                        name="model: " + ("+".join(dict.fromkeys(kinds)) or "text"),
                        start_ms=previous_ts,
                        end_ms=ts,
                        attrs={
                            "model": message.get("model"),
                            "output_tokens": usage.get("output_tokens"),
                            "thinking_tokens": (usage.get("output_tokens_details") or {}).get(
                                "thinking_tokens"
                            ),
                            "input_tokens": usage.get("input_tokens"),
                            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                            "cache_creation_input_tokens": usage.get(
                                "cache_creation_input_tokens"
                            ),
                            "first_for_message": first_for_message,
                        },
                    )
                )
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_use":
                        span = Span(
                            id=f"{span_prefix}tool-{block['id']}",
                            lane=lane,
                            category="tool",
                            name=tool_title(block),
                            start_ms=ts,
                            end_ms=ts,
                            attrs={
                                "tool": block.get("name"),
                                "input": block.get("input"),
                                "tool_use_id": block["id"],
                            },
                        )
                        pending_tools[block["id"]] = span
                        spans.append(span)
        elif record["type"] == "user" and isinstance(content, list):
            for block in content:
                if block.get("type") == "tool_result":
                    span = pending_tools.pop(block.get("tool_use_id"), None)
                    if span is None:
                        continue
                    span.end_ms = ts
                    span.attrs["is_error"] = bool(block.get("is_error"))
                    span.attrs["output"] = result_text(block)[:4000]
        previous_ts = ts
    last_ts = parse_ts(records[-1]["timestamp"]) if records else 0.0
    for span in pending_tools.values():
        span.end_ms = last_ts
        span.attrs["unterminated"] = True
    return spans


def transcript_bounds(path: Path) -> tuple[float, float]:
    records = load_records(path)
    if not records:
        raise ValueError(f"transcript {path} has no timestamped records")
    return parse_ts(records[0]["timestamp"]), parse_ts(records[-1]["timestamp"])


def first_user_prompt_ts(path: Path) -> float:
    for record in load_records(path):
        if record["type"] == "user":
            content = (record.get("message") or {}).get("content")
            has_tool_result = isinstance(content, list) and any(
                block.get("type") == "tool_result" for block in content
            )
            if not has_tool_result:
                return parse_ts(record["timestamp"])
    raise ValueError(f"transcript {path} has no user prompt")
