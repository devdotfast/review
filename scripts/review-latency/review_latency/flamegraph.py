"""Build a flamegraph (icicle) of the prompt->visible critical path.

Hierarchy per run:
  phase -> activity (model: thinking/generation/ttft, tool: review <verb>,
  tool: <Name>, subagent wait/gap) -> CLI span -> CLI child span (incl.
  desktop mount steps).
Frames hold self-seconds; identical paths merge when several runs are selected.
"""

import json
from pathlib import Path

from review_latency.compare import KNOWN_INVALID



def new_node():
    return {"self": 0.0, "children": {}}


def add(tree, path, seconds):
    node = tree
    for part in path:
        node = node["children"].setdefault(part, new_node())
    node["self"] += seconds


def clip(start, end, a, b):
    return max(0.0, min(end, b) - max(start, a)) / 1000.0


def build_run_tree(run_dir: Path):
    t = json.loads((run_dir / "timeline.json").read_text())
    summary = t["summary"]
    if summary.get("time_to_visible_s") is None:
        return None, None
    t0 = t["t0_ms"]
    visible = summary["visible_ms"]
    phases = [p for p in t["spans"] if p["category"] == "phase"]
    spans = t["spans"]
    by_id = {s["id"]: s for s in spans}
    tree = new_node()

    for phase in phases:
        a, b = phase["start_ms"], min(phase["end_ms"], visible)
        if b <= a:
            continue
        pname = phase["name"]
        covered = 0.0

        # model activity: prefer the ttft/thinking/generation child spans
        fine = [s for s in spans if s["lane"] == "agent" and s["category"].startswith("model-")]
        if fine:
            for s in fine:
                sec = clip(a, b, s["start_ms"], s["end_ms"])
                if sec <= 0:
                    continue
                kind = s["category"].split("-", 1)[1]
                add(tree, [pname, f"model: {kind}"], sec)
                covered += sec
        else:
            for s in spans:
                if s["lane"] == "agent" and s["category"] == "model":
                    sec = clip(a, b, s["start_ms"], s["end_ms"])
                    if sec > 0:
                        add(tree, [pname, "model (unsplit)"], sec)
                        covered += sec

        # tool calls; review CLI calls get their process spans as children
        cli_spans = [s for s in spans if s["category"] == "cli"]
        for s in spans:
            if s["lane"] != "agent" or s["category"] != "tool":
                continue
            sec = clip(a, b, s["start_ms"], s["end_ms"])
            if sec <= 0:
                continue
            command = str((s["attrs"].get("input") or {}).get("command", ""))
            tool = s["attrs"].get("tool", "tool")
            if "review " in command and tool == "Bash":
                label = "tool: review CLI"
            elif tool == "Bash":
                label = "tool: Bash (git/other)"
            else:
                label = f"tool: {tool}"
            covered += sec
            # attach owned CLI spans (top-level ones are parented to the tool span)
            owned = [c for c in cli_spans if c.get("parent") == s["id"]]
            cli_total = 0.0
            for c in owned:
                if c["name"] in ("telemetry capture",):
                    continue
                csec = clip(a, b, c["start_ms"], c["end_ms"])
                if csec <= 0:
                    continue
                # children of this cli span (one level down)
                kids = [k for k in cli_spans if k.get("parent") == c["id"] and k["name"] != "telemetry capture"]
                ksec_total = 0.0
                for k in kids:
                    ksec = clip(a, b, k["start_ms"], k["end_ms"])
                    if ksec > 0:
                        grand = [g for g in cli_spans if g.get("parent") == k["id"] and g["name"] != "telemetry capture"]
                        gtotal = 0.0
                        for g in grand:
                            gsec = clip(a, b, g["start_ms"], g["end_ms"])
                            if gsec > 0:
                                add(tree, [pname, label, c["name"], k["name"], g["name"]], gsec)
                                gtotal += gsec
                        add(tree, [pname, label, c["name"], k["name"]], max(0.0, ksec - gtotal))
                        ksec_total += ksec
                add(tree, [pname, label, c["name"]], max(0.0, csec - ksec_total))
                cli_total += csec
            add(tree, [pname, label], max(0.0, sec - cli_total))

        add(tree, [pname, "other (harness/gaps)"], max(0.0, (b - a) / 1000.0 - covered))

    run = t["run"]
    label = f"{run.get('mode','create')} {run['repo_name']}#{run['pr']} {run.get('harness','claude-code')}"
    return label, tree



