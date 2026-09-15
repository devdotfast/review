# Component API

Props for every built-in MDX component and every `data.ts` helper. All schemas are strict: an unknown prop fails validation. `children: none` means the component rejects children.

Import helper functions only in `data.ts`. In `review.mdx`, import authored values from `./data.ts`. Use the built-in MDX components without importing them.

## data.ts helpers

Import from `virtual:progressive-review-authoring`.

### defineActors

```ts
export const actors = defineActors({
  agent: { label: "Agent" },                              // label: string (required)
  server: { label: "Server", softwareMapPath: "system.server" }, // softwareMapPath?: string
});
```

### defineAnchors

Each value is a string title, or:

```ts
export const anchors = defineAnchors({
  spawn: {
    title: "PTY spawn site",             // required
    detail: "Cold-path fallback branch", // optional
    softwareMapPath: "system.server",    // optional
    peek: {                              // optional; required for CodePeek/SequenceDiagram/CallStackDiff/DbRead/DbWrite use
      file: "src/auth.ts",               // path inside the pinned worktree
      fromLine: 214,                     // positive int
      toLine: 223,                       // >= fromLine
      graph: "head",                     // "head" (default) | "base"
      theme: "system",                   // "system" | "light" | "dark", optional
    },
  },
});
```

An anchor without `peek` can label things but cannot open code. `AnchorLink` and every diagram frame require an anchor **with** `peek`.

### defineStores

```ts
export const stores = defineStores({
  reviewDb: {
    kind: "relational",                  // "relational" | "document"
    label: "review.db",
    tables: {                            // or `documents` for kind "document"
      threads: {
        label: "threads",                // optional
        key: "id",                       // optional
        schema: {
          id: { type: "text", pk: true },
          body: { type: "text" },
        },
      },
    },
  },
});
```

### calls(parent, child, reason?)

For `CallStackDiff` frames where the hop is hard to follow (queues, callbacks, RPC). `parent` and `child` are peekable anchors; `reason` is an optional string shown on hover.

## Components

### AnchorLink

Link prose to an anchored source range, opened in side peek.

```mdx
<AnchorLink anchor={anchors.spawn}>the spawn site</AnchorLink>
```

Props: `anchor` (peekable anchor, required). Children: the link text (required).

### CodePeek

Show one anchored range inline in the document.

```mdx
<CodePeek anchor={anchors.spawn} />
```

Props: `anchor` (peekable anchor, required). Children: none.

### ReviewSection

Collapse optional detail. `##` headings wrap into sections automatically; use the explicit component only to start collapsed.

```mdx
<ReviewSection title="Edge cases" defaultCollapsed>…</ReviewSection>
```

Props: `title` (required), `defaultCollapsed?` (boolean). Children: content.

### SequenceDiagram

```mdx
<SequenceDiagram label="Open a trace quote" messages={messages} />
```

Props: `label` (required), `messages` (non-empty array, required). Children: none.

Each message:

```ts
{
  from: actors.agent,            // actor ref, or inline { label: "CLI" }
  to: actors.server,
  label: "startLogin(cols, rows)",
  anchor: anchors.spawn,         // peekable anchor — required unless `code` is set
  code: "spawnPty(dims)",        // string or { language?, text } — required unless `anchor` peek is set
}
```

Every message needs source evidence: a peekable `anchor`, or an inline `code` value.

### CallStackDiff

Two authored call stacks rendered as one git-diff-styled stack.

```mdx
<CallStackDiff
  title="Warm allocation"
  base={[anchors.reconcile, anchors.auth, anchors.enqueueWork]}
  head={[
    anchors.reconcile,
    anchors.enqueueWork,
    calls(anchors.enqueueWork, anchors.processItem, "dispatched via the workqueue"),
  ]}
/>
```

Props: `title?`, `base` and `head` (arrays of peekable anchors or `calls(...)` entries). Children: none.

Rules:

1. List order is the stack. Each frame calls the one below it.
2. Define one anchor per frame. Point its peek at the call site or the function head.
3. The diff is positional over anchor identity. A shared frame is one head anchor listed in both `base` and `head`; it renders as context and opens the new code.
4. A frame only in `base` is a removed call. Its anchor must set `graph: "base"`. The schema rejects a head-graph anchor that appears only in `base`, and any base-graph anchor in `head`.
5. Use `calls(parent, child, reason?)` in place of a frame when the hop is hard to follow by eye. It renders the child frame with a dashed `≈` marker.
6. One component holds one linear stack. Use two components for two flows.
7. A `-` row claims removal and a `+` row claims addition. Publish checks each against the pinned diff: a `-` frame must anchor a range with deleted lines, and a `+` frame a range with added lines. Do not list a frame on one side only for contrast — publish rejects it.

### DatabaseLens, DbUseCase, DbRead, DbWrite

Persisted-state structure and operations. Add this model only when a storage diagram materially helps the reader.

```mdx
<DatabaseLens title="Thread storage" stores={{ reviewDb: stores.reviewDb }}>
  <DbUseCase id="resolve" label="Resolve a thread">
    <DbRead from={stores.reviewDb.tables.threads} to={actors.agent}
      label="load open threads" anchor={anchors.loadThreads} />
    <DbWrite from={actors.agent} to={stores.reviewDb.tables.threads}
      label="mark resolved" anchor={anchors.markResolved} />
  </DbUseCase>
</DatabaseLens>
```

- `DatabaseLens` props: `title?`, `stores` (record of `defineStores` refs, required), `height?`. Children: use cases.
- `DbUseCase` props: `id`, `label` (both required), `summary?`. Children: operations.
- `DbRead` props: `from` (store collection ref), `to` (actor ref), `label`, `anchor` (peekable). Children: none.
- `DbWrite` props: `from` (actor ref), `to` (store collection ref), `label`, `anchor` (peekable). Children: none.

Direction is part of the schema: a read flows store → actor, a write flows actor → store. A swapped pair fails validation.

Use a collection reference for an operation on the full collection. Select a specific field directly by name:

```mdx
<DbRead from={stores.reviewDb.tables.threads.body} to={actors.agent}
  label="load thread body" anchor={anchors.loadThreads} />
```

### TraceQuote

Quote one agent-session event; the quote opens the trace at that moment.

```mdx
<TraceQuote sessionId="0a50cd8a-…" event={46}>Keep the fallback at 120x30.</TraceQuote>
```

Props: `sessionId` (required), `event?` (non-negative int hint), `trace?` (subagent trace name). Children: the quoted text.

Publish verifies the children against the session transcript. Read [Trace quoting](trace-quoting.md) for the workflow and quote rules.
