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

const START =
  '{"type":"start","version":3,"lhs":{"type":"revision","rev":"base"},"rhs":{"type":"revision","rev":"head"},"files":[]}';

const FILE =
  '{"lhs":{"path":"a.ts","oid":"1","mode":"100644"},"rhs":{"path":"a.ts","oid":"2","mode":"100644"}}';

test("reads chunked NDJSON and sends Review's merge-base comparison as one argument", async () => {
  const root = await executable(`
    process.stdout.write('${START}\\n{"type":"fi');
    setTimeout(() => {
      process.stdout.write('le","file":${FILE},"args":' + JSON.stringify(process.argv.slice(2)) + '}\\n');
      process.stdout.write('{"type":"complete","succeeded":1,"failed":0}\\n');
    }, 5);
  `);

  const result = await structuralDiff({
    rootPath: root,
    baseRef: "base",
    headRef: "head",
    paths: ["space name.ts"],
  });

  expect(result.events[1]).toMatchObject({
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

test("rejects an older wire version", async () => {
  const root = await executable(
    `console.log('{"type":"start","version":1}\\n{"type":"complete","succeeded":0,"failed":0}');`,
  );

  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("Unsupported diffr stream protocol");
});

test("rejects a successful process that truncates its stream", async () => {
  const root = await executable(`console.log('${START}');`);
  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("before completion");
});

test("propagates per-file errors instead of silently showing a different diff", async () => {
  const root = await executable(
    `console.log('${START}\\n{"type":"file","file":${FILE},"error":{"code":"parse_error","message":"parse failed"}}');`,
  );

  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("parse failed");
});

test("an aborted run keeps the files it emitted and reports the abort", async () => {
  const root = await executable(`
    console.log('${START}');
    console.log('{"type":"file","file":${FILE},"diff":{"type":"binary","lhs":{"size":1},"rhs":{"size":2}}}');
    console.log('{"type":"complete","succeeded":1,"failed":0,"aborted":{"code":"hook_failed","message":"summarizer down"}}');
    process.exit(2);
  `);

  await expect(
    structuralDiff({ rootPath: root, baseRef: "base" }),
  ).rejects.toThrow("summarizer down");
  const forwarded: unknown[] = [];
  await structuralDiff({
    rootPath: root,
    baseRef: "base",
    onEvent: (event) => forwarded.push(event),
  });
  expect(forwarded.map((event) => (event as { type: string }).type)).toEqual([
    "start",
    "file",
    "complete",
  ]);
  expect(forwarded[2]).toMatchObject({ aborted: { code: "hook_failed" } });
});

test("a streamed run with a failed file resolves despite exit 2", async () => {
  const root = await executable(`
    console.log('${START}');
    console.log('{"type":"file","file":${FILE},"error":{"code":"read_failed","message":"binary"}}');
    console.log('{"type":"complete","succeeded":0,"failed":1}');
    process.exit(2);
  `);

  const forwarded: unknown[] = [];
  await structuralDiff({
    rootPath: root,
    baseRef: "base",
    onEvent: (event) => forwarded.push(event),
  });
  expect(forwarded).toHaveLength(3);
});

test("exit 2 without failed files is still an error", async () => {
  const root = await executable(`
    console.log('${START}');
    console.log('{"type":"complete","succeeded":0,"failed":0}');
    process.exit(2);
  `);

  await expect(
    structuralDiff({ rootPath: root, baseRef: "base", onEvent: () => {} }),
  ).rejects.toThrow("exited with 2");
});

test("cancellation terminates the subprocess", async () => {
  const root = await executable(`setInterval(() => {}, 1000);`);
  await expect(
    structuralDiff({
      rootPath: root,
      baseRef: "base",
      signal: AbortSignal.timeout(50),
    }),
  ).rejects.toThrow(/abort|exited/i);
});
