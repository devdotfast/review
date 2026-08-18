import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewRecord } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { reviewTitleFromDocument } from "../review-home";
import { reviewAgentKind } from "./desktop-server";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("reviewTitleFromDocument", () => {
  it("uses the first ATX H1 after frontmatter and strips closing markdown", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-title-"));
    const documentPath = path.join(directory, "review.mdx");
    await writeFile(
      documentPath,
      "---\ntitle: ignored\n---\n# Tab identity smoke ###\n# Later heading\n",
    );

    await expect(reviewTitleFromDocument(documentPath)).resolves.toBe(
      "Tab identity smoke",
    );
  });

  it("keeps the stored title when the document has no ATX H1", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-title-"));
    const documentPath = path.join(directory, "review.mdx");
    await writeFile(documentPath, "---\ntitle: ignored\n---\n## Not an H1\n");

    await expect(
      reviewTitleFromDocument(documentPath),
    ).resolves.toBeUndefined();
  });
});

describe("reviewAgentKind", () => {
  it("uses the latest publisher, then author, then legacy creator", () => {
    const review = {
      sourceSession: "pi:legacy",
      agentSessions: {
        "codex:author": {
          roles: ["author"],
          firstSeenAt: "2026-08-12T09:00:00.000Z",
          lastSeenAt: "2026-08-12T09:00:00.000Z",
        },
        "claude-code:publisher": {
          roles: ["publisher"],
          firstSeenAt: "2026-08-12T10:00:00.000Z",
          lastSeenAt: "2026-08-12T10:00:00.000Z",
        },
      },
    } as unknown as ReviewRecord;
    expect(reviewAgentKind(review)).toBe("claude");
    expect(
      reviewAgentKind({
        ...review,
        agentSessions: {
          "codex:author": review.agentSessions!["codex:author"]!,
        },
      }),
    ).toBe("codex");
    expect(reviewAgentKind({ ...review, agentSessions: undefined })).toBe("pi");
  });
});
