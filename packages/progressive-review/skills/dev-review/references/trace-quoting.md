# Trace quoting

A Review can quote the agent sessions that produced the change. The reader then learns the intent from the user's own words, and each quote opens the trace at that moment.

The dev-review workflow provides materialized trace paths through the current scaffold event or its compatibility fallback. Skip this reference when no trace paths were materialized.

## Use the materialized sessions

Read `traces.sessions`, `traces.unavailableSessions`, and `traces.paths` from the scaffold JSON event. Scaffolding has already resolved the sessions from `Agent-Session` commit trailers in the pinned range and pulled each available transcript.

## Complete the intent pass

Survey each available main trace before you author the document:

```sh
review trace show <session-id>
```

The output shows the complete ordered event index. Read the whole index. It provides the narrative shape that isolated search hits cannot provide.

During this pass, identify the user's requirements, corrections, accepted decisions, reversals, emphasis, and unresolved questions. Check these findings against the pinned diff.

Survey a listed subagent trace when the main trace delegates relevant design or implementation work:

```sh
review trace show <session-id> --trace <name>
```

Do not filter the first pass to user events. Agent actions and tool use explain how the conversation changed the implementation. Use `--kind user` only as a second view.

The intent pass is complete when every available main trace has been surveyed and each relevant subagent trace has been surveyed.

Scaffold or `review trace pull` writes one normalized JSONL file per trace under:

```text
~/.dev/trace-search/<owner>/<repo>/<session>/main.jsonl
~/.dev/trace-search/<owner>/<repo>/<session>/<subagent>.jsonl
```

The scaffold event returns each absolute file path in `traces.paths`; `review trace pull` returns them in `paths`. Use these paths directly. Do not derive them from the corpus layout.

The first line contains trace metadata. Each later line contains one event with its index, kind, exact projected text, and structured event.

If scaffold warnings or the compatibility pull report missing trace configuration, ask the user to use Review Agent Setup. Do not change setup autonomously.

## Find supporting events

After the intent pass, use the FFF MCP (in its absence, falling back to tools like `rg`, and then `grep`) to search the files returned in `paths` for each important requirement or decision.

Each physical line (except for line 1) contains one event. For a match on line `<L>`, the event index is `<L> - 2`. Use the record's `index` when the excerpt shows it. Otherwise, derive the index from the physical line number.

Prefer user event records for requirements and corrections. Use assistant event records only when the assistant stated a decision that the user accepted. Confirm the kind with `review trace show --event` when the search excerpt omits it.

## Read exact quote text

Print one event in full before you quote it:

```sh
review trace show <session-id> --trace <trace> --event <n> --json
```

Pass the session and trace from the result path. Pass the event index from the matching record. Use `main` for `main.jsonl`. The `text` field uses the same projection that publish validates. Copy quote text only from this field.

Use `trace_quote_props` from the response without reconstructing it. Every `TraceQuote` must use those props and an exact substring of `text`.

## Quote rules

- Write quotes inline in paragraphs with `TraceQuote`. Do not use separate quote blocks.
- Quote the user's words by default. Quote the agent's words only for a decision the agent stated and the user accepted. The diff is the test of acceptance: an agent decision the shipped diff confirms, and the user did not reverse, counts as accepted.
- Each quote must be an exact substring of one event's text. Publish checks every quote against the transcript and rejects text it cannot find. Whitespace is compared collapsed; all other characters must match.
- Keep edits outside the quotes. Put `[brackets]`, ellipsis, and connecting grammar in the plain text between two quotes. An edited quote fails the substring check.
- MDX parses the quote children. A `{` starts an expression, so wrap a code fragment such as `{ cols: 120 }` in backticks inside the quote; the backticks survive as code formatting and the checked text still matches. Backtick characters in the transcript itself do not round-trip; choose a quote span that avoids them, or put that fragment in glue text.
- Prefer clause-length quotes of 8 to 30 words.
- Glue text connects quotes. It must not add claims the trace does not contain. Do not paraphrase where a quote exists.
- Apply the returned `trace_quote_props` to each quote. Publish reports the correct event when a hint is stale or ambiguous.

## Quote density by section

- Landing section: This section should almost entirely be composed from user (or, maybe, agent-written, but user-approved later on) quotes, save for some glue words connecting the quotes. The two-to-four-sentence cap holds; short quotes beat long ones here. the most important thing is to capture the user's intent, in their words, which led to the code change in the pinned diff.
- Requirements: at least one quote per bullet.
- Design: a quote states each decision. An `AnchorLink` shows the decision in code.
- Implementation: authored prose with `AnchorLink` evidence. Quotes are optional.
- Decision log: the full replay. Quote the turns in trace order. Include decisions that later got invalidated or reversed, each with the quote that reversed it. Quote both decisions that the user made, as well as decisions that the agent made.

## Decisions that changed

Outside the decision log, quote only decisions that the pinned diff confirms. When a later event reversed a decision, the earlier quote does not describe the change. Reversed decisions belong only in the decision log.

## Example texture

An excerpt from a landing paragraph can read like this:

```mdx
<TraceQuote sessionId="019fdb00-f032-79d2-9ee8-0b8fe0e86a9e" event={62}>
  I actually don't think you pretty much ever should have to do an image build.
</TraceQuote>
In practice,
<TraceQuote sessionId="019fdb00-f032-79d2-9ee8-0b8fe0e86a9e" event={62}>
  the container image itself should be almost constantly static and it has been
  for the last four or five days.
</TraceQuote>
Existing startup latencies are excessive:
<TraceQuote sessionId="019fdb00-f032-79d2-9ee8-0b8fe0e86a9e" event={129}>
  i want like 5 seconds in the happy path
</TraceQuote>
.
```

A requirements bullet reads like this:

```mdx
- Deterministic pool identity: <TraceQuote sessionId="019fe07f-9e9d-79a3-966b-51ef899c03f7" event={183}>pool_id = (blueprint, sidecar, source_infra_hash). when any of these change, consider the pool_id have changed</TraceQuote>.
```

Keep the user's typos and casing. The quote is evidence, not copy.

The quote pass is complete when every quote comes from `show.text`, uses its returned props, and describes code in the pinned diff.
