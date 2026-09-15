import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { buildCodeTarget } from "../../app/src/target-fingerprint";
import { createReviewSessionHandler } from "./session-handler";
import { unusedAgentServices } from "./session-handler-test-utils";

it("authenticates selection publication and renders the selected pinned side rather than working-tree contents", async () => {
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
    ...unusedAgentServices,
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
      clientId: "window",
      sequence: 1,
      selection: {
        title: "Old implementation",
        revision: "doc-revision",
        target: buildCodeTarget({
          path: "source.ts",
          side: "base",
          baseCommit: base,
          headCommit: head,
          span: { startLine: 2, endLine: 2 },
        }),
      },
    };

    const request = (token: string, value = body) =>
      handler.handle(
        new Request("http://127.0.0.1:5570/__progressive-review/ide-context", {
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
    const { context: snapshot } = await accepted.json();
    expect(snapshot).toContain(
      `## Active file: ${path.join(root, "source.ts")}`,
    );
    expect(snapshot).toContain(`- review.mdx: ${reviewPath}`);
    expect(snapshot).toContain("old selected");
    expect(snapshot).toContain(base);
    expect(snapshot).not.toContain("Exact Review target");
    expect(snapshot).not.toContain("new selected");
    expect(snapshot).not.toContain("unsaved workspace replacement");
    expect(snapshot).not.toContain("old first");
    expect((await request("secret")).status).toBe(200);
    expect(await readdir(root)).not.toContain("ide-context");
    const fileFocus = {
      ...body,
      sequence: 2,
      selection: { ...body.selection, fileOnly: true },
    };
    const focused = await request("secret", fileFocus);
    const { context } = await focused.json();
    expect(context).toContain(
      `## Active file: ${path.join(root, "source.ts")}`,
    );
    expect(context).not.toContain("## Active selection");
    expect(context).toContain(`- review.mdx: ${reviewPath}`);
  } finally {
    await handler.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
