"""Render a timeline as a Perfetto/Chrome trace-event file and a self-contained HTML gantt."""

import json
from pathlib import Path

PID_BY_LANE_PREFIX = {"phases": 1, "agent": 2, "review cli": 3}


def perfetto_events(timeline: dict) -> list[dict]:
    """Chrome trace-event format (load in ui.perfetto.dev or chrome://tracing)."""
    lanes = timeline["lanes"]
    tid_by_lane = {lane: index + 1 for index, lane in enumerate(lanes)}
    events: list[dict] = [
        {"ph": "M", "pid": 1, "tid": tid, "name": "thread_name", "args": {"name": lane}}
        for lane, tid in tid_by_lane.items()
    ]
    t0 = timeline["t0_ms"]
    for span in timeline["spans"]:
        tid = tid_by_lane[span["lane"]]
        events.append(
            {
                "ph": "X",
                "pid": 1,
                "tid": tid,
                "name": span["name"][:120],
                "cat": span["category"],
                "ts": (span["start_ms"] - t0) * 1000,
                "dur": max(span["end_ms"] - span["start_ms"], 0.001) * 1000,
                "args": {k: v for k, v in span["attrs"].items() if k != "output"},
            }
        )
    return events


def write_perfetto(run_dir: Path, timeline: dict) -> Path:
    path = run_dir / "trace.perfetto.json"
    path.write_text(json.dumps({"traceEvents": perfetto_events(timeline)}))
    return path


