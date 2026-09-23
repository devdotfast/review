import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { findWhiteboardPackageRoot } from "./package-paths";

describe("findWhiteboardPackageRoot", () => {
  it("resolves modules nested below source and distribution directories", () => {
    const packageRoot = path.dirname(
      path.dirname(fileURLToPath(import.meta.url)),
    );

    expect(
      findWhiteboardPackageRoot(
        pathToFileURL(
          path.join(packageRoot, "src", "server", "desktop-host.ts"),
        ).href,
      ),
    ).toBe(packageRoot);
    expect(
      findWhiteboardPackageRoot(
        pathToFileURL(
          path.join(packageRoot, "dist", "server", "desktop-host.js"),
        ).href,
      ),
    ).toBe(packageRoot);
  });
});
