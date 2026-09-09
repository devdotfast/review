import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEW_SOFTWARE_MAP_BUNDLE_DIR,
  SOFTWARE_MAP_ARTIFACT_FORMAT,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  sameReviewSoftwareMapBundle,
  softwareMapArtifactBytes,
  softwareMapBundleFromArtifact,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import {
  defineSoftwareMap,
  hydrateSoftwareModel,
  softwareModelDataSchema,
} from "./software-map-model";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("software map bundle", () => {
  it("writes head and base maps as JSON and reads them back", async () => {
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

    const read = await readReviewSoftwareMapBundle(directory);
    expect(read).toEqual(bundle);
    const headFile = JSON.parse(
      await readFile(
        path.join(directory, REVIEW_SOFTWARE_MAP_BUNDLE_DIR, "head-map.json"),
        "utf8",
      ),
    );
    expect(headFile.format).toBe("software-map/1");
    expect(headFile.elements.map((e: { path: string }) => e.path)).toEqual(
      head.elements.map((e) => e.path),
    );
    expect(
      hydrateSoftwareModel(
        softwareModelDataSchema.parse({
          elements: jsonObject(parseJsonText(read!.headJson))?.elements,
          relationships: jsonObject(parseJsonText(read!.headJson))
            ?.relationships,
        }),
      ).elementsByPath.get("app"),
    ).toEqual(head.elementsByPath.get("app"));
    expect(sameReviewSoftwareMapBundle(read!, bundle)).toBe(true);
  });

  it("returns null for a version-1 (JavaScript) bundle", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-map-bundle-"));
    const bundleDir = path.join(directory, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        headCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
      }),
    );
    await writeFile(path.join(bundleDir, "head-map.js"), "export default {}");
    await writeFile(path.join(bundleDir, "base-map.js"), "export default {}");

    await expect(readReviewSoftwareMapBundle(directory)).resolves.toBeNull();
  });
});

describe("software map artifact envelope", () => {
  it("round trips headJson/baseJson byte-for-byte and matches the bundle's contentHash", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-map-artifact-"));
    const head = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const base = defineSoftwareMap({ systems: { api: { label: "API" } } });
    const bundle = bundleReviewSoftwareMap({
      head,
      base,
      headCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
    });
    await writeReviewSoftwareMapBundle(directory, bundle);
    const fromDisk = await readReviewSoftwareMapBundle(directory);

    const bytes = softwareMapArtifactBytes(bundle);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(JSON.parse(bytes).format).toBe(SOFTWARE_MAP_ARTIFACT_FORMAT);

    const roundTripped = softwareMapBundleFromArtifact(bytes);
    expect(roundTripped?.headJson).toBe(bundle.headJson);
    expect(roundTripped?.baseJson).toBe(bundle.baseJson);
    expect(roundTripped?.headCommit).toBe(bundle.headCommit);
    expect(roundTripped?.baseCommit).toBe(bundle.baseCommit);
    expect(roundTripped?.contentHash).toBe(fromDisk?.contentHash);
  });

  it("returns null for malformed or incompatible envelope bytes", () => {
    expect(softwareMapBundleFromArtifact("not json")).toBeNull();
    expect(
      softwareMapBundleFromArtifact(JSON.stringify({ format: "other/1" })),
    ).toBeNull();
    expect(
      softwareMapBundleFromArtifact(
        JSON.stringify({
          format: SOFTWARE_MAP_ARTIFACT_FORMAT,
          headCommit: "a".repeat(40),
          baseCommit: "b".repeat(40),
          headJson: "not json",
          baseJson: "{}",
        }),
      ),
    ).toBeNull();
  });
});
