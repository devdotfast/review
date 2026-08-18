/**
 * Keeps the ported telemetry cleaner honest about its origin.
 *
 * `packages/progressive-review/src/telemetry-clean-text.ts` is a copy of four
 * functions from `code-oss/src/vs/platform/telemetry/common/telemetryUtils.ts`.
 * It is a copy rather than an import because all three routes to importing it
 * are closed:
 *
 *   1. `apps/review-desktop` already depends on `@dev.fast/review`, so importing
 *      back the other way is a cycle.
 *   2. `@dev.fast/review` is published to npm, so it cannot reference a path
 *      that exists only inside this repository.
 *   3. `anonymizeFilePaths` and `removePropertiesWithPossibleUserInfo` are not
 *      exported upstream, and the module that holds them pulls in localization,
 *      the configuration service and the product service — the whole dependency
 *      injection graph — which a plain Node server cannot load. Exporting them
 *      would mean editing an otherwise untouched upstream file.
 *
 * The cost of a copy is drift: upstream tightens a rule, and our copy quietly
 * keeps the old one. This test pins a digest of the upstream source of each
 * copied function. When a code-oss update changes any of them the digest moves
 * and this fails, which is the prompt to re-read the upstream change and decide
 * whether the copy should follow it.
 *
 * It deliberately does NOT compare the two implementations. The copy has
 * reviewed deviations, listed in its own header, and asserting equality would
 * either forbid them or have to encode them twice.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UPSTREAM = fileURLToPath(
  new URL(
    "../code-oss/src/vs/platform/telemetry/common/telemetryUtils.ts",
    import.meta.url,
  ),
);
const COPY = fileURLToPath(
  new URL(
    "../../../packages/progressive-review/src/telemetry-clean-text.ts",
    import.meta.url,
  ),
);

/**
 * The upstream declarations the copy is derived from. Each is read from its
 * opening line to the first line that closes it at column zero, which is the
 * shape every declaration in this file has.
 */
const COPIED_DECLARATIONS = [
  "function anonymizeFilePaths(",
  "const userDataRegexes = [",
  "function redactIfPossibleUserInfo(",
  "function removePropertiesWithPossibleUserInfo(",
];

/**
 * Digest of those declarations in the vendored tree today.
 *
 * When this fails: read the upstream diff for the functions named above, decide
 * whether the change belongs in the copy, apply it (or record why not in the
 * copy's "DEVIATIONS FROM UPSTREAM" list), then update this digest.
 */
const PINNED_DIGEST = "f376bd10a4aeb50f240c9e948f204262";

function extractDeclaration(source, opening) {
  const start = source.indexOf(`\n${opening}`);
  assert.notEqual(
    start,
    -1,
    `Could not find "${opening}" in telemetryUtils.ts. Upstream renamed or removed it, so the copy in telemetry-clean-text.ts needs a fresh look.`,
  );
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:\}|\];)\n/);
  assert.notEqual(end, -1, `Could not find the end of "${opening}".`);
  return rest.slice(0, end);
}

/** Comments and blank space move for reasons that do not change behaviour. */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

test("the copied telemetry cleaner still matches the upstream it was taken from", () => {
  const upstream = readFileSync(UPSTREAM, "utf8");
  const digest = createHash("sha256")
    .update(
      COPIED_DECLARATIONS.map((opening) =>
        normalize(extractDeclaration(upstream, opening)),
      ).join("\n"),
    )
    .digest("hex")
    .slice(0, 32);

  assert.equal(
    digest,
    PINNED_DIGEST,
    "The upstream telemetry cleaner changed. Re-read it and decide whether packages/progressive-review/src/telemetry-clean-text.ts should follow, then update PINNED_DIGEST in this file.",
  );
});

test("the copy still records where it came from", () => {
  // A copy that loses its provenance comment is a copy nobody can audit.
  const copy = readFileSync(COPY, "utf8");
  assert.match(
    copy,
    /telemetryUtils\.ts/,
    "telemetry-clean-text.ts must keep naming the upstream file it was ported from",
  );
  assert.match(
    copy,
    /DEVIATIONS FROM UPSTREAM/,
    "telemetry-clean-text.ts must keep its list of deliberate differences from upstream",
  );
});
