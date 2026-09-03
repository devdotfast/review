import { describe, expect, it } from "vitest";

import { resolveReviewBranchLinks } from "./review-branch-links";

describe("resolveReviewBranchLinks", () => {
  it("links base and fork head branches when remote-tracking refs exist", async () => {
    const runGit = async (_root: string, args: string[]) => {
      const command = args.join(" ");
      if (command === "remote") {
        return { ok: true, stdout: "origin\nfork\n", stderr: "" };
      }
      if (command.startsWith("for-each-ref")) {
        return {
          ok: true,
          stdout: "origin/main\nfork/feature/branch-labels\n",
          stderr: "",
        };
      }
      if (command === "remote get-url origin") {
        return {
          ok: true,
          stdout: "git@github.com:devdotfast/review.git\n",
          stderr: "",
        };
      }
      if (command === "remote get-url fork") {
        return {
          ok: true,
          stdout: "https://github.com/contributor/review.git\n",
          stderr: "",
        };
      }
      throw new Error(`Unexpected git command: ${command}`);
    };

    await expect(
      resolveReviewBranchLinks(
        {
          rootPath: "/repo",
          baseRef: "main",
          headRef: "feature/branch-labels",
        },
        runGit,
      ),
    ).resolves.toEqual({
      baseUrl: "https://github.com/devdotfast/review/tree/main",
      headUrl:
        "https://github.com/contributor/review/tree/feature/branch-labels",
    });
  });

  it("does not link a local-only branch", async () => {
    const runGit = async (_root: string, args: string[]) => {
      const command = args.join(" ");
      if (command === "remote") {
        return { ok: true, stdout: "origin\n", stderr: "" };
      }
      if (command.startsWith("for-each-ref")) {
        return { ok: true, stdout: "origin/main\n", stderr: "" };
      }
      return {
        ok: true,
        stdout: "git@github.com:devdotfast/review.git\n",
        stderr: "",
      };
    };

    await expect(
      resolveReviewBranchLinks(
        { rootPath: "/repo", baseRef: "main", headRef: "local-work" },
        runGit,
      ),
    ).resolves.toEqual({
      baseUrl: "https://github.com/devdotfast/review/tree/main",
      headUrl: null,
    });
  });
});
