import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonValue } from "@dev.fast/json";
import { afterEach, expect, test, vi } from "vitest";

import {
  type StructuralDiffRequest,
  applyBundledDiffrBinary,
  bundledDiffrBinary,
  structuralDiff,
} from "./structural-diff";

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

const START = {
  type: "start",
  version: 4,
  lhs: { type: "revision", rev: "base" },
  rhs: { type: "revision", rev: "head" },
  files: [
    {
      file: { rhs: { path: "a.ts", oid: "2", mode: "100644" } },
      status: "added",
    },
  ],
};

const FILE = { rhs: { path: "a.ts", oid: "2", mode: "100644" } };

const BINARY = {
  type: "file",
  file: FILE,
  diff: { type: "binary", rhs: { size: 2 } },
};

const COMPLETE = { type: "complete", succeeded: 1, failed: 0 };

const emit = (event: JsonValue) =>
  `console.log(${JSON.stringify(JSON.stringify(event))});`;

const request = (
  root: string,
  overrides: Partial<StructuralDiffRequest> = {},
): StructuralDiffRequest => ({
  repositoryPath: root,
  comparison: { kind: "trees", base: "base", head: "head" },
  signal: new AbortController().signal,
  ...overrides,
});

async function collect(input: StructuralDiffRequest) {
  const events = [];

  for await (const event of structuralDiff(input)) events.push(event);

  return events;
}

test.each(["trees", "merge-base"] as const)(
  "passes %s comparison and paths without shell interpretation",
  async (kind) => {
    const root = await executable(`
    require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
    ${emit(START)} ${emit(COMPLETE)}
  `);

    await collect(
      request(root, {
        comparison: { kind, base: "base", head: "head" },
        paths: ["space name.ts"],
      }),
    );
    expect(
      JSON.parse(await readFile(path.join(root, "args.json"), "utf8")),
    ).toEqual([
      "--repo",
      root,
      "--format",
      "ndjson",
      "--stream-annotations",
      ...(kind === "trees" ? ["base", "head"] : ["base...head"]),
      "--",
      "space name.ts",
    ]);
  },
);

test("yields records before process completion and joins split chunks", async () => {
  const root = await executable(`
    ${emit(START)}
    process.stdout.write(${JSON.stringify(JSON.stringify(BINARY).slice(0, 20))});
    setTimeout(() => { process.stdout.write(${JSON.stringify(JSON.stringify(BINARY).slice(20) + "\n")}); }, 5);
    const timer = setInterval(() => { if(require('node:fs').existsSync('continue')) { clearInterval(timer); ${emit(COMPLETE)} } }, 10);
  `);

  const iterator = structuralDiff(request(root));
  expect((await iterator.next()).value?.type).toBe("start");
  expect((await iterator.next()).value).toEqual(BINARY);
  await writeFile(path.join(root, "continue"), "");
  expect((await iterator.next()).value).toEqual(COMPLETE);
  expect((await iterator.next()).done).toBe(true);
});

test("yields file errors and continues to successful files, accepting exit 2", async () => {
  const error = {
    type: "file",
    file: FILE,
    error: { code: "read_failed", message: "unreadable" },
  };

  const root = await executable(
    `${emit(START)} ${emit(error)} ${emit(BINARY)} ${emit({ ...COMPLETE, failed: 1 })} process.exitCode = 2;`,
  );

  expect(await collect(request(root))).toEqual([
    START,
    error,
    BINARY,
    { ...COMPLETE, failed: 1 },
  ]);
});

test("yields an aborted completion without discarding prior files", async () => {
  const complete = {
    ...COMPLETE,
    aborted: { code: "hook_failed", message: "summarizer down" },
  };

  const root = await executable(
    `${emit(START)} ${emit(BINARY)} ${emit(complete)} process.exitCode = 2;`,
  );

  expect(await collect(request(root))).toEqual([START, BINARY, complete]);
});

test.each([
  [emit({ ...START, version: 1 }), "Unsupported diffr stream protocol"],
  [emit(START), "before completion"],
  [
    `${emit(START)} ${emit({ type: "file", file: FILE })}`,
    "Malformed diffr protocol record",
  ],
  [`${emit(START)} ${emit(COMPLETE)} ${emit(BINARY)}`, "after completion"],
  [`${emit(START)} ${emit(START)}`, "Unexpected diffr event"],
  [`${emit(START)} ${emit(COMPLETE)} process.exitCode = 2;`, "exited with 2"],
])("rejects invalid or incomplete streams", async (script, message) => {
  const root = await executable(script);
  await expect(collect(request(root))).rejects.toThrow(message);
});

