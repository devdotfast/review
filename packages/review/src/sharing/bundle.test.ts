import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { exportShare } from "./export.js";
import { validateShareBundle } from "./import.js";

it("retains the document, images, maps and complete conversations without copying repository files or diff lists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-bundle-"));
  const fixture = await createShareFixture(root);

  try {
    const bundle = await exportShare(fixture);
    const parsed = validateShareBundle(bundle);
    expect(parsed.snapshot.pins).toEqual(
      fixture.store.read(fixture.reviewId).pins,
    );
    expect(bundle.manifest.repository).toEqual(fixture.repository);

    const declared = new Set([
      bundle.manifest.snapshot,
      bundle.manifest.presentation,
      ...bundle.manifest.resources.map((resource) => resource.object),
    ]);

    expect([...bundle.objects.keys()].sort()).toEqual([...declared].sort());
    expect(
      bundle.manifest.resources.map((resource) => resource.kind).sort(),
    ).toEqual(["image", "map", "trace"]);

    const trace = bundle.manifest.resources.find(
      (resource) => resource.kind === "trace",
    )!;

    expect(
      JSON.parse(Buffer.from(bundle.objects.get(trace.object)!).toString())
        .events,
    ).toHaveLength(2);
    expect(Object.keys(parsed.presentation.maps)).toHaveLength(1);
    expect(parsed.presentation).not.toHaveProperty("diffs");
    expect(parsed.presentation).not.toHaveProperty("commits");
    expect(bundle.manifest).not.toHaveProperty("files");
    const corrupt = { ...bundle, objects: new Map(bundle.objects) };
    corrupt.objects.set(bundle.manifest.snapshot, Buffer.from("tampered"));
    expect(() => validateShareBundle(corrupt)).toThrow("corrupt");
  } finally {
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
