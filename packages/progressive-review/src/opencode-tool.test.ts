import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("OpenCode Review tool", () => {
  it("forwards every authoritative context field as structured CLI arguments", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../tools/review.ts"),
      "utf8",
    );
    for (const field of [
      "context.sessionID",
      "context.messageID",
      "context.directory",
      "context.worktree",
      '"--opencode-session-id"',
      '"--opencode-message-id"',
      '"--opencode-directory"',
      '"--opencode-worktree"',
      "INIT_CWD: context.directory",
    ]) {
      expect(source).toContain(field);
    }
  });
});
