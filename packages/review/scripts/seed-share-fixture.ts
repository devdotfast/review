import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { exportShare } from "../src/sharing/export.js";
import { SharedReviewStore } from "../src/sharing/import.js";
import { createShareFixture } from "../test/fixtures/share/create.js";

const root = path.resolve(process.argv[2]!);

await mkdir(root, { recursive: true });

const fixture = await createShareFixture(root);

const bundle = await exportShare(fixture);

bundle.attribution = { login: "fixture-sender", sharedAt: Date.now() };

const home = path.join(root, "recipient");

const store = new SharedReviewStore(path.join(home, "shared-reviews"));

const reviewId = await store.import(
  "https://app.dev.fast",
  randomUUID(),
  bundle,
);

await fixture.data.close();

fixture.store.close();

await rename(fixture.repo, path.join(root, "sender-unavailable"));

await writeFile(
  path.join(root, "fixture.json"),
  JSON.stringify({ reviewId, home, version: bundle.manifest.version }),
);
