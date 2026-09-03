import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { reviewTitleFromDocument } from "../review-home";
import {
  type ReviewAgentSessionSource,
  createGlobalReviewServer,
  reviewAgentKind,
} from "./desktop-server";

let directory: string | undefined;
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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
    const review: ReviewAgentSessionSource = {
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
    };
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
    expect(
      reviewAgentKind({
        ...review,
        sourceSession: "fresh:pi",
        agentSessions: undefined,
      }),
    ).toBe("pi");
  });
});

describe("Review Desktop open requests", () => {
  it("rejects an unknown Review view before opening a session", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "review-view-server-"));
    const token = "review-view-test-token";
    const server = createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(directory, "desktop.json"),
    });

    try {
      await server.listen();
      const response = await fetch(
        `${server.url}/reviews/11111111-1111-4111-8111-111111111111/open`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-review-token": token,
          },
          body: JSON.stringify({ view: "files" }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "invalid_view",
      });
    } finally {
      await server.close();
    }
  });
});
