import type { DatabaseSync } from "node:sqlite";

import { type JsonValue, isJsonObject, parseJsonText } from "@dev.fast/json";

/** Run before opening the session store; every statement commits or rolls back together. */
export function migrateSessionStorage(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");

  try {
    const hasTable = (name: string) =>
      Boolean(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(name),
      );

    // Fresh databases and already migrated profiles need no conversion.
    if (!hasTable("reviews")) {
      db.exec("COMMIT");

      return;
    }

    for (const [before, after] of [
      ["reviews", "sessions"],
      ["review_attention", "session_attention"],
      ["review_coverage", "session_coverage"],
    ]) {
      if (hasTable(before)) db.exec(`ALTER TABLE ${before} RENAME TO ${after}`);
    }

    for (const table of [
      "versions",
      "session_attention",
      "session_coverage",
      "legacy_imports",
      "authoring_sessions",
    ]) {
      if (
        hasTable(table) &&
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === "review_id")
      ) {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN review_id TO session_id`);
      }
    }

    if (hasTable("versions")) {
      const write = db.prepare(
        "UPDATE versions SET snapshot=? WHERE session_id=? AND version=?",
      );

      for (const row of db
        .prepare("SELECT session_id,version,snapshot FROM versions")
        .iterate()) {
        write.run(
          renameEnvelope(String(row.snapshot)),
          row.session_id,
          row.version,
        );
      }
    }

    if (hasTable("receipts")) {
      const write = db.prepare(
        "UPDATE receipts SET request=?,response=? WHERE command_id=?",
      );

      for (const row of db
        .prepare("SELECT command_id,request,response FROM receipts")
        .iterate()) {
        write.run(
          renameRequest(String(row.request)),
          renameEnvelope(String(row.response)),
          row.command_id,
        );
      }
    }

    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Session migration found broken database references.");

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function renameEnvelope(serialized: string): string {
  const value = parseJsonText(serialized);
  renameId(value);

  return JSON.stringify(value);
}

function renameRequest(serialized: string): string {
  const value = parseJsonText(serialized);

  // Initial imports wrap the command with initial document/origin metadata.
  // Neither that metadata nor the operation's authored content is traversed.
  const command =
    isJsonObject(value) && "command" in value ? value.command : value;

  if (isJsonObject(command)) renameId(command.operation);

  return JSON.stringify(value);
}

function renameId(value: JsonValue | undefined): void {
  if (!isJsonObject(value) || !("reviewId" in value)) return;

  if ("sessionId" in value)
    throw new Error("Session migration found conflicting identifier fields.");
  value.sessionId = value.reviewId;
  delete value.reviewId;
}
