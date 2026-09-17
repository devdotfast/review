import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LocalVcsDiffFileSummary } from "@dev.fast/local-vcs";
import { z } from "zod";

const exec = promisify(execFile);

/** Diff retained bytes, independent of today's index and checkout. */
export async function sourceDiff(
  file: string,
  before: string | null,
  after: string | null,
): Promise<(LocalVcsDiffFileSummary & { patch: string }) | undefined> {
  if (before === after) return;
  const directory = await mkdtemp(join(tmpdir(), "review-source-diff-"));

  try {
    await Promise.all([
      writeFile(join(directory, "before"), before ?? ""),
      writeFile(join(directory, "after"), after ?? ""),
    ]);
    let output: string;

    try {
      output = (
        await exec(
          "git",
          [
            "-C",
            directory,
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=3",
            "--",
            "before",
            "after",
          ],
          { cwd: directory, maxBuffer: 32 * 1024 * 1024 },
        )
      ).stdout;
    } catch (error) {
      const failure = z
        .object({ code: z.literal(1), stdout: z.string() })
        .safeParse(error);

      if (!failure.success) throw error;
      output = failure.data.stdout;
    }

    const hunks = output.slice(output.indexOf("@@"));
    const lines = output.includes("@@") ? hunks.split("\n") : [];

    const a = JSON.stringify(`a/${file}`),
      b = JSON.stringify(`b/${file}`);

    const patch = `diff --git ${a} ${b}\n${before === null ? "new file mode 100644\n" : after === null ? "deleted file mode 100644\n" : ""}--- ${before === null ? "/dev/null" : a}\n+++ ${after === null ? "/dev/null" : b}\n${lines.length ? hunks : ""}`;

    return {
      path: file,
      status:
        before === null ? "added" : after === null ? "deleted" : "modified",
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length,
      patch,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