test("reports launch failures", async () => {
  const root = await executable("");
  vi.stubEnv("REVIEW_DIFFR_BINARY", path.join(root, "missing"));
  await expect(collect(request(root))).rejects.toThrow("Cannot find diffr");
});

test("cancellation terminates the subprocess", async () => {
  const root = await executable(`setInterval(() => {}, 1000);`);
  await expect(
    collect(request(root, { signal: AbortSignal.timeout(50) })),
  ).rejects.toThrow(/abort|exited/i);
});

test("breaking iteration terminates a producer that has not finished", async () => {
  const root = await executable(`${emit(START)} setInterval(() => {}, 1000);`);

  for await (const event of structuralDiff(request(root))) {
    expect(event.type).toBe("start");
    break;
  }
});

test("rendering and coverage share a stream; cancelling one reader preserves the other and completion is replayed", async () => {
  const { StructuralComparisons, invalidateStructuralComparisons } =
    await import("./structural-comparisons.js");

  const root = await executable(`
    require('node:fs').appendFileSync('runs', 'x');
    ${emit(START)}
    setTimeout(() => { ${emit(BINARY)} ${emit(COMPLETE)} }, 80);
  `);

  const cache = new StructuralComparisons();
  const abort = new AbortController();
  const first = cache.stream(request(root, { signal: abort.signal }));
  const second = cache.stream(request(root));

  try {
    const [a, b] = await Promise.all([first.next(), second.next()]);
    expect(a.value).toEqual(START);
    expect(b.value).toEqual(START);
    abort.abort();
    await expect(first.next()).rejects.toThrow("aborted");
    const tail = [];

    for await (const event of second) tail.push(event);
    expect(tail).toEqual([BINARY, COMPLETE]);
    const replay = [];

    for await (const event of cache.stream(request(root))) replay.push(event);
    expect(replay).toEqual([START, BINARY, COMPLETE]);
    expect(await readFile(path.join(root, "runs"), "utf8")).toBe("x");
    invalidateStructuralComparisons();

    for await (const _event of cache.stream(request(root))) {
      /* drain changed settings */
    }

    expect(await readFile(path.join(root, "runs"), "utf8")).toBe("xx");
  } finally {
    cache.close();
  }
});

test("annotation failure is data, preserves files, and explains exit 2", async () => {
  const annotation = {
    type: "annotations",
    file: FILE,
    annotations: [],
    error: { code: "enrichment_failed", message: "offline" },
  };

  const root = await executable(
    `${emit(START)} ${emit(BINARY)} ${emit(annotation)} ${emit(COMPLETE)} process.exitCode = 2;`,
  );

  expect(await collect(request(root))).toEqual([
    START,
    BINARY,
    annotation,
    COMPLETE,
  ]);
});

test("coverage can detach after initial files while summaries continue for later readers", async () => {
  const { StructuralComparisons } = await import("./structural-comparisons.js");

  const annotation = {
    type: "annotations",
    file: FILE,
    annotations: [{ region_id: 1, label: "summary" }],
  };

  const root = await executable(`
    require('node:fs').appendFileSync('runs', 'x');
    ${emit(START)} ${emit(BINARY)}
    const timer = setInterval(() => { if(require('node:fs').existsSync('continue')) { clearInterval(timer); ${emit(annotation)} ${emit(COMPLETE)} } }, 10);
  `);

  const cache = new StructuralComparisons();

  try {
    for await (const event of cache.stream(request(root)))
      if (event.type === "file") break;
    await writeFile(path.join(root, "continue"), "");
    const events = [];

    for await (const event of cache.stream(request(root))) events.push(event);
    expect(events).toEqual([START, BINARY, annotation, COMPLETE]);
    expect(await readFile(path.join(root, "runs"), "utf8")).toBe("x");
  } finally {
    cache.close();
  }
});

test("uses the bundled binary only when present and no override is set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-bundled-diffr-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {};
  applyBundledDiffrBinary(root, env);
  expect(env.REVIEW_DIFFR_BINARY).toBeUndefined();

  await mkdir(path.join(root, "bin"));
  const binary = path.join(root, "bin", "diffr");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
  expect(bundledDiffrBinary(root)).toBe(binary);
  applyBundledDiffrBinary(root, env);
  expect(env.REVIEW_DIFFR_BINARY).toBe(binary);

  env.REVIEW_DIFFR_BINARY = "/elsewhere/diffr";
  applyBundledDiffrBinary(root, env);
  expect(env.REVIEW_DIFFR_BINARY).toBe("/elsewhere/diffr");
});
