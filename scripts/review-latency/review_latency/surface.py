"""Fingerprint of the model-facing surface: skill, docs, and review CLI contract.

Runs that share a fingerprint saw the same instructions and API; a changed
fingerprint explains a changed trajectory.
"""

import hashlib
import json
import subprocess
from pathlib import Path

from review_latency.config import REPO_ROOT, SOURCE_CLI

PACKAGE = REPO_ROOT / "packages" / "progressive-review"
SKILL_DIRS = [PACKAGE / "skills" / "dev-review", PACKAGE / "skills" / "dev-review-map"]
# What the agents actually read: the app-managed installed copies.
INSTALLED_SKILLS = {
    "claude": [Path.home() / ".claude" / "skills" / "dev-review", Path.home() / ".claude" / "skills" / "dev-review-map"],
    "agents": [Path.home() / ".agents" / "skills" / "dev-review", Path.home() / ".agents" / "skills" / "dev-review-map"],
}
DOCS_DIR = REPO_ROOT / "docs"
AUTHORING_TYPES = [PACKAGE / "src" / "authoring.ts", PACKAGE / "src" / "review-comment-schema.ts"]
CLI_SUBCOMMANDS = ["", "scaffold", "publish", "info", "app", "map", "threads", "wait", "rebind"]


def hash_paths(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    entries: list[tuple[str, Path]] = []
    for path in paths:
        if path.is_dir():
            entries.extend(
                (f"{path.name}/{p.relative_to(path)}", p)
                for p in sorted(path.rglob("*"))
                if p.is_file()
            )
        elif path.is_file():
            entries.append((path.name, path))
    for name, file in sorted(entries):
        digest.update(name.encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()[:16]


def cli_help_surface(review_bin: str) -> str:
    digest = hashlib.sha256()
    for sub in CLI_SUBCOMMANDS:
        args = [review_bin] + ([sub] if sub else []) + ["--help"]
        out = subprocess.run(args, capture_output=True, text=True)
        digest.update(sub.encode())
        digest.update(out.stdout.encode())
    return digest.hexdigest()[:16]


def surface_fingerprint(review_bin: str) -> dict:
    version = json.loads((PACKAGE / "package.json").read_text())["version"]
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--", "packages/progressive-review", "docs"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip() != ""
    return {
        # skill = the bytes the agents read (installed copies); skill_repo =
        # the source tree, so drift between them is visible per run.
        "skill": {
            harness: hash_paths(paths) for harness, paths in INSTALLED_SKILLS.items()
        },
        "skill_repo": hash_paths(SKILL_DIRS),
        "docs": hash_paths([DOCS_DIR]),
        "authoring_types": hash_paths(AUTHORING_TYPES),
        "cli_help": cli_help_surface(review_bin),
        "package_version": version,
        "source_commit": head,
        "source_dirty": dirty,
        "cli_entry": str(SOURCE_CLI),
    }
