import type { DatabaseSync } from "node:sqlite";

import { type JsonValue, isJsonObject, parseJsonText } from "@dev.fast/json";

import { markdownNodes, parseMarkdown } from "./markdown.js";

/** Rewrite link destinations only; literal examples and labels are user content. */
export function migrateSourceLinks(markdown: string): string {
  const edits: { start: number; end: number; text: string }[] = [];

  for (const node of markdownNodes(parseMarkdown(markdown))) {
    if (node.type !== "link" && node.type !== "definition") continue;

    if (node.type === "link" && node.identifier !== undefined) continue;
    const prefix = /^review-(source|trace):/i.exec(node.url ?? "")?.[0];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (!prefix || start === undefined || end === undefined) continue;
    const offset = markdown.slice(start, end).lastIndexOf(prefix);

    // Reference-style links are rewritten at their definition, not their use.
    if (offset < 0) continue;
    edits.push({
      start: start + offset,
      end: start + offset + prefix.length,
      text: prefix.toLowerCase().replace("review-", "whiteboard-"),
    });
  }

  for (const edit of edits.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);

  return markdown;
}

/** Used by the one-time local upgrade and the external shared-document boundary. */
export function migrateDocumentLinks(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(migrateDocumentLinks);

  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      // Stored snapshots and receipts are decoded JSON from historical schemas.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      key === "markdown" && typeof child === "string"
        ? migrateSourceLinks(child)
        : migrateDocumentLinks(child),
    ]),
  );
}

export function migrateStoredSourceLinks(db: DatabaseSync): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='versions'",
      )
      .get()
  )
    return;
  db.exec("BEGIN IMMEDIATE");

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS session_migrations(name TEXT PRIMARY KEY)",
    );

    if (
      !db
        .prepare("SELECT 1 FROM session_migrations WHERE name='source-links'")
        .get()
    ) {
      const write = db.prepare(
        "UPDATE versions SET snapshot=? WHERE session_id=? AND version=?",
      );

      for (const row of db
        .prepare("SELECT session_id,version,snapshot FROM versions")
        .iterate())
        write.run(
          JSON.stringify(
            migrateDocumentLinks(parseJsonText(String(row.snapshot))),
          ),
          row.session_id,
          row.version,
        );

      const receipt = db.prepare(
        "UPDATE receipts SET request=?,response=? WHERE command_id=?",
      );

      for (const row of db
        .prepare("SELECT command_id,request,response FROM receipts")
        .iterate())
        receipt.run(
          JSON.stringify(
            migrateDocumentLinks(parseJsonText(String(row.request))),
          ),
          JSON.stringify(
            migrateDocumentLinks(parseJsonText(String(row.response))),
          ),
          row.command_id,
        );
      db.exec("INSERT INTO session_migrations VALUES('source-links')");
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
