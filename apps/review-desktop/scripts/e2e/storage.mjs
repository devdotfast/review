/** Reads workbench storage written by the running Desktop. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The workbench user settings, which is where every Settings page control
 *  lands: each setter calls `configurationService.updateValue(...,
 *  ConfigurationTarget.USER)` (`reviewCanvasPart.ts:654-692`). Throws while the
 *  workbench is rewriting the file, so callers poll it through `ctx.until`. */
export function readUserSettings(userData) {
  return JSON.parse(
    readFileSync(path.join(userData, "User/settings.json"), "utf8"),
  );
}

/** Reads one key from workbench application storage (StorageScope.APPLICATION).
 *  The workbench flushes on a short delay, so callers wrap reads in `ctx.until`. */
export function readApplicationStorage(userData, key) {
  const file = path.join(userData, "User/globalStorage/state.vscdb");

  // A profile that has not flushed yet has no database, and a read-only open
  // reports that as SQLITE_CANTOPEN rather than an empty table.
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
