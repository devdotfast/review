import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  readDiffrConfig,
  saveDiffrSummarizer,
  setDiffrConfigValue,
  testDiffrSummarizer,
} from "./diffr-config";
import { StructuralComparisons } from "./structural-comparisons";

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const draft = { enabled: true, model: "test-model", tests: true };

async function fakeDiffr(key = "") {
  const root = await mkdtemp(path.join(tmpdir(), "review-diffr-config-"));
  roots.push(root);

  const log = path.join(root, "calls.jsonl"),
    state = path.join(root, "state.json"),
    file = path.join(root, "diffr");

  await writeFile(
    state,
    JSON.stringify({
      plugins: {
        bundled: {
          summarize: {
            enabled: false,
            model: "old",
            tests: false,
            api_key: key,
          },
          context: { lines: 3, enabled: true },
        },
      },
    }),
  );
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)}, log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const config = JSON.parse(fs.readFileSync(state, 'utf8'));
if (args[0] === 'config' && args[1] === 'show') {
  if (!args.includes('--reveal') && config.plugins.bundled.summarize.api_key) config.plugins.bundled.summarize.api_key = '<redacted>';
  console.log(JSON.stringify(config));
} else if (args[0] === 'config' && args[1] === 'set') {
  if (args[2] === process.env.FAIL_KEY) { console.error('command leaked secret: ' + args.join(' ')); process.exit(2); }
  const keys = args[2].split('.'); let object = config;
  for (const part of keys.slice(0,-1)) object = object[part];
  let value = args[3]; try { value = JSON.parse(value); } catch {}
  object[keys.at(-1)] = value;
  fs.writeFileSync(state, JSON.stringify(config));
 } else if (!args.includes('--config')) {
  console.log(JSON.stringify({type:'start',version:4,lhs:{type:'revision',rev:'base'},rhs:{type:'revision',rev:'head'},files:[]}));
  console.log(JSON.stringify({type:'complete',succeeded:0,failed:0}));
} else {
  const temporary = args[args.indexOf('--config') + 1];
  fs.writeFileSync(${JSON.stringify(path.join(root, "test-config"))}, fs.readFileSync(temporary));
  fs.writeFileSync(${JSON.stringify(path.join(root, "test-path"))}, temporary);
  const mode = process.env.TEST_MODE;
  if (mode === 'reject') { console.error(process.env.GEMINI_API_KEY); process.exit(2); }
  if (mode === 'hang') { setTimeout(() => {}, 10000); }
  else {
    const file = {rhs:{path:'after.rs',oid:'',mode:''}};
    console.log(JSON.stringify({type:'annotations',file,annotations:mode === 'empty' ? [] : [{region_id:1,label:'count positive values'}]}));
    console.log(JSON.stringify({type:'complete',succeeded:1,failed:0}));
  }
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("WHITEBOARD_DIFFR_BINARY", file);

  return {
    root,
    state,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

test("reads resolved values and reports credentials without exposing keys", async () => {
  await fakeDiffr("saved-secret");
  vi.stubEnv("GEMINI_API_KEY", "env-secret");
  const config = await readDiffrConfig();
  expect(config.credentialSource).toBe("config");
  expect(JSON.stringify(config)).not.toMatch(
    /saved-secret|env-secret|redacted|api_key/,
  );
});

test("detects host environment credentials and missing credentials", async () => {
  await fakeDiffr();
  expect((await readDiffrConfig()).credentialSource).toBe("missing");
  vi.stubEnv("GOOGLE_API_KEY", "environment-secret");
  expect((await readDiffrConfig()).credentialSource).toBe("environment");
});

test("writes a setting, rereads it, and avoids invalidation for a no-op", async () => {
  await fakeDiffr();
  expect(
    (await setDiffrConfigValue("plugins.bundled.context.lines", 3)).changed,
  ).toBe(false);
  const result = await setDiffrConfigValue("plugins.bundled.context.lines", 8);
  expect(result).toMatchObject({
    changed: true,
    values: { plugins: { bundled: { context: { lines: 8 } } } },
  });
});

test("saves credentials and options before enabling and preserves blank keys", async () => {
  const fake = await fakeDiffr();
  await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  const writes = (await fake.calls()).filter((args) => args[1] === "set");
  expect(writes.map((args) => args[2])).toEqual(
    ["api_key", "model", "tests", "enabled"].map(
      (key) => `plugins.bundled.summarize.${key}`,
    ),
  );
  await saveDiffrSummarizer({ ...draft, apiKey: "" });
  expect(
    JSON.parse(await readFile(fake.state, "utf8")).plugins.bundled.summarize
      .api_key,
  ).toBe("test-secret");
});

test("disables first and serializes concurrent saves", async () => {
  const fake = await fakeDiffr("test-secret");
  await saveDiffrSummarizer(draft);
  await Promise.all([
    saveDiffrSummarizer({ ...draft, enabled: false, model: "next" }),
    setDiffrConfigValue("plugins.bundled.context.lines", 9),
  ]);

  const writes = (await fake.calls())
    .filter((args) => args[1] === "set")
    .slice(-3);

  expect(writes.map((args) => args[2])).toEqual([
    "plugins.bundled.summarize.enabled",
    "plugins.bundled.summarize.model",
    "plugins.bundled.context.lines",
  ]);
});

test("partial failure returns current values and invalidates without leaking the key", async () => {
  await fakeDiffr();
  vi.stubEnv("FAIL_KEY", "plugins.bundled.summarize.model");
  const result = await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  expect(result.changed).toBe(true);
  expect(result.error).toContain("Some settings were saved");
  expect(result.values).toMatchObject({
    plugins: { bundled: { summarize: { enabled: false, model: "old" } } },
  });
  expect(JSON.stringify(result)).not.toContain("test-secret");
});

test("failed key saves do not leak args or stderr and do not invalidate", async () => {
  await fakeDiffr();
  vi.stubEnv("FAIL_KEY", "plugins.bundled.summarize.api_key");
  const result = await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  expect(result.changed).toBe(false);
  expect(result.error).toBeDefined();
  expect(JSON.stringify(result)).not.toMatch(/test-secret|command leaked/);
});

test("cannot enable summaries without credentials", async () => {
  await fakeDiffr();
  expect(await saveDiffrSummarizer(draft)).toMatchObject({
    changed: false,
    error: expect.stringContaining("API key"),
  });
});

test("synthetic test returns a summary without saving and cleans its config", async () => {
  const fake = await fakeDiffr("saved-secret");
  const before = await readFile(fake.state, "utf8");
  expect(await testDiffrSummarizer(draft)).toBe("count positive values");
  expect(await readFile(fake.state, "utf8")).toBe(before);
  expect(
    await readFile(path.join(fake.root, "test-config"), "utf8"),
  ).not.toContain("saved-secret");
  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
});

test("rejected credentials and empty summaries are safe failures with cleanup", async () => {
  const fake = await fakeDiffr();
  vi.stubEnv("TEST_MODE", "reject");
  await expect(
    testDiffrSummarizer({ ...draft, apiKey: "test-secret" }),
  ).rejects.toThrow("Check its configuration and credentials");
  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
  vi.stubEnv("TEST_MODE", "empty");
  await expect(
    testDiffrSummarizer({ ...draft, apiKey: "test-secret" }),
  ).rejects.toThrow("No summary was produced");
});

test("a timed-out test cleans temporary files and releases the single-test guard", async () => {
  const fake = await fakeDiffr("test-secret");
  vi.stubEnv("TEST_MODE", "hang");
  await expect(
    testDiffrSummarizer(draft, undefined, AbortSignal.timeout(300)),
  ).rejects.toThrow("timed out or was cancelled");
  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
  vi.stubEnv("TEST_MODE", "");
  expect(await testDiffrSummarizer(draft)).toBe("count positive values");
});

test("rejects malformed keys and reports missing executables", async () => {
  await expect(async () => setDiffrConfigValue("--flag", true)).rejects.toThrow(
    "Invalid diffr config key",
  );
  vi.stubEnv("WHITEBOARD_DIFFR_BINARY", "/nonexistent/diffr");
  await expect(readDiffrConfig()).rejects.toThrow("Cannot find diffr");
});

test("saved changes invalidate cached comparisons while no-op saves reuse them", async () => {
  const fake = await fakeDiffr();
  const cache = new StructuralComparisons();

  const input = {
    repositoryPath: fake.root,
    comparison: { kind: "trees" as const, base: "base", head: "head" },
    signal: new AbortController().signal,
  };

  async function consume() {
    for await (const event of cache.stream(input))
      expect(event.type).toMatch(/start|complete/);
  }

  try {
    await consume();
    await setDiffrConfigValue("plugins.bundled.context.lines", 3);
    await consume();
    expect(
      (await fake.calls()).filter((args) => args[0] === "--repo"),
    ).toHaveLength(1);
    await setDiffrConfigValue("plugins.bundled.context.lines", 8);
    await consume();
    expect(
      (await fake.calls()).filter((args) => args[0] === "--repo"),
    ).toHaveLength(2);
  } finally {
    cache.close();
  }
});
