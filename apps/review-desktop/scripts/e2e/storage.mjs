/** Reads workbench storage written by the running Desktop. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The workbench user settings, where every Settings control lands; throws mid-rewrite, so callers poll it through `ctx.until`. */
export function readUserSettings(userData) {
  return JSON.parse(
    readFileSync(path.join(userData, "User/settings.json"), "utf8"),
  );
}

/** Reads one key from workbench application storage; the workbench flushes on a delay, so callers wrap reads in `ctx.until`. */
export function readApplicationStorage(userData, key) {
  const file = path.join(userData, "User/globalStorage/state.vscdb");

  // A profile that has not flushed has no database, and a read-only open fails with SQLITE_CANTOPEN.
  if (!existsSync(file)) return undefined;

  const db = new DatabaseSync(file, { readOnly: true });

  try {
    const value = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(key)?.value;

    // ItemTable.value is a BLOB column, so node:sqlite hands back bytes.
    return value instanceof Uint8Array ? Buffer.from(value).toString() : value;
  } finally {
    db.close();
  }
}
