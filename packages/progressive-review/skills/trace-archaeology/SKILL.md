---
name: trace-archaeology
description: Find the agent sessions behind existing code and search past traces. Use when asked "why does this code exist", "what was the agent thinking here", "who/what wrote this", "has an agent solved X before", or when debugging agent-produced code where the original reasoning would help.
---

# Trace archaeology

Agent-written commits record `Agent-Session: <id>` trailers. Use the `review trace` CLI to resolve and pull those sessions. Use FFF to find candidate events. Use `review trace show` for exact evidence.

## Configuration

Setup is human-owned. If a command reports missing trace configuration, ask the user to use Review Agent Setup. Then stop.

FFF setup is human-owned. If FFF is unavailable, report the setup gap. Do not replace or reconfigure it.

Local commit trailers and blame resolution work without trace storage access.

## Explain code provenance

When asked why code exists, who wrote it, or what decisions produced it:

1. Identify the commits behind the target lines:

   ```sh
   review trace blame <file> -L <start,end> --json
   ```

   This command identifies the last commit that touched each line. Add `--history` only when the current provenance does not explain the decision:

   ```sh
   review trace blame <file> -L <start,end> --history --json
   ```

2. Pull each relevant session into the local corpus:

   ```sh
   review trace pull --session <session-id> --json
   ```

   Read the absolute normalized file paths from the response's `paths` array. Do not derive them from the corpus layout.

3. Use FFF to search the normalized files returned in `paths`.

   Treat each result only as a candidate locator. Each trace file has this shape:

   ```text
   <owner>/<repo>/<session>/main.jsonl
   <owner>/<repo>/<session>/<subagent>.jsonl
   ```

   Ignore physical line 1 because it is trace metadata. For a match on line `<L>`, use event index `<L> - 2`. Use the record's `index` when the excerpt shows it.

4. Inspect each relevant event:

   ```sh
   review trace show <session-id> --trace <trace> --event <event> --json
   ```

   Pass the trace name from the result, including `main`. Search results are not final evidence.

5. Check the current code before you explain the result. The trace can describe a decision that the author later reversed.

This flow is complete when you inspected the relevant events and checked every historical claim against the current code.

## Research a topic

When asked if an agent has previously solved a problem or handled a topic:

1. Pull the current repository traces:

   ```sh
   review trace pull --json
   ```

   Add `--main-only` only when subagent work is not relevant.
   Read the absolute normalized file paths from the response's `paths` array.

2. Use FFF to search the normalized files returned in `paths`. Read the session and trace from the result path. Ignore physical line 1. For a match on line `<L>`, use event index `<L> - 2`.

3. Inspect the relevant events:

   ```sh
   review trace show <session-id> --trace <trace> --event <event> --json
   ```

When the investigation starts from one commit, list its sessions first:

```sh
review trace list --commit <rev> --json
review trace pull --commit <rev> --json
```

Use `review trace show <session-id>` when the full session timeline helps explain the result.

This flow is complete when you inspected the source events and checked the result against current code.

## Evidence Rules

- Treat traces as historical evidence, not current specifications.
- Prefer `--json` when you parse command output.
- Cite session, trace, and event locators for event evidence.
- Cite commit IDs and source lines for current code evidence.
- Report missing or uncertain provenance. Never invent an explanation.
