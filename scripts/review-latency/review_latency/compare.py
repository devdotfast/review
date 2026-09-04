"""All-runs comparison dashboard: phase and model-time stacked bars + table."""

import json
import statistics as st
from pathlib import Path

PHASES = ["skill+setup", "scaffold", "exploration", "authoring", "publish loop", "show"]
SLOT_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
SLOT_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"]
SPLIT = ["TTFT", "thinking", "generation", "tools"]

# Runs superseded by corrected reruns, with the reason they are invalid.
KNOWN_INVALID = {
    "20260830T001403Z-review-27-fork-codex": "invalid: wrong worktree + wrong model",
    "20260830T001841Z-review-27-fork-codex": "invalid: wrong worktree",
    "20260831T023423Z-review-27-fork-claude": "invalid: bad prompt (0 turns)",
    "20260831T023519Z-review-27-fork-claude": "invalid: wrong worktree",
}


def discover_runs(runs_dir: Path):
    found = []
    for run_dir in sorted(runs_dir.iterdir()):
        timeline = run_dir / "timeline.json"
        if not timeline.exists():
            continue
        t = json.loads(timeline.read_text())
        run = t["run"]
        manifest = json.loads((run_dir / "manifest.json").read_text())
        harness = {"claude-code": "Claude", "codex": "Codex"}.get(run.get("harness"), run.get("harness"))
        mode = run.get("mode", "create")
        model = manifest.get("fork", {}).get("model") or run.get("model")
        label = f"{'fork' if mode == 'fork' else 'cold'} · {run['repo_name']}#{run['pr']} · {harness} {model}"
        if run_dir.name in KNOWN_INVALID:
            validity = KNOWN_INVALID[run_dir.name]
        else:
            realism = t.get("summary", {}).get("realism")
            coherent = realism is None or (
                realism.get("reviewed_is_worktree_head")
                or realism.get("reviewed_in_worktree_history")
                or realism.get("worktree_in_reviewed_history")
            )
            if realism and not coherent:
                validity = "check: reviewed commit unrelated to worktree"
            elif realism and realism.get("worktree_in_reviewed_history") and not realism.get("reviewed_in_worktree_history") and not realism.get("reviewed_is_worktree_head"):
                validity = "valid (reviewed PR head ahead of checkout)"
            elif not t.get("summary", {}).get("publish_succeeded"):
                validity = "invalid: no published document"
            else:
                validity = "valid"
        found.append((run_dir.name, label, validity, t))
    return found



