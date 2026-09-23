import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { openLocalSessionStore } from "../src/review-api/local-data.js";
import { exportShare } from "../src/sharing/export.js";
import { SharedSessionStore } from "../src/sharing/import.js";
import {
  fetchPinnedRepository,
  sharedGit,
  verifyShareRepository,
} from "../src/sharing/repository.js";
import { createShareFixture } from "../test/fixtures/share/create.js";

const root = path.resolve(process.argv[2]!);

await mkdir(root, { recursive: true });

const github = process.argv.includes("--github");

const fixture = await createShareFixture(root, github);

if (github)
  await verifyShareRepository(
    fixture.repo,
    fixture.store.read(fixture.sessionId).pins!,
  );

const bundle = await exportShare({
  ...fixture,
});

bundle.attribution = { login: "fixture-sender", sharedAt: Date.now() };

const home = path.join(root, "recipient");

await mkdir(home, { recursive: true });

const recipient = openLocalSessionStore(path.join(home, "review-api.db"));

const store = new SharedSessionStore(
  path.join(home, "shared-reviews"),
  async (target, url, pins) => {
    await fetchPinnedRepository(target, github ? url : fixture.repo, pins);

    if (process.argv.includes("--lsp"))
      await sharedGit(target, ["config", "devfast.prepare", "true"]);
  },
);

store.connect(recipient.store, recipient.data);

await store.load();

const sessionId = await store.import(
  "https://app.dev.fast",
  randomUUID(),
  bundle,
);

await recipient.data.close();

recipient.store.close();

await fixture.data.close();

fixture.store.close();

await rename(fixture.repo, path.join(root, "sender-unavailable"));

await writeFile(
  path.join(root, "fixture.json"),
  JSON.stringify({
    sessionId,
    home,
    version: bundle.manifest.version,
    sourceFile: fixture.sourceFile,
    sourceText: fixture.sourceText,
    github,
  }),
);
