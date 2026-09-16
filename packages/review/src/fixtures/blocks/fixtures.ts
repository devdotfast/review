import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";

export const BLOCK_FIXTURES_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Resource ids the fixtures reference; tests map them to real uploads or stubs. */
export const FIXTURE_IMAGE_ID = "11111111-1111-4111-8111-111111111111";

export const FIXTURE_TRACE_ID = "22222222-2222-4222-8222-222222222222";

export const FIXTURE_TRACE_EVENT_ID = "0";

export const FIXTURE_MAP_ID = "33333333-3333-4333-8333-333333333333";

/** One entry per `<type>.json`: the block type and its array of valid blocks. */
export async function readBlockFixtures(): Promise<Map<string, JsonValue[]>> {
  const fixtures = new Map<string, JsonValue[]>();

  for (const name of (await readdir(BLOCK_FIXTURES_ROOT)).sort()) {
    if (!name.endsWith(".json")) continue;

    const parsed = parseJsonText(
      await readFile(path.join(BLOCK_FIXTURES_ROOT, name), "utf8"),
    );

    if (!Array.isArray(parsed))
      throw new Error(`${name} must be an array of blocks.`);
    fixtures.set(name.slice(0, -".json".length), parsed);
  }

  return fixtures;
}