HTML_TEMPLATE = """<!doctype html>
<meta charset="utf-8">
<title>__TITLE__</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --grid:#e6e6e6; --lane:#f6f6f6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121212; --fg:#eaeaea; --muted:#9a9a9a; --grid:#2a2a2a; --lane:#1b1b1b; } }
  body { margin:0; font: 13px/1.45 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px 8px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); }
  .cards { display:flex; gap:12px; flex-wrap:wrap; padding:8px 20px; }
  .card { border:1px solid var(--grid); border-radius:8px; padding:8px 12px; min-width:130px; }
  .card b { display:block; font-size:20px; }
  .card span { color:var(--muted); font-size:12px; }
  #chart { padding:8px 20px; overflow-x:auto; }
  svg { display:block; }
  .lane-label { font-weight:600; fill:var(--fg); }
  .bar { stroke:rgba(0,0,0,.25); stroke-width:.5; }
  .bar:hover { stroke:#000; stroke-width:1.5; }
  .bar-label { font-size:10px; fill:#111; pointer-events:none; }
  .tick { stroke:var(--grid); }
  .tick-label { font-size:10px; fill:var(--muted); }
  .lane-bg { fill:var(--lane); }
  table { border-collapse:collapse; margin:8px 20px 24px; }
  th, td { text-align:left; padding:4px 10px; border-bottom:1px solid var(--grid); vertical-align:top; font-size:12px; }
  td.num { text-align:right; font-variant-numeric: tabular-nums; }
  .err { color:#b3261e; white-space:pre-wrap; max-width:900px; }
  .legend { display:flex; gap:10px; flex-wrap:wrap; padding:0 20px 8px; font-size:12px; }
  .legend i { display:inline-block; width:12px; height:12px; border-radius:2px; vertical-align:-2px; margin-right:4px; }
  #tip { position:fixed; pointer-events:none; background:#222; color:#fff; padding:6px 8px; border-radius:4px; font-size:12px; max-width:560px; white-space:pre-wrap; display:none; z-index:10; }
  details { padding:0 20px 12px; }
</style>
<header>
  <h1 id="title"></h1>
  <div class="sub" id="subtitle"></div>
</header>
<div class="cards" id="cards"></div>
<div class="legend" id="legend"></div>
<div id="chart"></div>
<div id="tip"></div>
<h3 style="padding:0 20px;margin:12px 0 0">Phases</h3>
<table id="phases"></table>
<h3 style="padding:0 20px;margin:12px 0 0">review CLI commands</h3>
<table id="commands"></table>
<h3 style="padding:0 20px;margin:12px 0 0">Model turns (main agent)</h3>
<table id="turns"></table>
<h3 style="padding:0 20px;margin:12px 0 0">Publish attempts</h3>
<table id="publishes"></table>
<details><summary>Raw summary JSON</summary><pre id="raw"></pre></details>
<script id="data" type="application/json">__DATA__</script>
<script>
const T = JSON.parse(document.getElementById('data').textContent);
const t0 = T.t0_ms, tEnd = T.t_end_ms, total = tEnd - t0;
const s = (ms) => (ms/1000).toFixed(1) + 's';
const mmss = (ms) => { const x = Math.round(ms/1000); return String(Math.floor(x/60)).padStart(2,'0') + ':' + String(x%60).padStart(2,'0'); };

document.getElementById('title').textContent = T.run.id + ' — PR #' + T.run.pr + ' (' + T.run.repo_name + ', ' + T.run.mode + ')';
document.getElementById('subtitle').textContent = (T.run.harness || 'claude-code') + ' · model ' + T.run.model + ' @ ' + (T.run.effort || 'inherited effort') + (T.fork ? ' · forked from ' + T.fork.source_session.slice(0,8) + ' at record ' + T.fork.cut_index + '/' + T.fork.records : '') + ' · review ' + (T.review ? T.review.uuid : 'none') + ' · session ' + s(total) + (T.surface ? ' · surface skill(installed):' + (typeof T.surface.skill === 'string' ? T.surface.skill : T.surface.skill.claude + '/' + T.surface.skill.agents) + (T.surface.skill_repo ? ' repo:' + T.surface.skill_repo : '') + ' cli:' + T.surface.cli_help : '');

const S = T.summary;
const cards = [
  ['time to visible', S.time_to_visible_s == null ? 'n/a' : s(S.time_to_visible_s*1000)],
  ['main agent: model', s(S.main_model_s*1000)],
  ['  of which TTFT', S.main_ttft_s == null ? 'n/a' : s(S.main_ttft_s*1000)],
  ['  of which thinking', S.main_thinking_s == null ? 'n/a' : s(S.main_thinking_s*1000) + ' / ' + (S.thinking_tokens||0) + ' tok'],
  ['  of which generation', S.main_generation_s == null ? 'n/a' : s(S.main_generation_s*1000)],
  ['main agent: tools', s(S.main_tool_s*1000)],
  ['review CLI (process)', s(S.review_cli_process_s*1000)],
  ['publish attempts', S.publish_attempts + (S.publish_succeeded ? '' : ' (none ok)')],
  ['output tokens', S.output_tokens],
  ['cost', S.claude_result.total_cost_usd == null ? 'n/a' : '$' + S.claude_result.total_cost_usd.toFixed(2)],
  ['reviewed commit vs worktree', !S.realism ? 'n/a' : (S.realism.reviewed_is_worktree_head ? 'same' : (S.realism.reviewed_in_worktree_history ? 'in history' : 'UNRELATED'))],
  ['map worker blocked publish', S.map_worker_joined_before_publish == null ? 'n/a' : (S.map_worker_joined_before_publish ? 'YES' : 'no')],
];
document.getElementById('cards').innerHTML = cards.map(([k,v]) => '<div class="card"><b>'+v+'</b><span>'+k+'</span></div>').join('');

const colorFor = (sp) => {
  if (sp.category === 'phase') return {'skill+setup':'#c7d2fe','scaffold':'#fde68a','exploration':'#bbf7d0','authoring':'#fbcfe8','publish loop':'#fecaca','show':'#a5f3fc'}[sp.name] || '#ddd';
  if (sp.category === 'model') return '#ede9fe';
  if (sp.category === 'model-ttft') return '#9ca3af';
  if (sp.category === 'model-thinking') return '#7c3aed';
  if (sp.category === 'model-generation') return '#a78bfa';
  if (sp.category === 'tool') {
    const t = sp.attrs.tool || '';
    const cmd = (sp.attrs.input && sp.attrs.input.command) || '';
    if (t === 'Bash' && /\\breview\\s/.test(cmd)) return '#f59e0b';
    if (t === 'Bash') return '#fbbf24';
    if (t === 'Read' || t === 'Grep' || t === 'Glob' || t.startsWith('mcp__')) return '#34d399';
    if (t === 'Edit' || t === 'Write' || t === 'MultiEdit') return '#f472b6';
    if (t === 'Task' || t === 'Agent') return '#60a5fa';
    if (t === 'Skill') return '#818cf8';
    return '#cbd5e1';
  }
  if (sp.category === 'cli') {
    if (sp.name.startsWith('$ ')) return sp.attrs.ok === false ? '#fca5a5' : '#fdba74';
    return '#fb923c';
  }
  return '#ddd';
};
document.getElementById('legend').innerHTML = [
  ['#ede9fe','model request'],['#9ca3af','TTFT'],['#7c3aed','thinking'],['#a78bfa','generation'],['#f59e0b','Bash: review …'],['#fbbf24','Bash'],['#34d399','Read/Grep/Glob/MCP'],['#f472b6','Edit/Write'],['#60a5fa','Task/Agent'],['#818cf8','Skill'],['#fb923c','review CLI span'],['#fdba74','$ subprocess'],['#fca5a5','$ subprocess (failed)']
].map(([c,l]) => '<span><i style="background:'+c+'"></i>'+l+'</span>').join('');

// Layout: lanes; within a lane, rows by depth (cli) or by overlap packing (agent/model share row 0, tools row 1).
const pxPerSec = Math.max(2, Math.min(40, 1400 / (total/1000)));
const width = Math.max(1200, total/1000*pxPerSec) + 260;
const rowH = 16, laneGap = 8, left = 240;
const laneRows = {};
for (const sp of T.spans) {
  let row = 0;
  if (sp.category === 'cli') row = Math.min(sp.depth, 5);
  else if (sp.category === 'tool') row = 2;
  else if (sp.category.startsWith('model-')) row = 1;
  laneRows[sp.lane] = Math.max(laneRows[sp.lane] || 0, row + 1);
}
let y = 24; const laneY = {};
for (const lane of T.lanes) { laneY[lane] = y; y += (laneRows[lane] || 1) * rowH + laneGap; }
const height = y + 10;
const x = (ms) => left + (ms - t0)/1000*pxPerSec;
let svg = '<svg width="'+width+'" height="'+height+'">';
for (const lane of T.lanes) {
  const h = (laneRows[lane]||1)*rowH;
  svg += '<rect class="lane-bg" x="0" y="'+laneY[lane]+'" width="'+width+'" height="'+h+'"/>';
  svg += '<text class="lane-label" x="8" y="'+(laneY[lane]+12)+'">'+lane+'</text>';
}
const tickEvery = total > 20*60*1000 ? 120 : total > 5*60*1000 ? 60 : 30;
for (let t = 0; t <= total/1000; t += tickEvery) {
  const xx = x(t0 + t*1000);
  svg += '<line class="tick" x1="'+xx+'" x2="'+xx+'" y1="14" y2="'+height+'"/>';
  svg += '<text class="tick-label" x="'+(xx+2)+'" y="11">'+mmss(t*1000)+'</text>';
}
const bars = [];
T.spans.forEach((sp, i) => {
  let row = 0;
  if (sp.category === 'cli') row = Math.min(sp.depth, 5);
  else if (sp.category === 'tool') row = 2;
  else if (sp.category.startsWith('model-')) row = 1;
  const yy = laneY[sp.lane] + row*rowH + 1;
  const x1 = x(sp.start_ms), w = Math.max(1, x(sp.end_ms) - x1);
  svg += '<rect class="bar" data-i="'+i+'" x="'+x1+'" y="'+yy+'" width="'+w+'" height="'+(rowH-2)+'" fill="'+colorFor(sp)+'"/>';
  if (w > 40 && (sp.category === 'phase' || sp.category === 'tool' || (sp.category==='cli' && sp.depth <= 1))) {
    svg += '<text class="bar-label" x="'+(x1+3)+'" y="'+(yy+11)+'">'+escapeHtml(sp.name.slice(0, Math.floor(w/6)))+'</text>';
  }
});
svg += '</svg>';
document.getElementById('chart').innerHTML = svg;
function escapeHtml(t) { return String(t).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

const tip = document.getElementById('tip');
document.getElementById('chart').addEventListener('mousemove', (e) => {
  const el = e.target.closest('.bar');
  if (!el) { tip.style.display = 'none'; return; }
  const sp = T.spans[+el.dataset.i];
  const a = sp.attrs || {};
  let lines = [sp.name, 'start ' + mmss(sp.start_ms - t0) + '  dur ' + s(sp.end_ms - sp.start_ms)];
  if (sp.category === 'model' && a.ttft_ms != null) lines.push('trigger: ' + a.trigger, 'ttft ' + s(a.ttft_ms) + '  thinking ' + s(a.thinking_ms) + ' (' + (a.thinking_tokens||0) + ' tok)  generation ' + s(a.generation_ms));
  if (sp.category === 'model') lines.push('out ' + (a.output_tokens ?? '?') + ' tok, thinking ' + (a.thinking_tokens ?? 0) + ', cache read ' + (a.cache_read_input_tokens ?? '?') + ', cache write ' + (a.cache_creation_input_tokens ?? '?'));
  if (sp.category === 'tool' && a.output) lines.push('—', String(a.output).slice(0, 600));
  if (sp.category === 'cli' && a.detail) lines.push(String(a.detail).slice(0, 400));
  tip.textContent = lines.join('\\n');
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 580) + 'px';
  tip.style.top = (e.clientY + 12) + 'px';
});

const phases = T.spans.filter(sp => sp.category === 'phase');
document.getElementById('phases').innerHTML = '<tr><th>phase</th><th>start</th><th>duration</th><th>share</th></tr>' +
  phases.map(p => '<tr><td>'+p.name+'</td><td class="num">'+mmss(p.start_ms-t0)+'</td><td class="num">'+s(p.end_ms-p.start_ms)+'</td><td class="num">'+(100*(p.end_ms-p.start_ms)/total).toFixed(0)+'%</td></tr>').join('');

document.getElementById('commands').innerHTML = '<tr><th>command</th><th>duration</th><th>review</th></tr>' +
  S.review_commands.map(c => '<tr><td><code>review '+escapeHtml(c.command)+'</code></td><td class="num">'+s(c.duration_s*1000)+'</td><td>'+(c.attributes.reviewUuid ? c.attributes.reviewUuid.slice(0,8) : '')+'</td></tr>').join('');

document.getElementById('publishes').innerHTML = '<tr><th>#</th><th>start</th><th>duration</th><th>ok</th><th>errors</th></tr>' +
  S.publish_attempts_detail.map((p,i) => '<tr><td>'+(i+1)+'</td><td class="num">'+mmss(p.start_ms-t0)+'</td><td class="num">'+s(p.duration_ms)+'</td><td>'+(p.ok?'yes':'no')+'</td><td class="err">'+escapeHtml(p.errors.join('\\n'))+'</td></tr>').join('');

document.getElementById('turns').innerHTML = '<tr><th>start</th><th>responding to</th><th>TTFT</th><th>thinking</th><th>think tok</th><th>generation</th><th>out tok</th><th>cache read</th><th>tools</th></tr>' +
  (S.turns||[]).map(t => '<tr><td class="num">'+mmss(t.start_ms-t0)+'</td><td>'+escapeHtml(t.trigger)+'</td><td class="num">'+s(t.ttft_ms)+'</td><td class="num">'+s(t.thinking_ms)+'</td><td class="num">'+t.thinking_tokens+'</td><td class="num">'+s(t.generation_ms)+'</td><td class="num">'+t.output_tokens+'</td><td class="num">'+t.cache_read_input_tokens+'</td><td>'+escapeHtml(t.tools.join(', '))+'</td></tr>').join('');

document.getElementById('raw').textContent = JSON.stringify(S, null, 1);
</script>
"""


def write_html(run_dir: Path, timeline: dict) -> Path:
    path = run_dir / "report.html"
    title = f"{timeline['run']['id']} latency"
    data = json.dumps(timeline).replace("</", "<\\/")
    path.write_text(HTML_TEMPLATE.replace("__TITLE__", title).replace("__DATA__", data))
    return path
