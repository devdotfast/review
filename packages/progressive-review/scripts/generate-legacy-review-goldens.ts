import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import {
  LEGACY_REVIEW_FIXTURES_ROOT,
  extractLegacyReviewFixture,
  listLegacyReviewFixtures,
  normalizeMigratedRecord,
} from "../src/fixtures/legacy-reviews/legacy-review-fixture";
import { readReviewDocumentBundle } from "../src/review-bundle";
import type { ReviewDocumentData } from "../src/review-document-data";
import { materializeReviewRevision } from "../src/review-home";
import { closeAllReviewThreadStores } from "../src/review-thread-store-backend";
import {
  type ReviewSoftwareMapBundle,
  readReviewSoftwareMapBundle,
} from "../src/software-map-bundle";
import { migrateStoredReview } from "../src/stored-review-migration";

async function writeGolden(
  name: string,
  kind: string,
  value: JsonObject | ReviewDocumentData | ReviewSoftwareMapBundle,
) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (text.includes("/Users/") || text.includes("/home/"))
    throw new Error(`${name} ${kind} golden embeds a machine path`);
  await writeFile(
    path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.expected-${kind}.json`),
    text,
  );
}

for (const fixture of await listLegacyReviewFixtures()) {
  const { home, dir } = await extractLegacyReviewFixture(fixture.name);
  try {
    const outcome = await migrateStoredReview({
      reviewDir: dir,
      log: (message) => console.warn(`${fixture.name}: ${message}`),
    });
    if (!outcome.migrated) throw new Error(`${fixture.name} did not migrate`);
    const record = jsonObject(
      parseJsonText(await readFile(path.join(dir, "review.json"), "utf8")),
    );
    if (!record) throw new Error(`${fixture.name} has no record`);
    await writeGolden(fixture.name, "record", normalizeMigratedRecord(record));
    const documentDir = path.join(home, "document");
    await materializeReviewRevision(
      dir,
      outcome.record.presentedDocumentRevision!,
      documentDir,
    );
    const document = await readReviewDocumentBundle(documentDir, "/");
    if (!document) throw new Error(`${fixture.name} document did not convert`);
    await writeGolden(fixture.name, "document", document.document);
    if (outcome.record.presentedSoftwareMapRevision) {
      const mapDir = path.join(home, "map");
      await materializeReviewRevision(
        dir,
        outcome.record.presentedSoftwareMapRevision,
        mapDir,
      );
      const map = await readReviewSoftwareMapBundle(mapDir);
      if (!map) throw new Error(`${fixture.name} map did not convert`);
      await writeGolden(fixture.name, "map", map);
    }
    console.log(`${fixture.name}: goldens written`);
  } finally {
    closeAllReviewThreadStores();
    await rm(home, { recursive: true, force: true });
  }
}
