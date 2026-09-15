# Authored MDX integration corpus

Run from the repository root:

```sh
pnpm --filter @dev.fast/review build:tutorial-assets
pnpm --filter @dev.fast/review test src/review-authored-corpus.test.ts
```

This suite is included in the ordinary package test command and CI. It does
not require `REVIEW_LEGACY_CORPUS` or access to a developer's Review store.

## Add a document

1. Put the original `review.mdx` and its helper files in a fixture directory.
   Keep public source material unchanged and document its provenance. Only
   include source files that are appropriate to commit to this repository.
2. Provide base/head source directories containing the code its anchors refer
   to. These are complete snapshots: a file omitted from head is a deletion.
   The runner creates disposable Git commits and validates the real ranges.
3. Add an entry to `cases.ts`. No new test function is needed:

```ts
{
  name: "published example PR",
  source: {
    directory: "src/fixtures/authored-reviews/example",
    // Defaults to review.mdx; override document for a differently named file.
    helpers: {
      "data.ts": "data.ts",
      "helpers": "helpers", // A transitive helper directory is copied too.
    },
    baseDirectory: "src/fixtures/authored-reviews/example/base",
    headDirectory: "src/fixtures/authored-reviews/example/head",
  },
  components: ["ReviewSection", "AnchorLink", "CodePeek"],
  text: ["A specific phrase whose preservation matters"],
}
```

`components` is checked against the actual compiled component set, not a
search of the MDX source. Optional `proseTags` declares required
rendered prose tags. The corpus must collectively exercise every registered
authoring component; adding a new component therefore requires a real MDX use.

For an existing public legacy fixture, use
`source: { legacyFixture: "schema4-example" }`. The runner extracts its original
MDX/helpers and compares the newly compiled document with its checked-in
`expected-document.json`, independently of the sealed-JS migration path.
The existing legacy-fixture metadata and CI fetch step supply exact source
commits for repository-backed examples.

## What runs for every entry

- Original MDX and helper compilation with the real compiler.
- Publish evaluation and source-range validation; real Git diffs for call stacks.
- Expected component/prose/text checks and schema-validated JSON disk round-trip.
- Host document hydration.
- A second compile/evaluation with identical document hash.
- For legacy archives, complete equality with existing migration JSON goldens.

These are document-pipeline integration tests. They do not simulate desktop
clicks, agent conversations, or every possible component prop combination.
The existing document example tests separately check rich data values, footnote
rendering, invalid source ranges, and rejection of unsupported/unsafe MDX.

## Current coverage

| Document | Provenance | Main coverage |
| --- | --- | --- |
| Bug-report PR | Unchanged archived public Review | Prose, lists, JSON code block, sections; exact golden parity |
| OpenCode PR | Unchanged archived public Review | Imported actors/anchors, anchor Markdown links, sequence; exact golden parity |
| Legacy tutorial | Unchanged archived public Review | Code peeks, database writes, tutorial controls; exact golden parity |
| Current tutorial | Shipped `tutorial/review.mdx` and helpers | Same interactive component families plus TraceQuote |
| Rich order reference | Purpose-written checked-in MDX fixture | Base/head CallStackDiff, DbRead, field writes, tables, Unicode, unused anchors |
| Markdown reference | Purpose-written checked-in MDX fixture | Every supported prose tag, including images, footnotes, strikethrough, all heading levels and table alignments |

The legacy tutorial archive does not include its historical source repository;
its ranges are validated against the shipped sample-service source. The two
archived PR documents use files read from their exact historical Git pins.
