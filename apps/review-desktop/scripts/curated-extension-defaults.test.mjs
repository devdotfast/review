import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsPage = await readFile(
  new URL(
    "../../../packages/review/app/src/settings-page.tsx",
    import.meta.url,
  ),
  "utf8",
);

const reviewReadme = await readFile(
  new URL("../README.md", import.meta.url),
  "utf8",
);

test("explains optional extension consent and toolchain requirements", () => {
  assert.match(settingsPage, /Install or turn on language extensions\./);
  assert.match(reviewReadme, /Rust moved from bundled to optional\./);
  assert.match(reviewReadme, /Install a Swift toolchain/);
  assert.match(reviewReadme, /Install a system \.NET SDK/);
  assert.match(reviewReadme, /Review does not download \.NET\./);
  assert.match(reviewReadme, /only after the user selects it/);
  assert.match(
    reviewReadme,
    /updates installed optional groups to the catalog pins/,
  );
});
