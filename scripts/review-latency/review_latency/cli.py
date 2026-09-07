import argparse
import sys
from pathlib import Path

from review_latency.compare import write_compare
from review_latency.config import DEFAULT_CONFIG, load_config, with_traces
from review_latency.flamegraph import write_flamegraph
from review_latency.render import write_html, write_perfetto
from review_latency.runner import execute_run
from review_latency.timeline import write_timeline


def log(message: str) -> None:
    sys.stderr.write(f"[review-latency] {message}\n")
    sys.stderr.flush()


def render_run(run_dir: Path) -> None:
    timeline = write_timeline(run_dir)
    perfetto = write_perfetto(run_dir, timeline)
    html = write_html(run_dir, timeline)
    summary = timeline["summary"]
    ttv = summary["time_to_visible_s"]
    log(
        f"time to visible: {ttv:.1f}s" if ttv is not None else "time to visible: n/a (no published document)"
    )
    log(f"report {html}")
    log(f"perfetto {perfetto}")


def command_run(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    specs = config.select(args.id, args.all)
    if not specs:
        log("nothing selected; pass --id <run> or --all")
        return 2
    variants = {"on": [True], "off": [False], "both": [True, False]}[args.traces]
    for spec in specs:
        for attempt in range(1, args.repeat + 1):
            for traces in variants:
                spec = with_traces(spec, traces)
                suffix = f" [{attempt}/{args.repeat}]" if args.repeat > 1 else ""
                log(f"=== {spec.id}: {spec.repo_name} PR #{spec.pr} ({spec.mode}, {spec.model} @ {spec.effort}, traces {'on' if spec.traces else 'off'}){suffix}")
                run_dir = execute_run(spec, config.runs_dir, log)
                render_run(run_dir)
    return 0


def command_render(args: argparse.Namespace) -> int:
    for run_dir in args.run_dir:
        render_run(Path(run_dir))
    return 0


def command_dashboards(args: argparse.Namespace) -> int:
    runs_dir = load_config(Path(args.config)).runs_dir
    log(f"compare {write_compare(runs_dir)}")
    log(f"flamegraph {write_flamegraph(runs_dir)}")
    return 0


def command_list(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    for spec in config.runs:
        print(f"{spec.id:12} {spec.repo_name:8} PR #{spec.pr:<5} {spec.mode:6} {spec.model} @ {spec.effort}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="review-latency")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="execute runs and render their reports")
    run.add_argument("--id", action="append", default=[], help="run id (repeatable)")
    run.add_argument("--all", action="store_true")
    run.add_argument(
        "--traces", choices=("on", "off", "both"), default="on",
        help="trace storage available to the agent; 'both' runs each spec twice, the off variant under id <id>-notrace",
    )
    run.add_argument(
        "--repeat", type=int, default=1,
        help="run each selected spec N times (same PR ran 509s and 659s on identical inputs; compare medians, not single runs)",
    )
    run.set_defaults(func=command_run)

    render = sub.add_parser("render", help="rebuild timeline + report for existing run dirs")
    render.add_argument("run_dir", nargs="+")
    render.set_defaults(func=command_render)

    dashboards = sub.add_parser("dashboards", help="rebuild compare.html + flamegraph.html across all runs")
    dashboards.set_defaults(func=command_dashboards)

    listing = sub.add_parser("list", help="list configured runs")
    listing.set_defaults(func=command_list)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
