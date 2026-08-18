import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveReviewRoot, resolveReviewSubject } from "./runtime";

type ExecFile = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string }>;

describe("Review source resolution", () => {
  it("prefers the enclosing jj root", async () => {
    const execFile = vi.fn<ExecFile>(async (command: string) => {
      if (command === "jj") return { stdout: "/tmp/example\n" };
      throw new Error("git must not run");
    });

    await expect(
      resolveReviewRoot("/tmp/example/nested", execFile),
    ).resolves.toBe(path.resolve("/tmp/example"));
    expect(execFile).toHaveBeenCalledOnce();
  });

  it("keeps the working-tree route when explicitly requested", async () => {
    await expect(
      resolveReviewSubject({
        cwd: "/tmp/example",
        baseRef: "main",
        workingTreeHead: true,
        execFile: vi.fn<ExecFile>(),
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).resolves.toEqual({ baseRef: "main", routePath: "/" });
  });

  it("resolves a canonical pull request URL with the review subject", async () => {
    const execFile = vi.fn<ExecFile>(async (command: string) => {
      if (command === "gh") {
        return {
          stdout: JSON.stringify({
            number: 673,
            title: "Show modified nodes",
            baseRefName: "main",
          }),
        };
      }
      if (command === "git") return { stdout: "" };
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      resolveReviewSubject({
        cwd: process.cwd(),
        pullRequest: "https://github.com/Fix-Fast/dev/pull/673",
        execFile,
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).resolves.toMatchObject({
      pullRequestNumber: 673,
      pullRequestTitle: "Show modified nodes",
      pullRequestUrl: "https://github.com/Fix-Fast/dev/pull/673",
    });
  });
});
