import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("software map bundle", () => {
  it("writes independent head and base modules with pinned commits", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-map-bundle-"));
    const head = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const base = defineSoftwareMap({ systems: { api: { label: "API" } } });
    const bundle = bundleReviewSoftwareMap({
      head,
      base,
      headCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
    });

    await writeReviewSoftwareMapBundle(directory, bundle);

    await expect(readReviewSoftwareMapBundle(directory)).resolves.toEqual(
      bundle,
    );
    await expect(
      readFile(
        path.join(directory, REVIEW_SOFTWARE_MAP_BUNDLE_DIR, "head-map.js"),
        "utf8",
      ),
    ).resolves.toContain("elementsByPath = new Map");
  });
});
