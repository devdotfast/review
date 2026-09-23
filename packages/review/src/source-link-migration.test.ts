import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { sourceReferences } from "./review-api/document.js";
import {
  migrateDocumentLinks,
  migrateStoredSourceLinks,
} from "./source-link-migration.js";

it("upgrades saved history and retry content once while keeping prose and code examples intact", () => {
  const db = new DatabaseSync(":memory:");

  const markdown =
    "[review-source: label](review-source:head/a.ts#L2-L4)\n\n[reference][src]\n\n[src]: review-source:base/a.ts#L1\n\n`review-source:head/a.ts#L9`\n\n```md\n[example](review-source:head/a.ts#L8)\n```";

  const snapshot = { document: [{ type: "markdown", id: "m", markdown }] };

  try {
    db.exec(
      "CREATE TABLE versions(session_id TEXT,version INTEGER,snapshot TEXT); CREATE TABLE receipts(command_id TEXT,request TEXT,response TEXT)",
    );

    for (const version of [1, 2])
      db.prepare("INSERT INTO versions VALUES('s',?,?)").run(
        version,
        JSON.stringify(snapshot),
      );
    db.prepare("INSERT INTO receipts VALUES('retry',?,?)").run(
      JSON.stringify({ operation: { edit: { changes: { markdown } } } }),
      JSON.stringify(snapshot),
    );
    migrateStoredSourceLinks(db);
    migrateStoredSourceLinks(db);

    for (const row of db
      .prepare("SELECT snapshot FROM versions ORDER BY version")
      .all()) {
      const saved = JSON.parse(String(row.snapshot));
      const text = saved.document[0].markdown;
      expect(text).toContain(
        "[review-source: label](whiteboard-source:head/a.ts#L2-L4)",
      );
      expect(text).toContain("[src]: whiteboard-source:base/a.ts#L1");
      expect(text).toContain("`review-source:head/a.ts#L9`");
      expect(text).toContain("[example](review-source:head/a.ts#L8)");
      expect(sourceReferences(saved.document)).toHaveLength(2);
    }

    const receipt = db.prepare("SELECT request,response FROM receipts").get()!;
    expect(
      JSON.parse(String(receipt.request)).operation.edit.changes.markdown,
    ).toContain("whiteboard-source:head/a.ts#L2-L4");
    expect(JSON.parse(String(receipt.response))).toEqual(
      migrateDocumentLinks(snapshot),
    );
  } finally {
    db.close();
  }
});
