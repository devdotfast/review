import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("review UI state boundary", () => {
  it("keeps browser storage access in the UI state module", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const allowed = new Set(["review-ui-state.ts"]);

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          walk(full);
          continue;
        }

        if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
          continue;
        }

        const relative = path.relative(root, full);

        if (allowed.has(relative)) continue;

        if (
          /window\.(local|session)Storage/u.test(readFileSync(full, "utf8"))
        ) {
          offenders.push(relative);
        }
      }
    };

    walk(root);
    expect(offenders).toEqual([]);
  });
});
