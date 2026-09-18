import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { readDiffrConfig, setDiffrConfigValue } from "./diffr-config";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A stand-in diffr that records `config set` calls and answers schema/show. */
async function fakeDiffr() {
  const root = await mkdtemp(path.join(tmpdir(), "review-diffr-config-"));
  roots.push(root);
  const log = path.join(root, "calls.log");
  const file = path.join(root, "diffr");
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[1] === "schema") {
  console.log(JSON.stringify({ type: "object", properties: { plugins: { properties: { bundled: { properties: { summarize: { properties: { provider: { type: "string", enum: ["gemini"], default: "gemini", description: "Model provider." } } } } } } } } }));
} else if (args[1] === "show") {
  console.log(JSON.stringify({ plugins: { bundled: { summarize: { provider: "gemini" } } } }));
} else if (args[1] === "set") {
  if (args[2] === "bad.key") { console.error("unknown key"); process.exit(2); }
} else {
  process.exit(3);
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("REVIEW_DIFFR_BINARY", file);

  return { root, log };
}

test("reads the schema and resolved values through the CLI", async () => {
  await fakeDiffr();
  const config = await readDiffrConfig();
  expect(config.schema).toMatchObject({ type: "object" });
  expect(config.values).toEqual({
    plugins: { bundled: { summarize: { provider: "gemini" } } },
  });
});

test("writes one key as text and returns the fresh configuration", async () => {
  const { log } = await fakeDiffr();
  const config = await setDiffrConfigValue(
    "plugins.bundled.summarize.test_min_lines",
    12,
  );
  expect(config.values).toEqual({
    plugins: { bundled: { summarize: { provider: "gemini" } } },
  });

  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(calls[0]).toEqual([
    "config",
    "set",
    "plugins.bundled.summarize.test_min_lines",
    "12",
  ]);
});

test("surfaces diffr's own error text", async () => {
  await fakeDiffr();
  await expect(setDiffrConfigValue("bad.key", true)).rejects.toThrow(
    "unknown key",
  );
});

test("rejects keys that are not dotted identifiers before running anything", async () => {
  const { log } = await fakeDiffr();
  await expect(setDiffrConfigValue("--flag", "x")).rejects.toThrow(
    "Invalid diffr config key",
  );
  await expect(readFile(log, "utf8")).rejects.toThrow("ENOENT");
});

test("explains a missing executable", async () => {
  vi.stubEnv("REVIEW_DIFFR_BINARY", "/nonexistent/diffr");
  await expect(readDiffrConfig()).rejects.toThrow("Cannot find diffr");
});

test("accepts current diffr plugin names containing hyphens", async () => {
  await fakeDiffr();
  await expect(
    setDiffrConfigValue("plugins.bundled.deleted-bodies.min_lines", 20),
  ).resolves.toMatchObject({
    values: { plugins: { bundled: { summarize: { provider: "gemini" } } } },
  });
});
