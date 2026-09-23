import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { withFileLock } from "@dev.fast/trace-core";

import { ensureJsonCutover } from "../review-import/json-cutover.js";
import { openLocalReviewStore } from "./local-data.js";

const lockOptions = {
  retryMs: 50,
  timeoutMs: 10_000,
  staleMs: Infinity,
  unownedGraceMs: 1_000,
};

/** Both hosts finish migration under the same startup lock before opening the live DB. */
export async function openReviewProfile(
  home: string,
  options: { manageWorkspaces: boolean; log?: (message: string) => void },
) {
  await mkdir(home, { recursive: true, mode: 0o700 });

  const outcome = await withFileLock(
    path.join(home, ".review-profile-startup"),
    lockOptions,
    async () => {
      await ensureJsonCutover(home, options.log ?? (() => {}));

      for (const source of [
        path.join(home, "review-server", "reviews.db"),
        path.join(home, "reviews.db"),
      ])
        await importHeadlessStore(home, source);

      return openLocalReviewStore(path.join(home, "review-api.db"), options);
    },
  );

  if (!outcome.acquired)
    throw new Error(
      "Another Review process is initializing this profile. Retry shortly.",
    );

  return outcome.result;
}

/** Preserve preview headless IDs, history and resources; leave originals as backups. */
async function importHeadlessStore(home: string, source: string) {
  try {
    await access(source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }

  const database = new DatabaseSync(path.join(home, "review-api.db"), {
    timeout: 5000,
  });

  try {
    database.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS headless_imports(path TEXT PRIMARY KEY)",
    );

    if (
      database
        .prepare("SELECT 1 FROM headless_imports WHERE path=?")
        .get(source)
    )
      return;

    const outcome = await withFileLock(
      path.join(path.dirname(source), "server.lock"),
      { ...lockOptions, timeoutMs: 0 },
      async () => {
        database.prepare("ATTACH DATABASE ? AS headless").run(source);
        database.exec("BEGIN IMMEDIATE");

        try {
          if (
            database
              .prepare(
                "SELECT 1 FROM headless.reviews s JOIN reviews t ON s.id=t.id LIMIT 1",
              )
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: the shared store already contains one of its review IDs. Both databases are unchanged.`,
            );
          database.exec(`
          INSERT INTO repositories SELECT s.* FROM headless.repositories s WHERE NOT EXISTS (SELECT 1 FROM repositories t WHERE t.path=s.path);
          CREATE TEMP TABLE repository_ids AS SELECT s.id old_id,t.id new_id FROM headless.repositories s JOIN repositories t ON s.path=t.path;
        `);

          if (
            database
              .prepare(
                `SELECT 1 FROM headless.versions s LEFT JOIN repository_ids r ON json_extract(s.snapshot,'$.pins.repositoryId')=r.old_id WHERE r.old_id IS NULL LIMIT 1`,
              )
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: a version refers to an unregistered repository. Both databases are unchanged.`,
            );

          if (
            database
              .prepare(`SELECT 1 FROM headless.resources s JOIN resources t ON s.id=t.id JOIN repository_ids r ON s.repository_id=r.old_id
          WHERE t.repository_id!=r.new_id OR t.kind!=s.kind OR t.mime_type!=s.mime_type OR t.data IS NOT s.data LIMIT 1`)
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: a resource ID has different content. Both databases are unchanged.`,
            );

          if (
            database
              .prepare(`SELECT 1 FROM headless.receipts s JOIN receipts t ON s.command_id=t.command_id
          WHERE s.request!=t.request OR s.response!=t.response LIMIT 1`)
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: a command ID has different history. Both databases are unchanged.`,
            );
          database.exec(`
          INSERT OR IGNORE INTO resources SELECT s.id,r.new_id,s.kind,s.mime_type,s.data FROM headless.resources s JOIN repository_ids r ON s.repository_id=r.old_id;
          INSERT INTO reviews SELECT * FROM headless.reviews;
          INSERT INTO versions SELECT s.review_id,s.version,
            CASE WHEN json_type(s.snapshot,'$.target')='object'
              THEN json_set(s.snapshot,'$.pins.repositoryId',r.new_id,'$.target.repositoryId',r.new_id)
              ELSE json_set(s.snapshot,'$.pins.repositoryId',r.new_id) END
            FROM headless.versions s JOIN repository_ids r ON json_extract(s.snapshot,'$.pins.repositoryId')=r.old_id;
          INSERT INTO review_attention SELECT * FROM headless.review_attention;
          INSERT OR IGNORE INTO receipts SELECT * FROM headless.receipts;
          INSERT OR IGNORE INTO legacy_imports SELECT * FROM headless.legacy_imports;
        `);

          if (
            database
              .prepare(
                "SELECT 1 FROM headless.sqlite_master WHERE name='authoring_sessions'",
              )
              .get()
          ) {
            // Leases are keyed by (review, scope); either side may predate
            // scopes, and a lease from before them is the document's.
            database.exec(
              `CREATE TABLE IF NOT EXISTS authoring_sessions(review_id TEXT NOT NULL,scope TEXT NOT NULL,lease_id TEXT NOT NULL,expires_at INTEGER NOT NULL,focus TEXT,PRIMARY KEY(review_id,scope))`,
            );

            const scoped = (schema: string) =>
              database
                .prepare(`PRAGMA ${schema}.table_info(authoring_sessions)`)
                .all()
                .some((column) => String(column.name) === "scope");

            const scope = scoped("headless") ? "scope" : "'document'";

            database.exec(
              scoped("main")
                ? `INSERT INTO authoring_sessions(review_id,scope,lease_id,expires_at,focus) SELECT review_id,${scope},lease_id,expires_at,focus FROM headless.authoring_sessions`
                : `INSERT INTO authoring_sessions(review_id,lease_id,expires_at,focus) SELECT review_id,lease_id,expires_at,focus FROM headless.authoring_sessions WHERE ${scope}='document'`,
            );
          }

          database
            .prepare("INSERT INTO headless_imports VALUES(?)")
            .run(source);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    );

    if (!outcome.acquired)
      throw new Error(
        `Stop the old headless server using ${path.dirname(source)}, then retry. Its reviews will be moved into the shared profile automatically.`,
      );
  } finally {
    database.close();
  }
}
