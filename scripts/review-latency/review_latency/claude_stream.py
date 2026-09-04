"""Per-request model timing from Claude Code's `--include-partial-messages` stream.

The runner writes each stdout line as `{"t": <epoch ms on receipt>, "e": <event>}`.
Receipt time is the only clock: Claude Code does not stamp stream events.

For each API request (one `message_start` .. `message_stop`):

  request_start = receipt of the last non-stream event before message_start
                  (the tool_result `user` event or `system status`), i.e. the
                  moment Claude Code had everything it needed to call the API
  ttft          = message_start - request_start
  blocks        = thinking / text / tool_use, each content_block_start -> stop
  usage         = message_delta.usage (output + thinking tokens)
"""

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class StreamBlock:
    kind: str  # thinking | text | tool_use
    start_ms: float
    end_ms: float
    tool_name: str | None = None


@dataclass
class StreamRequest:
    message_id: str
    request_start_ms: float
    first_byte_ms: float
    end_ms: float
    blocks: list[StreamBlock] = field(default_factory=list)
    output_tokens: int = 0
    thinking_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    trigger: str = ""  # what the model was responding to

    @property
    def ttft_ms(self) -> float:
        return self.first_byte_ms - self.request_start_ms

    def block_ms(self, kind: str) -> float:
        return sum(b.end_ms - b.start_ms for b in self.blocks if b.kind == kind)


def load_stream(path: Path) -> list[tuple[float, dict]]:
    rows: list[tuple[float, dict]] = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            rows.append((float(record["t"]), record["e"]))
    return rows


def describe_trigger(event: dict) -> str:
    kind = event.get("type")
    if kind == "user":
        content = (event.get("message") or {}).get("content")
        if isinstance(content, list):
            results = [b for b in content if b.get("type") == "tool_result"]
            if results:
                return f"tool_result x{len(results)}" + (" (error)" if any(b.get("is_error") for b in results) else "")
            texts = [b.get("text", "") for b in content if b.get("type") == "text"]
            if texts:
                return "user prompt: " + texts[0][:80]
        if isinstance(content, str):
            return "user prompt: " + content[:80]
        return "user"
    if kind == "system":
        return f"system {event.get('subtype', '')}"
    return kind or "?"


def parse_stream_requests(path: Path) -> list[StreamRequest]:
    rows = load_stream(path)
    requests: list[StreamRequest] = []
    current: StreamRequest | None = None
    open_block: StreamBlock | None = None
    last_non_stream_ms: float | None = None
    last_non_stream_event: dict | None = None
    last_tool_names: list[str] = []
    for t, event in rows:
        if event.get("type") != "stream_event":
            # Top-level assistant/user/system/result events. A completed
            # assistant event is not a trigger; the tool_result user event is.
            if event.get("type") in ("user", "system") and event.get("subtype") != "hook_response":
                last_non_stream_ms = t
                last_non_stream_event = event
            if event.get("type") == "assistant":
                content = (event.get("message") or {}).get("content") or []
                last_tool_names = [b.get("name", "") for b in content if b.get("type") == "tool_use"]
            continue
        inner = event["event"]
        kind = inner.get("type")
        if kind == "message_start":
            message = inner["message"]
            usage = message.get("usage") or {}
            current = StreamRequest(
                message_id=message.get("id", ""),
                request_start_ms=last_non_stream_ms if last_non_stream_ms is not None else t,
                first_byte_ms=t,
                end_ms=t,
                cache_read_input_tokens=usage.get("cache_read_input_tokens") or 0,
                cache_creation_input_tokens=usage.get("cache_creation_input_tokens") or 0,
                trigger=describe_trigger(last_non_stream_event) if last_non_stream_event else "session start",
            )
            if last_non_stream_event and last_non_stream_event.get("type") == "user" and last_tool_names:
                current.trigger = f"{current.trigger} <- {', '.join(last_tool_names)}"
            requests.append(current)
        elif current is None:
            continue
        elif kind == "content_block_start":
            block = inner["content_block"]
            open_block = StreamBlock(kind=block.get("type", "?"), start_ms=t, end_ms=t, tool_name=block.get("name"))
            current.blocks.append(open_block)
        elif kind == "content_block_delta" and open_block is not None:
            open_block.end_ms = t
        elif kind == "content_block_stop" and open_block is not None:
            open_block.end_ms = t
            open_block = None
        elif kind == "message_delta":
            usage = inner.get("usage") or {}
            current.output_tokens = usage.get("output_tokens") or 0
            current.thinking_tokens = (usage.get("output_tokens_details") or {}).get("thinking_tokens") or 0
            current.end_ms = t
        elif kind == "message_stop":
            current.end_ms = t
            current = None
            open_block = None
    return requests
