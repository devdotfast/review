import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { createReviewSessionHandler } from "./session-handler";

it("authenticates context rendering and renders the selected pinned side rather than working-tree contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-selection-api-"));
  vi.stubEnv("CODEX_HOME", path.join(root, "no-codex"));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(root, "source.ts"), "old first\nold selected\n");
  git("add", "source.ts");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.ts"), "new first\nnew selected\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  await writeFile(
    path.join(root, "source.ts"),
    "unsaved workspace replacement\n",
  );
  const reviewPath = path.join(root, "review.mdx");

  const handler = await createReviewSessionHandler({
    rootPath: root,
    toolingRoot: root,
    reviewPath,
    routePath: "/",
    token: "secret",
    session: {
      rootPath: root,
      baseRootPath: root,
      headRootPath: root,
      baseRef: base,
      headRef: head,
      appUrl: "http://127.0.0.1:5570",
      reviewPath,
      startedAt: Date.now(),
    },
  });

  try {
    const body = {
      title: "Old implementation",
      revision: "doc-revision",
      target: {
        kind: "code",
        path: "source.ts",
        side: "base",
        startLine: 2,
        endLine: 2,
      },
    };

    const request = (token: string, value = body) =>
      handler.handle(
        new Request("http://127.0.0.1:5570/__progressive-review/copy-context", {
          method: "POST",
          headers: {
            "x-review-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
        }),
      );

    const denied = await request("wrong");
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const accepted = await request("secret");
    expect(accepted.status).toBe(200);
    const { text: snapshot } = await accepted.json();
    expect(snapshot).toContain(`Review document: ${reviewPath}`);

    expect(snapshot).toContain("old selected");
    expect(snapshot.endsWith("\n\n")).toBe(true);
    expect(snapshot).toContain(base);
    expect(snapshot).not.toContain("Exact Review target");
    expect(snapshot).not.toContain("new selected");
    expect(snapshot).not.toContain("unsaved workspace replacement");
    expect(snapshot).not.toContain("old first");
    expect((await request("secret")).status).toBe(200);
    expect(await readdir(root)).not.toContain("ide-context");
  } finally {
    await handler.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
