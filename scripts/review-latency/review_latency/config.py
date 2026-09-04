import tomllib
from dataclasses import dataclass
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = HARNESS_DIR.parent.parent
DEFAULT_CONFIG = HARNESS_DIR / "runs.toml"
SOURCE_CLI = REPO_ROOT / "packages" / "progressive-review" / "src" / "cli.ts"


@dataclass(frozen=True)
class RunSpec:
    id: str
    repo_name: str
    repo_path: Path
    pr: int
    mode: str
    harness: str
    session: str | None
    cut: int | None
    worktree_commit: str | None
    model: str
    effort: str
    prompt: str
    review_cli: str
    desktop: str  # packaged | dev
    traces: bool  # trace storage available to the agent
    max_turns: int
    timeout_minutes: int


def with_traces(spec: RunSpec, traces: bool) -> RunSpec:
    """The same run with trace storage present or absent; ids carry -notrace."""
    base_id = spec.id.removesuffix("-notrace")
    return RunSpec(**{**spec.__dict__, "id": base_id if traces else f"{base_id}-notrace", "traces": traces})


@dataclass(frozen=True)
class HarnessConfig:
    runs_dir: Path
    runs: list[RunSpec]

    def select(self, ids: list[str], all_runs: bool) -> list[RunSpec]:
        if all_runs:
            return list(self.runs)
        by_id = {run.id: run for run in self.runs}
        missing = [run_id for run_id in ids if run_id not in by_id]
        if missing:
            raise KeyError(
                f"Unknown run id(s): {', '.join(missing)}. Known: {', '.join(by_id)}"
            )
        return [by_id[run_id] for run_id in ids]


def load_config(path: Path = DEFAULT_CONFIG) -> HarnessConfig:
    with path.open("rb") as handle:
        raw = tomllib.load(handle)
    defaults = raw["defaults"]
    repos = {name: Path(entry["path"]) for name, entry in raw["repos"].items()}
    runs: list[RunSpec] = []
    for entry in raw["runs"]:
        mode = entry.get("mode", "create")
        if mode not in ("create", "update", "fork"):
            raise ValueError(f"run {entry['id']}: mode must be create|update|fork, got {mode}")
        harness = entry.get("harness", "claude-code")
        if entry.get("desktop", defaults.get("desktop", "packaged")) not in ("packaged", "dev"):
            raise ValueError(f"run {entry['id']}: desktop must be packaged|dev")
        if harness not in ("claude-code", "codex", "pi"):
            raise ValueError(f"run {entry['id']}: harness must be claude-code|codex|pi, got {harness}")
        session = entry.get("session")
        if mode == "fork" and not session:
            raise ValueError(f"run {entry['id']}: fork mode needs a session id")
        repo_name = entry["repo"]
        if repo_name not in repos:
            raise KeyError(f"run {entry['id']}: unknown repo {repo_name}")
        prompt_template = entry.get(
            "prompt", defaults["prompt_fork"] if mode == "fork" else defaults["prompt"]
        )
        runs.append(
            RunSpec(
                id=entry["id"],
                repo_name=repo_name,
                repo_path=repos[repo_name],
                pr=int(entry["pr"]),
                mode=mode,
                harness=harness,
                session=session,
                cut=int(entry["cut"]) if "cut" in entry else None,
                worktree_commit=entry.get("worktree"),
                model=entry.get("model", defaults["model"]),
                effort=entry.get("effort", defaults["effort"]),
                prompt=prompt_template.format(pr=entry["pr"]),
                review_cli=entry.get("review_cli", defaults["review_cli"]),
                desktop=entry.get("desktop", defaults.get("desktop", "packaged")),
                traces=bool(entry.get("traces", defaults.get("traces", True))),
                max_turns=int(entry.get("max_turns", defaults["max_turns"])),
                timeout_minutes=int(
                    entry.get("timeout_minutes", defaults["timeout_minutes"])
                ),
            )
        )
    return HarnessConfig(
        runs_dir=Path(defaults["runs_dir"]).expanduser(),
        runs=runs,
    )
