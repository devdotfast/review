import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  jsonObject,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";

import {
  LEGACY_WHITEBOARD_FIXTURES_ROOT,
  extractLegacyWhiteboardFixture,
  listLegacyWhiteboardFixtures,
  normalizeMigratedRecord,
} from "../src/fixtures/legacy-reviews/legacy-review-fixture";
import { legacyDocumentToBlocks } from "../src/review-import/legacy-blocks";
import type { Block } from "../src/session-api/document";
import {
  type WhiteboardSoftwareMapBundle,
  readWhiteboardSoftwareMapBundle,
} from "../src/software-map-bundle";
import { migrateStoredWhiteboard } from "../src/stored-review-migration";
import {
  readWhiteboardDocumentBundle,
  whiteboardDocumentBundleData,
} from "../src/whiteboard-bundle";
import type { WhiteboardDocumentData } from "../src/whiteboard-document-data";
import { materializeWhiteboardRevision } from "../src/whiteboard-home";

async function writeGolden(
  name: string,
  kind: string,
  value:
    | JsonObject
    | WhiteboardDocumentData
    | WhiteboardSoftwareMapBundle
    | Block[],
) {
  const text = `${JSON.stringify(value, null, 2)}\n`;

  if (text.includes("/Users/") || text.includes("/home/"))
    throw new Error(`${name} ${kind} golden embeds a machine path`);
  await writeFile(
    path.join(LEGACY_WHITEBOARD_FIXTURES_ROOT, `${name}.expected-${kind}.json`),
    text,
  );
}

for (const fixture of listLegacyWhiteboardFixtures()) {
  const { home, dir } = await extractLegacyWhiteboardFixture(fixture.name);

  try {
    const outcome = await migrateStoredWhiteboard({
      whiteboardDir: dir,
      log: (message) => console.warn(`${fixture.name}: ${message}`),
    });

    if (!outcome.migrated) throw new Error(`${fixture.name} did not migrate`);

    const record = jsonObject(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );

    if (!record) throw new Error(`${fixture.name} has no record`);
    await writeGolden(fixture.name, "record", normalizeMigratedRecord(record));
    const documentDir = path.join(home, "document");
    await materializeWhiteboardRevision(
      dir,
      outcome.record.presentedDocumentRevision!,
      documentDir,
    );
    const document = await readWhiteboardDocumentBundle(documentDir, "/");

    if (!document) throw new Error(`${fixture.name} document did not convert`);
    const documentData = whiteboardDocumentBundleData(document);
    await writeGolden(fixture.name, "document", documentData);
    await writeGolden(
      fixture.name,
      "blocks",
      legacyDocumentToBlocks(documentData).blocks,
    );

    if (outcome.record.presentedSoftwareMapRevision) {
      const mapDir = path.join(home, "map");
      await materializeWhiteboardRevision(
        dir,
        outcome.record.presentedSoftwareMapRevision,
        mapDir,
      );
      const map = await readWhiteboardSoftwareMapBundle(mapDir);

      if (!map) throw new Error(`${fixture.name} map did not convert`);
      await writeGolden(fixture.name, "map", map);
    }

    console.log(`${fixture.name}: goldens written`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
