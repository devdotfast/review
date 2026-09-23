import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonValue, parseJsonText } from "@dev.fast/whiteboard-protocol";

export const BLOCK_FIXTURES_ROOT = path.dirname(fileURLToPath(import.meta.url));

export {
  FIXTURE_IMAGE_ID,
  FIXTURE_MAP_ID,
  FIXTURE_TRACE_EVENT_ID,
  FIXTURE_TRACE_ID,
} from "./ids.js";

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
