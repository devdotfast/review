# Document authoring

## Reader contract

The reader sees the original user request and the Review document. The reader does not see agent reasoning or the implementation session.

The H1 is the review's display title in Review Desktop tabs and Home. Write a short, specific title for the change (for example, "Publish pipeline: single mount"), not a generic one. Publishing syncs the title. Use progressive disclosure: short prose first, then details that earn their cost. Typical useful sections are interface change, lifecycle/data flow, state/storage, and testing evidence. Write in ASD-STE100 Simplified Technical English (STE).

Assume raw prose will confuse the reader. Spend substantial reasoning effort deciding what to omit, rather than what to include; deep analysis followed by a small amount of clear output text is the correct tradeoff. Start brief and add resolution only where it earns the reader's attention; the reader's time and attention are incredibly expensive and thus every word you put out taxes and pains them. Your job is to not waste that time. Think about the style of RFCs from great tech leaders like Russ Cox, Dave Cheney, and the early React RFCs.

Remember that the reader can ONLY see the 'user' prompts _before_ coding started and the document you write to explain what changed. This means jargon in the middle - references to specific parts of code, especially any and all abstractions, changes, and code referenced _during_ the editing process - is confusing and not helpful. More words do not help. Progressive disclosure of complexity is key.

Open the document with a landing section after the H1 and before the first H2. Be concise.

**Summary** 
- short bullet points that summarize the change, for example:
- comment peeks now open in the real diff editor, not a stitched-together fake buffer
- both diff sides are actual files on disk, so imports and go-to-definition just work
- comments stick to real lines — deleted ones included

**Why**
A couple short sentences about: What problem does this change solve? (What problem(s) is this change not trying to solve?) For a bugfix, this can be what was wrong before; for a new feature, this can be what this adds. Capture the intent behind the pr using the developer's own prompts, if those are available to you (either through associated agent trace sessions, or your own context window, if you have the implementation session in context.)

After the landing section, use fewer than five further sections when practical. Choose the sections that fit this change. Good section choices are:

- requirements
- design
- interface change
- lifecycle or data flow
- state or storage
- testing evidence
- decision log

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

Read each range from the correct pinned checkout before you add it:

- Use the head checkout (`sourceCommit`) for a head range.
- Use the base checkout (`baseCommit`) for a base range.

Use the smallest range that proves the claim. Default to `AnchorLink` for source evidence. Use `CodePeek` only when readers must see the code inline to understand the main claim. A path outside the pinned checkout or an invalid line range blocks document publication.

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

Document-local React components are unsupported: they cannot cross the published JSON data boundary. Use the built-in components below instead.

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