def write_compare(runs_dir: Path) -> Path:
    rows = []
    for dirname, label, validity, t in discover_runs(runs_dir):
        s = t["summary"]
        phases = {p["name"]: (p["end_ms"] - p["start_ms"]) / 1000 for p in t["spans"] if p["category"] == "phase"}
        rows.append({
            "dir": dirname,
            "label": label,
            "validity": validity,
            "valid": validity.startswith("valid") or validity.startswith("check"),
            "ttv": s.get("time_to_visible_s"),
            "phases": [round(phases.get(p, 0), 1) for p in PHASES],
            "split": (
                [round(s.get("main_ttft_s") or 0, 1), round(s.get("main_thinking_s") or 0, 1),
                 round(s.get("main_generation_s") or 0, 1), round(s.get("main_tool_s") or 0, 1)]
                if s.get("turns") else None  # pre-instrumentation runs have no stream timing
            ),
            "thinking_tokens": s.get("thinking_tokens") or 0,
            "output_tokens": s.get("output_tokens") or 0,
            "publish_attempts": s.get("publish_attempts"),
            "cli_s": round(s.get("review_cli_process_s") or 0, 1),
            "doc": s.get("document") or {},
        })

    groups = {}
    for r in rows:
        if not r["valid"] or r["ttv"] is None:
            continue
        groups.setdefault(r["dir"].split("-", 1)[1], []).append(r)
    grouped = []
    for run_id, rs in groups.items():
        ttvs = [r["ttv"] for r in rs]
        grouped.append({
            "id": run_id, "n": len(rs), "label": rs[-1]["label"],
            "median": round(st.median(ttvs), 1), "min": round(min(ttvs), 1), "max": round(max(ttvs), 1),
            "phases": [round(st.median(r["phases"][i] for r in rs), 1) for i in range(len(PHASES))],
            "anchors": st.median([r["doc"].get("anchors", 0) for r in rs]),
            "diagrams": st.median([r["doc"].get("diagrams", 0) for r in rs]),
            "quotes": st.median([r["doc"].get("trace_quotes", 0) for r in rs]),
            "kb": round(st.median([r["doc"].get("bytes", 0) for r in rs]) / 1024, 1),
        })
    grouped.sort(key=lambda g: -g["median"])
    data = json.dumps({"phases": PHASES, "split": SPLIT, "rows": rows, "grouped": grouped})

    html = """<!doctype html>
    <meta charset="utf-8">
    <title>review-latency: all runs</title>
    <style>
      .viz-root {
        color-scheme: light;
        --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e; --grid:#e7e6e3;
        --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300;
      }
      @media (prefers-color-scheme: dark) {
        :root:where(:not([data-theme="light"])) .viz-root {
          color-scheme: dark;
          --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --grid:#33322f;
          --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300;
        }
      }
      :root[data-theme="dark"] .viz-root {
        color-scheme: dark;
        --surface-1:#1a1a19; --text-primary:#ffffff; --text-secondary:#c3c2b7; --grid:#33322f;
        --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300;
      }
      body { margin:0; }
      .viz-root { background:var(--surface-1); color:var(--text-primary);
        font:13px/1.45 -apple-system, system-ui, sans-serif; min-height:100vh; padding:20px 24px 40px; }
      h1 { font-size:18px; margin:0 0 2px; }
      h2 { font-size:14px; margin:26px 0 8px; }
      .sub { color:var(--text-secondary); margin-bottom:14px; }
      .legend { display:flex; gap:14px; flex-wrap:wrap; margin:6px 0 10px; color:var(--text-secondary); font-size:12px; }
      .legend i { display:inline-block; width:11px; height:11px; border-radius:3px; vertical-align:-1px; margin-right:5px; }
      .row { display:grid; grid-template-columns: 230px 1fr 64px; align-items:center; gap:10px; margin:7px 0; }
      .row .name { text-align:right; font-size:12px; }
      .row .name small { display:block; color:var(--text-secondary); }
      .row .name .flag { color:var(--text-secondary); font-size:11px; }
      .bar { display:flex; height:24px; }
      .seg { height:100%; margin-right:2px; border-radius:0; position:relative; min-width:1px; }
      .seg:first-child { border-radius:4px 0 0 4px; }
      .seg:last-child { border-radius:0 4px 4px 0; margin-right:0; }
      .seg span { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        font-size:10px; color:var(--text-primary); mix-blend-mode:normal; pointer-events:none; }
      .viz-root[data-mode] .seg span { color:#0b0b0b; }
      @media (prefers-color-scheme: dark) { .seg span { color:#0b0b0b !important; } }
      .total { font-variant-numeric: tabular-nums; font-size:12px; }
      .dim .seg { opacity:.45; }
      table { border-collapse:collapse; margin-top:8px; font-size:12px; }
      th, td { padding:4px 10px; border-bottom:1px solid var(--grid); text-align:left; }
      td.n { text-align:right; font-variant-numeric: tabular-nums; }
      a { color:var(--s1); }
      #tip { position:fixed; background:#222; color:#fff; padding:5px 8px; border-radius:4px;
        font-size:12px; pointer-events:none; display:none; z-index:5; }
    </style>
    <div class="viz-root">
      <h1>Review authoring latency — all runs</h1>
      <div class="sub">Time from prompt to the published document visible in Review Desktop. Dimmed rows failed the realism check and are kept for reference only.</div>

      <h2>Where the time went (phases)</h2>
      <div class="legend" id="phase-legend"></div>
      <div id="phase-bars"></div>

      <h2>Main-agent model time (TTFT · thinking · generation · tools)</h2>
      <div class="legend" id="split-legend"></div>
      <div id="split-bars"></div>
      <div class="sub" style="margin-top:6px">Codex exposes no first-byte event, so its TTFT is folded into thinking.</div>

      <h2>By run id (medians across repeats)</h2>
      <div class="sub">Single runs of the same PR have differed by 30%; compare configurations on these medians and add repeats with <code>review-latency run --id X --repeat 3</code>.</div>
      <table id="grouped"></table>

      <h2>Table view</h2>
      <table id="table"></table>
      <div id="tip"></div>
    </div>
    <script id="d" type="application/json">__DATA__</script>
    <script>
    const D = JSON.parse(document.getElementById('d').textContent);
    const slots = i => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue('--s'+(i+1)).trim();
    const s1 = v => v.toFixed(1) + 's';

    function legend(el, names) {
      el.innerHTML = names.map((n,i) => '<span><i style="background:'+slots(i)+'"></i>'+n+'</span>').join('');
    }
    legend(document.getElementById('phase-legend'), D.phases);
    legend(document.getElementById('split-legend'), D.split);

    function bars(el, key, names) {
      const max = Math.max(...D.rows.map(r => (r[key]||[]).reduce((a,b)=>a+b,0)));
      el.innerHTML = D.rows.map((r, ri) => {
        if (!r[key]) return '<div class="row"><div class="name">'+r.label+'<small>'+r.dir.slice(0,15)+'</small></div>' +
          '<div class="sub" style="margin:0">no stream timing (run predates instrumentation)</div><div class="total"></div></div>';
        const total = r[key].reduce((a,b)=>a+b,0);
        const segs = r[key].map((v,i) => {
          const w = (v/max*100);
          const label = (v/max > 0.07) ? '<span>'+s1(v)+'</span>' : '';
          return '<div class="seg" data-t="'+names[i]+': '+s1(v)+'" style="width:'+w+'%;background:'+slots(i)+'">'+label+'</div>';
        }).join('');
        return '<div class="row'+(r.valid?'':' dim')+'">' +
          '<div class="name">'+r.label+'<small>'+r.dir.slice(0,15)+'</small>'+(r.valid?'':'<span class="flag">('+r.validity+')</span>')+'</div>' +
          '<div class="bar">'+segs+'</div><div class="total">'+s1(total)+'</div></div>';
      }).join('');
    }
    bars(document.getElementById('phase-bars'), 'phases', D.phases);
    bars(document.getElementById('split-bars'), 'split', D.split);

    const tip = document.getElementById('tip');
    document.addEventListener('mousemove', e => {
      const seg = e.target.closest('.seg');
      if (!seg) { tip.style.display='none'; return; }
      tip.textContent = seg.dataset.t;
      tip.style.display='block';
      tip.style.left = Math.min(e.clientX+12, innerWidth-160)+'px';
      tip.style.top = (e.clientY+12)+'px';
    });

    document.getElementById('grouped').innerHTML =
      '<tr><th>run id</th><th>n</th><th>median</th><th>min</th><th>max</th>' + D.phases.map(p=>'<th>'+p+' (med)</th>').join('') + '<th>anchors</th><th>diagrams</th><th>quotes</th><th>doc KB</th><th>s / anchor</th></tr>' +
      D.grouped.map(g => '<tr><td>'+g.id+'<br><small style="color:var(--text-secondary)">'+g.label+'</small></td><td class="n">'+g.n+'</td><td class="n">'+s1(g.median)+'</td><td class="n">'+s1(g.min)+'</td><td class="n">'+s1(g.max)+'</td>' +
        g.phases.map(v=>'<td class="n">'+s1(v)+'</td>').join('') + '<td class="n">'+g.anchors+'</td><td class="n">'+g.diagrams+'</td><td class="n">'+g.quotes+'</td><td class="n">'+g.kb+'</td><td class="n">'+(g.anchors ? s1(g.median/g.anchors) : '—')+'</td></tr>').join('');

    document.getElementById('table').innerHTML =
      '<tr><th>run</th><th>validity</th><th>time to visible</th>' + D.phases.map(p=>'<th>'+p+'</th>').join('') +
      '<th>thinking tok</th><th>out tok</th><th>publishes</th><th>CLI time</th><th></th></tr>' +
      D.rows.map(r => '<tr><td>'+r.label+'</td><td>'+r.validity+'</td><td class="n">'+(r.ttv==null?'—':s1(r.ttv))+'</td>' +
        r.phases.map(v=>'<td class="n">'+s1(v)+'</td>').join('') +
        '<td class="n">'+r.thinking_tokens+'</td><td class="n">'+r.output_tokens+'</td><td class="n">'+r.publish_attempts+'</td><td class="n">'+s1(r.cli_s)+'</td>' +
        '<td><a href="./'+r.dir+'/report.html">gantt</a></td></tr>').join('');
    </script>
    """
    out = runs_dir / "compare.html"
    out.write_text(html.replace("__DATA__", data))
    return out