def write_flamegraph(runs_dir: Path) -> Path:
    runs = {}
    for run_dir in sorted(runs_dir.iterdir()):
        if not (run_dir / "timeline.json").exists() or run_dir.name in KNOWN_INVALID:
            continue
        if not json.loads((run_dir / "timeline.json").read_text())["summary"].get("publish_succeeded"):
            continue  # same rule as compare: no published document, no data
        label, tree = build_run_tree(run_dir)
        if tree:
            runs[run_dir.name] = {"label": label, "tree": tree}

    data = json.dumps(runs)

    html = """<!doctype html>
    <meta charset="utf-8">
    <title>review-latency flamegraph</title>
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
      .sub { color:var(--text-secondary); margin-bottom:10px; }
      #runs { display:flex; gap:12px; flex-wrap:wrap; margin:10px 0 16px; font-size:12px; color:var(--text-secondary); }
      #runs label { cursor:pointer; }
      #crumb { margin:6px 0; font-size:12px; color:var(--text-secondary); min-height:18px; }
      #crumb a { color:var(--s1); cursor:pointer; margin-right:6px; }
      #flame { width:100%; }
      .frame { position:absolute; height:22px; border-radius:3px; overflow:hidden; white-space:nowrap;
        font-size:11px; line-height:22px; padding:0 4px; box-sizing:border-box; cursor:pointer;
        border:1px solid var(--surface-1); color:#0b0b0b; }
      .frame:hover { filter:brightness(1.08); border-color:#000; }
      #stage { position:relative; }
      #tip { position:fixed; background:#222; color:#fff; padding:5px 8px; border-radius:4px;
        font-size:12px; pointer-events:none; display:none; z-index:5; max-width:520px; }
      table { border-collapse:collapse; margin-top:20px; font-size:12px; }
      th,td { padding:3px 10px; border-bottom:1px solid var(--grid); text-align:left; }
      td.n { text-align:right; font-variant-numeric:tabular-nums; }
    </style>
    <div class="viz-root">
      <h1>Review authoring — critical-path flamegraph</h1>
      <div class="sub">Width = seconds on the prompt→visible path, summed over the selected runs. Click a frame to zoom; click the root crumb to reset. Level 1 = phase, level 2 = what was actually running, deeper = review-CLI internals.</div>
      <div id="runs"></div>
      <div id="crumb"></div>
      <div id="stage"></div>
      <h2 style="font-size:14px;margin-top:26px">Top self-time frames (table view, current selection)</h2>
      <table id="top"></table>
      <div id="tip"></div>
    </div>
    <script id="d" type="application/json">__DATA__</script>
    <script>
    const RUNS = JSON.parse(document.getElementById('d').textContent);
    const PHASE_SLOT = {"skill+setup":1,"scaffold":2,"exploration":3,"authoring":4,"publish loop":5,"show":6};
    const css = n => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue('--s'+n).trim();
    const s1 = v => v >= 100 ? v.toFixed(0)+'s' : v.toFixed(1)+'s';

    const runsEl = document.getElementById('runs');
    runsEl.innerHTML = Object.entries(RUNS).map(([k,v]) =>
      '<label><input type="checkbox" checked data-k="'+k+'"> '+v.label+'</label>').join('');
    runsEl.addEventListener('change', () => { zoomPath = []; render(); });

    function mergeInto(dst, src) {
      dst.self += src.self;
      for (const [k, c] of Object.entries(src.children)) {
        if (!dst.children[k]) dst.children[k] = {self:0, children:{}};
        mergeInto(dst.children[k], c);
      }
    }
    function selection() {
      const root = {self:0, children:{}};
      for (const box of runsEl.querySelectorAll('input:checked')) mergeInto(root, RUNS[box.dataset.k].tree);
      return root;
    }
    function total(n) { let t = n.self; for (const c of Object.values(n.children)) t += total(c); return t; }

    let zoomPath = [];
    function nodeAt(root, path) { let n = root; for (const p of path) n = n.children[p]; return n; }

    function shade(hex, depth) {
      const f = Math.max(0, 1 - depth*0.13);
      const c = parseInt(hex.slice(1), 16);
      const mix = (v) => Math.round(v + (255-v)*(1-f)*0.9);
      return '#'+[(c>>16)&255,(c>>8)&255,c&255].map(mix).map(v=>v.toString(16).padStart(2,'0')).join('');
    }

    function render() {
      const root = selection();
      const view = nodeAt(root, zoomPath);
      const grand = total(view);
      const stage = document.getElementById('stage');
      const width = stage.clientWidth || 1200;
      const frames = [];
      function layout(node, path, x, w, depth, slot) {
        if (w < 0.5) return depth;
        let maxDepth = depth;
        if (depth > 0) {
          const name = path[path.length-1];
          const mySlot = depth === 1 && zoomPath.length === 0 ? (PHASE_SLOT[name] || 1) : slot;
          frames.push({name, path:[...path], x, w, depth, seconds: total(node), self: node.self, slot: mySlot});
          slot = mySlot;
        }
        let cx = x;
        const entries = Object.entries(node.children).sort((a,b)=>total(b[1])-total(a[1]));
        for (const [k, c] of entries) {
          const cw = total(c)/grand * width;
          maxDepth = Math.max(maxDepth, layout(c, [...path, k], cx, cw, depth+1, slot));
          cx += cw;
        }
        return maxDepth;
      }
      const maxDepth = layout(view, [], 0, width, 0, 1);
      stage.style.height = (maxDepth*24+4)+'px';
      stage.innerHTML = frames.map((f,i) =>
        '<div class="frame" data-i="'+i+'" style="left:'+f.x+'px;top:'+((f.depth-1)*24)+'px;width:'+Math.max(1,f.w-1)+'px;background:'+shade(css(f.slot), f.depth-1)+'">'+
        (f.w > 40 ? f.name+' · '+s1(f.seconds) : (f.w > 14 ? f.name.slice(0, Math.floor(f.w/7)) : ''))+'</div>').join('');
      stage.onclick = e => {
        const el = e.target.closest('.frame'); if (!el) return;
        zoomPath = [...zoomPath, ...frames[+el.dataset.i].path];
        render();
      };
      const tip = document.getElementById('tip');
      stage.onmousemove = e => {
        const el = e.target.closest('.frame');
        if (!el) { tip.style.display='none'; return; }
        const f = frames[+el.dataset.i];
        tip.textContent = [...zoomPath, ...f.path].join(' → ')+'  —  '+s1(f.seconds)+' total ('+(100*f.seconds/grand).toFixed(1)+'% of view), '+s1(f.self)+' self';
        tip.style.display='block';
        tip.style.left=Math.min(e.clientX+12, innerWidth-540)+'px'; tip.style.top=(e.clientY+14)+'px';
      };
      document.getElementById('crumb').innerHTML =
        '<a data-d="-1">all ('+s1(grand)+')</a>' + zoomPath.map((p,i)=>' → <a data-d="'+i+'">'+p+'</a>').join('');
      document.getElementById('crumb').onclick = e => {
        const a = e.target.closest('a'); if (!a) return;
        zoomPath = zoomPath.slice(0, +a.dataset.d+1); render();
      };
      // table: top self-time leaves under current view
      const rows = [];
      (function walk(n, path){ if (n.self > 0.5 && path.length) rows.push([path.join(' → '), n.self]);
        for (const [k,c] of Object.entries(n.children)) walk(c, [...path,k]); })(view, []);
      rows.sort((a,b)=>b[1]-a[1]);
      document.getElementById('top').innerHTML = '<tr><th>frame</th><th>self time</th><th>share</th></tr>'+
        rows.slice(0,25).map(([p,v])=>'<tr><td>'+p+'</td><td class="n">'+s1(v)+'</td><td class="n">'+(100*v/grand).toFixed(1)+'%</td></tr>').join('');
    }
    render();
    addEventListener('resize', render);
    </script>
    """
    out = runs_dir / "flamegraph.html"
    out.write_text(html.replace("__DATA__", data))
    return out
