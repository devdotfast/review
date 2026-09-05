import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeNote } from "@dev.fast/local-vcs";
import { expect, it } from "vitest";

import { createReviewDir } from "../review-home";
import { SOFTWARE_MAP_NOTES_REF } from "../review-storage";
import { CANONICAL_SOFTWARE_MAP_MODEL_IMPORT } from "../software-map-artifact";
import { createReviewSessionHandler } from "./session-handler";

it("refreshes note artifacts without executing authored code in the server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-map-refresh-"));
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["commit", "-q", "--allow-empty", "-m", "Base"]);
    const base = git(["rev-parse", "HEAD"]);
    git(["commit", "-q", "--allow-empty", "-m", "Head"]);
    const head = git(["rev-parse", "HEAD"]);
    const markers = [base, head].map((commit) =>
      path.join(root, `${commit}.ran`),
    );
    for (const [index, commit] of [base, head].entries()) {
      await writeNote({
        rootPath: root,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: [
          'import { writeFileSync } from "node:fs";',
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          `writeFileSync(${JSON.stringify(markers[index])}, "executed");`,
          `export default defineSoftwareMap({ systems: { app: { label: ${JSON.stringify(commit)} } } });`,
        ].join("\n"),
      });
    }
    const stored = await createReviewDir({
      reviewsHomePath: path.join(root, "home"),
      worktreePath: root,
      baseRef: "main",
      baseCommit: base,
      sourceCommit: head,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    const reviewPath = path.join(stored.dir, "review.mdx");
    const handler = await createReviewSessionHandler({
      rootPath: root,
      toolingRoot: root,
      reviewPath,
      reviewRootPath: stored.dir,
      routePath: "/",
      token: "secret",
      agentServer: () => {
        throw new Error("Refresh must not launch an agent.");
      },
      openNativeAgentTerminal: async () => {
        throw new Error("Refresh must not launch an agent.");
      },
      session: {
        rootPath: root,
        baseRef: base,
        appUrl: "http://127.0.0.1:5570",
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const response = await handler.handle(
        new Request(
          "http://127.0.0.1:5570/__progressive-review/software-map/artifacts/refresh",
          {
            method: "POST",
            headers: { "x-review-token": "secret" },
          },
        ),
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.refresh.status).toBe("rematerialized");
      const artifact = result.refresh.artifactPath as string;
      expect(await readFile(artifact, "utf8")).toContain(head);
      expect(await readFile(artifact.replace(head, base), "utf8")).toContain(
        base,
      );
      expect(markers.map((marker) => existsSync(marker))).toEqual([
        false,
        false,
      ]);
    } finally {
      await handler.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
