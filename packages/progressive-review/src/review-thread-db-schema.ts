import type { DatabaseSync } from "node:sqlite";

export const REVIEW_THREAD_DB_SCHEMA_VERSION = 6;

export class ReviewThreadDbVersionError extends Error {
  override readonly name = "ReviewThreadDbVersionError";

  constructor(dbPath: string, found: string | null) {
    super(
      `Review thread database ${dbPath} has schema version ` +
        `${found ?? "(missing)"}; this version of Review supports ` +
        `${REVIEW_THREAD_DB_SCHEMA_VERSION}. Run \`review migrate apply\`.`,
    );
  }
}

export function readThreadDbSchemaVersion(db: DatabaseSync): string | null {
  // SAFETY: the query projects the integer literal `present`.
  const hasMeta = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .get() as { present: number } | undefined;
  if (!hasMeta) return null;
  // SAFETY: the legacy meta table declares value TEXT NOT NULL.
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function requireCurrentThreadDbSchema(
  db: DatabaseSync,
  dbPath: string,
): void {
  const version = readThreadDbSchemaVersion(db);
  if (version !== String(REVIEW_THREAD_DB_SCHEMA_VERSION))
    throw new ReviewThreadDbVersionError(dbPath, version);
}
