/** Legacy fixture -> import -> Desktop rendering gate; the schema-4 fixture tarballs are the only seed left. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  legacyRoot,
  openLegacyReview,
  seedLegacyFixtures,
  waitForImport,
} from "../legacy-fixtures.mjs";

const exec = promisify(execFile);

export const name = "legacy-import";

export const phase = 1;

export const options = { beforeLaunch: seedLegacyFixtures };

export async function run(ctx) {
  const { api, apiOk, apiCanvasFor, legacyFixtures, root } = ctx;

  let page = ctx.page;

  // Startup, not `review info`, migrates the legacy directories now; this only records whether the verb reaches them.
  const first = legacyFixtures[0];

  const info = await ctx.cliRaw(
    ["info", "--review", first.metadata.sourceUuid, "--json"],
    first.worktreePath,
  );

  if (info.code === 0)
    assert.match(info.stdout, new RegExp(first.metadata.sourceUuid));
  else {
    // Only the logged bug may pass; any other failure is a new one.
    assert.match(
      `${info.stdout}${info.stderr}`,
      /"message":"Not found\."/,
      `review info: ${info.stdout}\n${info.stderr}`,
    );
    await ctx.knownBug(
      "`review info --review <uuid>` always fails with `Not found.`",
    );
  }

  // Startup imports into the JSON store; `migrate apply` is what seals the presentation in the legacy record.
  const applied = await ctx.cliRaw(["migrate", "apply", "--json"]);

  const event = applied.stdout.split("\n").find((line) => line.startsWith("{"));

  assert.ok(event, `migrate apply: ${applied.stdout}\n${applied.stderr}`);

  const migration = JSON.parse(event);

  assert.equal(migration.documents, legacyFixtures.length);
  // The fixture whose source repository is absent cannot get a managed checkout; every other blocker is a failure.
  assert.deepEqual(
    migration.blockers.filter(
      (blocker) =>
        !legacyFixtures.some(
          (candidate) =>
            candidate.metadata.sourceRepository !== "devdotfast/review" &&
            blocker.includes(candidate.metadata.sourceUuid),
        ),
    ),
    [],
  );

  for (const fixture of legacyFixtures) {
    const {
      name: fixtureName,
      metadata,
      legacyDir,
      worktreePath,
      legacyRecordPath,
      original,
    } = fixture;

    const migrated = JSON.parse(await readFile(legacyRecordPath, "utf8"));

    const golden = JSON.parse(
      await readFile(
        path.join(legacyRoot, `${fixtureName}.expected-document.json`),
        "utf8",
      ),
    );

    const sealed = await exec(
      "git",
      [
        "show",
        `${migrated.presentedDocumentRevision}:.bundle/document/review-document.json`,
      ],
      { cwd: legacyDir, maxBuffer: 8 * 1024 * 1024 },
    );

    assert.deepEqual(JSON.parse(sealed.stdout), golden);
    assert.equal(migrated.status, original.status);
    assert.equal(migrated.createdAt, original.createdAt);

    const revisions = Number(
      (
        await exec(
          "git",
          ["rev-list", "--count", migrated.presentedDocumentRevision],
          { cwd: legacyDir },
        )
      ).stdout.trim(),
    );

    if (metadata.sourceRepository !== "devdotfast/review") {
      await apiOk("/reviews-api");
      assert.equal(
        (await api(`/reviews-api/${metadata.sourceUuid}`)).status,
        404,
        `${fixtureName} without its repository stays legacy`,
      );
      ctx.check(
        `${fixtureName}: installed migration matches sealed JSON golden; unimportable review stays legacy`,
      );
      console.log("E2E legacy fixture passed", fixtureName);
      continue;
    }

    await waitForImport(ctx, metadata.sourceUuid);
    await openLegacyReview(ctx, fixture);
    const snapshot = await waitForImport(ctx, metadata.sourceUuid);

    const document = snapshot.document;

    if (metadata.hasMap) {
      assert.equal(document.at(-1).title, "Software map");
      assert.equal(
        document
          .at(-1)
          .children.filter((block) => block.type === "software_map").length,
        2,
      );
    }

    assert.ok(
      snapshot.origin?.branch || snapshot.origin?.baseRef,
      `${fixtureName} carries origin`,
    );

    const history = await apiOk(`/reviews-api/${metadata.sourceUuid}/history`);

    assert.equal(
      history.length,
      snapshot.version + 1,
      `${fixtureName}: ${history.length} history entries for version ${snapshot.version}`,
    );
    assert.ok(
      snapshot.version + 1 <= revisions,
      `${fixtureName}: ${snapshot.version + 1} versions from ${revisions} revisions`,
    );
    assert.ok(
      (await apiOk("/reviews-api")).some(
        (row) => row.reviewId === metadata.sourceUuid,
      ),
      `${fixtureName} is listed by the review API`,
    );

    page = await apiCanvasFor(golden.title);
    await ctx.watchPage(page);
    const canvas = page.locator(".review-canvas-root");

    if (metadata.hasMap) {
      // The imported map section starts collapsed.
      await canvas
        .getByRole("button", { name: "Expand Software map", exact: true })
        .click();
      await canvas.locator(".software-map").first().waitFor({ timeout: 30000 });
    }

    ctx.check(
      `${fixtureName}: fixture review imports and renders in the JSON canvas, ${snapshot.version + 1} preserved version(s)`,
    );
    console.log("E2E legacy fixture passed", fixtureName);
  }

  await page.locator(".review-canvas-root").click({ trial: true });
  await page.screenshot({ path: path.join(root, "document.png") });
}
