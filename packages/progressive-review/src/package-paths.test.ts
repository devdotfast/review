import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findProgressiveReviewPackageRoot,
  progressiveReviewAppSourcePath,
  progressiveReviewAuthoringTypesPath,
} from "./package-paths";

describe("findProgressiveReviewPackageRoot", () => {
  it("resolves modules nested below source and distribution directories", () => {
    const packageRoot = path.dirname(
      path.dirname(fileURLToPath(import.meta.url)),
    );

    expect(
      findProgressiveReviewPackageRoot(
        pathToFileURL(
          path.join(packageRoot, "src", "server", "desktop-host.ts"),
        ).href,
      ),
    ).toBe(packageRoot);
    expect(
      findProgressiveReviewPackageRoot(
        pathToFileURL(
          path.join(packageRoot, "dist", "server", "desktop-host.js"),
        ).href,
      ),
    ).toBe(packageRoot);
  });
});

describe("compiler resource paths", () => {
  const packageRoot = path.dirname(
    path.dirname(fileURLToPath(import.meta.url)),
  );

  // tsdown collapses the compiler into a top-level dist chunk, so a resolver
  // that hops relative to its own module escapes the package once bundled.
  const moduleUrls = [
    pathToFileURL(path.join(packageRoot, "src", "document", "check.ts")).href,
    pathToFileURL(path.join(packageRoot, "dist", "index.js")).href,
    pathToFileURL(path.join(packageRoot, "dist", "server", "desktop-host.js"))
      .href,
  ];

  it("resolves the review app source directory inside the package", () => {
    for (const moduleUrl of moduleUrls) {
      expect(progressiveReviewAppSourcePath(moduleUrl)).toBe(
        path.join(packageRoot, "app", "src"),
      );
    }
  });

  it("uses fresh source types in development and generated declarations after packaging", () => {
    expect(progressiveReviewAuthoringTypesPath(moduleUrls[0])).toBe(
      path.join(packageRoot, "src", "authoring.ts"),
    );

    for (const moduleUrl of moduleUrls.slice(1)) {
      expect(progressiveReviewAuthoringTypesPath(moduleUrl)).toBe(
        path.join(packageRoot, "dist", "authoring.d.ts"),
      );
    }
  });
});
