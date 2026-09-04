"""Load `review` CLI span files (DEV_FAST_REVIEW_TRACE_DIR output) as spans.

Each file is one CLI process: `timeOrigin` is the epoch-ms process start, and
every span's `start`/`end` is milliseconds after it.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from review_latency.claude_transcript import Span


@dataclass
class CliTrace:
    path: Path
    argv: list[str]
    command: str  # e.g. "scaffold --pr 27 --json"
    time_origin_ms: float
    duration_ms: float
    attributes: dict
    delegated: bool
    spans: list[Span]

    @property
    def end_ms(self) -> float:
        return self.time_origin_ms + self.duration_ms


def load_cli_traces(trace_dir: Path) -> list[CliTrace]:
    traces: list[CliTrace] = []
    for path in sorted(trace_dir.glob("*.json")):
        raw = json.loads(path.read_text())
        origin = float(raw["timeOrigin"])
        argv = raw["argv"]
        command = " ".join(argv[2:])  # drop node + cli entry
        prefix = f"cli-{path.stem}-"
        by_id: dict[int, Span] = {}
        spans: list[Span] = []
        for record in raw["spans"]:
            span = Span(
                id=f"{prefix}{record['id']}",
                lane="review cli",
                category="cli",
                name=record["name"],
                start_ms=origin + record["start"],
                end_ms=origin + record["end"],
                parent=f"{prefix}{record['parentId']}" if record["parentId"] else None,
                attrs={
                    "detail": record.get("detail"),
                    "ok": record.get("ok", True),
                    "open_at_exit": record.get("openAtExit", False),
                    "command": command,
                },
            )
            by_id[record["id"]] = span
            spans.append(span)
        for record in raw["spans"]:
            span = by_id[record["id"]]
            depth = 0
            parent_id = record["parentId"]
            while parent_id:
                depth += 1
                parent_id = next(
                    r["parentId"] for r in raw["spans"] if r["id"] == parent_id
                )
            span.depth = depth
        traces.append(
            CliTrace(
                path=path,
                argv=argv,
                command=command,
                time_origin_ms=origin,
                duration_ms=float(raw["durationMs"]),
                attributes=raw.get("attributes", {}),
                delegated=bool(raw.get("delegated")),
                spans=spans,
            )
        )
    return traces
