import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { traceSchema } from "../session-api/trace-schema.js";
import { digestBytes, exportShare } from "./export.js";
import { validateShareBundle } from "./import.js";

it("retains the document, images, maps and complete conversations without copying repository files or diff lists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-bundle-"));
  const fixture = await createShareFixture(root);

  try {
    const bundle = await exportShare(fixture);
    const parsed = validateShareBundle(bundle);
    expect(parsed.snapshot.pins).toEqual(
      fixture.store.read(fixture.sessionId).pins,
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

it("checks every quote in a reused trace and rejects duplicate event IDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-quotes-"));
  const fixture = await createShareFixture(root);

  try {
    const bundle = await exportShare(fixture);
    const parsed = validateShareBundle(bundle);

    const resource = bundle.manifest.resources.find(
      (item) => item.kind === "trace",
    )!;

    await fixture.store.execute({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        sessionId: fixture.sessionId,
        edit: {
          type: "insert",
          content: {
            type: "trace_quote",
            traceId: resource.id,
            eventId: "request",
            text: "Please compute the answer.",
          },
        },
      },
    });
    const repeated = await exportShare(fixture);
    expect(
      validateShareBundle(repeated).snapshot.document.length,
    ).toBeGreaterThan(parsed.snapshot.document.length);

    const trace = traceSchema.parse(
      JSON.parse(
        Buffer.from(repeated.objects.get(resource.object)!).toString(),
      ),
    );

    const replaceTrace = () => {
      const bytes = Buffer.from(JSON.stringify(trace));
      const id = digestBytes(bytes);

      return {
        ...repeated,
        objects: new Map(
          [...repeated.objects].map(([key, value]) =>
            key === resource.object ? [id, bytes] : [key, value],
          ),
        ),
        manifest: {
          ...repeated.manifest,
          objects: repeated.manifest.objects.map((object) =>
            object.id === resource.object
              ? { id, sha256: id, size: bytes.length }
              : object,
          ),
          resources: repeated.manifest.resources.map((item) =>
            item.object === resource.object ? { ...item, object: id } : item,
          ),
        },
      };
    };

    trace.events[0]!.text = "Different request";
    expect(() => validateShareBundle(replaceTrace())).toThrow(
      "quote does not match",
    );
    trace.events[0]!.text = "Please compute the answer.";
    trace.events.push({ ...trace.events[0]! });
    expect(() => validateShareBundle(replaceTrace())).toThrow(
      "Duplicate shared trace event",
    );
  } finally {
    await fixture.data.close();
    fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("imports old published source links once without modifying the sealed bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-old-links-"));
  const fixture = await createShareFixture(root);

  try {
    const bundle = await exportShare(fixture);

    const snapshot = JSON.parse(
      Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
    );

    snapshot.document.push({
      type: "markdown",
      id: "old-link",
      markdown: "[answer](review-source:head/answer.ts#L2)",
    });
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const id = digestBytes(bytes);
    const old = bundle.manifest.snapshot;
    bundle.objects.delete(old);
    bundle.objects.set(id, bytes);
    bundle.manifest.snapshot = id;
    bundle.manifest.objects = bundle.manifest.objects.map((object) =>
      object.id === old ? { id, sha256: id, size: bytes.length } : object,
    );
    const imported = validateShareBundle(bundle);
    expect(imported.snapshot.document.at(-1)).toMatchObject({
      markdown: "[answer](whiteboard-source:head/answer.ts#L2)",
    });
    expect(Buffer.from(bundle.objects.get(id)!).toString()).toContain(
      "review-source:",
    );
    expect(validateShareBundle(bundle).snapshot).toEqual(imported.snapshot);
  } finally {
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
