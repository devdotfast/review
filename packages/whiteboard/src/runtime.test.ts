import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveWhiteboardRoot } from "./runtime";

type ExecFile = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string }>;

describe("review root resolution", () => {
  it("prefers the enclosing jj root", async () => {
    const execFile = vi.fn<ExecFile>(async (command: string) => {
      if (command === "jj") return { stdout: "/tmp/example\n" };
      throw new Error("git must not run");
    });

    await expect(
      resolveWhiteboardRoot("/tmp/example/nested", execFile),
    ).resolves.toBe(path.resolve("/tmp/example"));
    expect(execFile).toHaveBeenCalledOnce();
  });
});
