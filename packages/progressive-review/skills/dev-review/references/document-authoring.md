# Document authoring

## Reader contract

The reader sees the original user request and the Review document. The reader does not see agent reasoning or the implementation session.

The H1 is the review's display title in Review Desktop tabs and Home. Write a short, specific title for the change (for example, "Publish pipeline: single mount"), not a generic one. Use progressive disclosure: short prose first, then details that earn their cost. Write in ASD-STE100 Simplified Technical English (STE).

Assume raw prose will confuse the reader. Think about the style of RFCs from great tech leaders like Russ Cox, Dave Cheney, and the early React RFCs.

Remember that the reader can ONLY see the 'user' prompts _before_ coding started and the document you write to explain what changed. This means jargon in the middle - references to specific parts of code, especially any and all abstractions, changes, and code referenced _during_ the editing process - is confusing and not helpful. More words do not help. Progressive disclosure of complexity is key.

You are optimizing for human readership here; humans prefer, in order:
 1. interactive diagrams to explain context
 2. code examples
 3. text

Raw text should almost always be accompanied by (1) or (2).

If you have context on the change already in previous chat history, there's almost no reason to do extra exploration - go straight into authoring. Just make sure to attach examples to your claims.

Open the document with a landing section after the H1 and before the first H2. Be concise; this section should just be *quotes from the prompt behind the change* (either through associated agent trace sessions, or your own context window, if you have the implementation session in context.)

**Summary** - *What* behavior was changed
- if possible, show this through visuals, links, etc
- keep max ~5 bullet points. 1 is best and indicates a clean PR.

**Why**
A couple short sentences about: What problem does this change solve? (What problem(s) is this change not trying to solve?) For a bugfix, this can be what was wrong before; for a new feature, this can be what this adds. 

After the landing section, use fewer than five further sections when practical. Choose the sections that fit this change. Good section choices are:

- requirements
  - best expressed via links to trace
- design
  - best expressed via decision log w/ diagram or code examples w/ links to trace
- interface change
  - best expressed through links to code w/ example usage
- lifecycle or data flow
  - obviously best expressed via diagram (sequence + state diagram)
- state or storage
  - database diagram
- testing evidence
  - do:
    - reference what is tested via integration-style or E2E tests via pseudocode.
      - generally, it is wise here to skip noting unit tests
    - add links to decisions etc. that are relevant here (e.g. explicit user guidance on what to test)
  - do not:
    - run tests or linters.
    - "xxx/yyy tests are passing" (overwhelming without giving information; CI being green is enough).

Add implementation detail only when it helps the reader check an important claim.

In the decision log, preserve important user requirements in the user's language. Add significant implementation decisions that affect the result.

When the change has synced agent sessions, build the landing, requirements, design, and decision-log sections from trace quotes. Read [Trace quoting](trace-quoting.md) for the workflow and rules. Without sessions, the same structure holds in authored prose.

Do not invent user-impact risks. Ask the user when risk depends on product usage that you do not know.

## File ownership

Agents can edit only these Review files:

- `review.mdx` is the presentation layer.
- `data.ts` contains typed document inputs.

Do not edit `review.json`, `review.db`, `.bundle/`, `.build/`, or the private Review `.git/` directory.

Do not import runtime values from source repository files. Put document data in `data.ts`.

## Source ranges

Scaffold creates one pinned checkout per pinned commit and prints both paths in its JSON event, under `checkouts.head` and `checkouts.base`. Read the paths from that output. Do not derive them from the repository layout. When you have no scaffold output, the layout is `<git-common-dir>/dev-fast/reviews/<review-uuid>/{head,base}/<full-commit>/`; resolve the common dir with `git rev-parse --git-common-dir` in the source worktree.

1. (OPTIONAL; SKIP IF THIS IS THE SAME SESSION THAT AUTHORED THE CHANGE): **Load the change into your context window**
   - Typically involves batched commands; utilize code mode + parallel subagents to minimize the number of tool calls.
