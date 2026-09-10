import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { structuralDiff } from "./structural-diff";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function executable(script: string) {
  const root = await mkdtemp(path.join(tmpdir(), "review-diffr-test-"));
  roots.push(root);
  const file = path.join(root, "diffr");
  await writeFile(file, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv("REVIEW_DIFFR_BINARY", file);
  return root;
}

test("reads chunked NDJSON and sends Review's merge-base comparison as one argument", async () => {
  const root = await executable(`
    process.stdout.write('{"type":"start","version":1}\\n{"type":"fi');
    setTimeout(() => {
      process.stdout.write('le","args":' + JSON.stringify(process.argv.slice(2)) + '}\\n');
      process.stdout.write('{"type":"complete","succeeded":1,"failed":0}\\n');
    }, 5);
  `);
  const result = await structuralDiff({
    rootPath: root,
    baseRef: "base",
    headRef: "head",
    paths: ["space name.ts"],
  });
  expect(result.events[1]).toEqual({
    type: "file",
    args: [
      "--repo",
      root,
      "--format",
      "ndjson",
      "base...head",
      "--",
      "space name.ts",
    ],
  });
});

test("rejects a successful process that truncates its stream", async () => {
  const root = await executable(
    `console.log(JSON.stringify({ type: "start", version: 1 }));`,
  );
  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("before completion");
});

test("propagates per-file errors instead of silently showing a different diff", async () => {
  const root = await executable(
    `console.log('{"type":"start","version":1}\\n{"type":"file_error","message":"parse failed"}');`,
  );
  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("parse failed");
});

test("cancellation terminates the subprocess", async () => {
  const root = await executable(`setInterval(() => {}, 1000);`);
  await expect(
    structuralDiff({
      rootPath: root,
      baseRef: "base",
      signal: AbortSignal.timeout(50),
    }),
  ).rejects.toThrow();
});
