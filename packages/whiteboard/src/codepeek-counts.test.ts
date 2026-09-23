import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { whiteboardCodePeekRangeCounts } from "@dev.fast/whiteboard-protocol";
import { expect, it } from "vitest";

it("matches high-context counts at every boundary using small and zero-context corpus patches", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-counts-"));
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

  const variants = [
    [
      ...original.slice(0, 12),
      "inserted",
      "also inserted",
      ...original.slice(12),
    ],
    [...original.slice(0, 12), ...original.slice(14)],
    ["inserted", ...original],
    [...original, "inserted"],
    original.slice(1),
    original.slice(0, -1),
    original.map((line, index) =>
      index === 2 || index === 24 ? `changed ${index}` : line,
    ),
    [],
  ];

  try {
    for (const modified of variants) {
      writeFileSync(join(directory, "before"), original.join("\n"));
      writeFileSync(join(directory, "after"), modified.join("\n"));

      const patches = [0, 3, 100000].map((context) => {
        const result = spawnSync(
          "git",
          ["diff", "--no-index", `--unified=${context}`, "before", "after"],
          { cwd: directory, encoding: "utf8" },
        );

        expect(result.status).toBe(1);

        return result.stdout;
      });

      for (const side of ["base", "head"] as const) {
        for (let line = 1; line <= 34; line++) {
          const expected = whiteboardCodePeekRangeCounts(
            patches[2],
            [{ startLine: line, endLine: line }],
            side,
          );

          for (const patch of patches.slice(0, 2)) {
            expect(
              whiteboardCodePeekRangeCounts(
                patch,
                [{ startLine: line, endLine: line }],
                side,
              ),
              `${side} line ${line}`,
            ).toEqual(expected);
          }
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