2. **Decide on the evidence that you want to show**
3. **For locations where you can't remember specific line numbers, search for code locations to match your chosen examples/anchors.**
   - Utilize batching to minimize tool calls / code-mode + parallelism (e.g. via subagents) to speed things up.
   - *IMPORTANT*: when at all possible, use `ast-grep` (on PATH) vs. vanilla grep, reading files (e.g. via sed/cat), or counting line ranges. 'sed, grep, cat' are slow and ill-fitted to this use-case (finding starting/closing brackets of code snippets).
      - match the declaration or the exact node you're citing and take `fromLine`/`toLine` from `range.start.line`/`range.end.line` in `--json` output
      - ast-grep's `range.*.line` is 0-based (vs. the 1-based index of `fromLine`/`toLine`)
      - Resolve all anchors in as few calls as possible.
      - because ast-grep gives you the end lines inline you can effectively batch calls and reduce total number of turns

Remember that a review has two pinned checkouts (base checkout, or `baseCommit`, and head checkout, or `sourceCommit`). Depending on the anchor/code ref you may need to be specific about one side or the other.

If code context is already in your context window (e.g. file/symbols), leverage that information to avoid extraneous searches.

Default to `AnchorLink` or `CodePeek` for source evidence (prefer `AnchorLink`, with `CodePeek` superior for examples which are best demonstrated via code, e.g. an API change). A path outside the pinned checkout blocks document publication.

## Authoring API (data.ts)

Import typed helpers from `virtual:progressive-review-authoring` in `data.ts`:

```ts
import {
  defineActors,
  defineAnchors,
  defineStores,
} from "virtual:progressive-review-authoring";
```

Read [Component API](component-api.md) for every helper's input shape and every component's props, with one example each.

Do not use casts, `any`, `<Participant>`, or `<Message>`. Pass typed references from these helpers to the MDX components.

## Public MDX components (review.mdx)

Review supplies these built-in components to MDX. Do not import them. Import only authored values from `./data.ts`.

Use these built-in components:

| Component         | Use                                                    |
| ----------------- | ------------------------------------------------------ |
| `CodePeek`        | Show one anchor with an exact source range inline.     |
| `AnchorLink`      | Link prose to an anchored source range in side peek.   |
| `SequenceDiagram` | Show important temporal behavior.                      |
| `CallStackDiff`   | Show call-flow differences between base and head.      |
| `DatabaseLens`    | Show persisted-state structure and operations.         |
| `DbUseCase`       | Group related database operations.                     |
| `DbRead`          | Show a read between typed actor or store references.   |
| `DbWrite`         | Show a write between typed actor or store references.  |
| `ReviewSection`   | Collapse optional detail.                              |
| `TraceQuote`      | Quote and link directly to an agent execution session. |

Write diagram inputs in `data.ts`. Component validation is strict. Read [Component API](component-api.md) for each component's props, rules, and a minimal example. Read [Trace quoting](trace-quoting.md) for the `TraceQuote` workflow, rules, and per-section density.

## Small example

`data.ts`:

```ts
import {
  defineActors,
  defineAnchors,
} from "virtual:progressive-review-authoring";

export const actors = defineActors({
  agent: { label: "Agent" },
  desktop: { label: "Desktop" },
});

export const anchors = defineAnchors({
  publish: {
    title: "Publish document",
    peek: { file: "src/publish.ts", fromLine: 40, toLine: 66 },
  },
});

export const messages = [
  {
    from: actors.agent,
    to: actors.desktop,
    label: "Publish document",
    anchor: anchors.publish,
  },
];
```

`review.mdx`:

```mdx
import { anchors, messages } from "./data.ts";

# Document publication

The CLI seals one document revision.

See <AnchorLink anchor={anchors.publish}>the publish implementation</AnchorLink> for evidence.

<SequenceDiagram label="Publish" messages={messages} />
```

## Publication checks

Run `review publish --review <uuid> --json`. Do not run `npm test` against the private Review directory. The publish command supplies the correct private test command and returns document diagnostics as NDJSON events.
