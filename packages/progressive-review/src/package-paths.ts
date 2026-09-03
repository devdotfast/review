import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

const MODEL_SOURCE_FILES = new Set([
  "software-map-model.ts",
  "tolerant-software-map-model.ts",
]);

export function findProgressiveReviewPackageRoot(
  moduleUrl: string = import.meta.url,
): string {
  const currentDir = path.dirname(fileURLToPath(moduleUrl));
  let candidate = currentDir;
  while (true) {
    const directoryName = path.basename(candidate);
    if (directoryName === "src" || directoryName === "dist") {
      return path.dirname(candidate);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return currentDir;
    candidate = parent;
  }
}

/**
 * Compiler resources ship inside the package, so they must be resolved from the
 * package root rather than relative to the calling module: tsdown collapses the
 * compiler into a top-level `dist` chunk, and a relative hop from there escapes
 * the package entirely.
 */
export function progressiveReviewAppSourcePath(
  moduleUrl: string = import.meta.url,
): string {
  return path.join(findProgressiveReviewPackageRoot(moduleUrl), "app", "src");
}

export function progressiveReviewAuthoringSourcePath(
  moduleUrl: string = import.meta.url,
): string {
  return path.join(
    findProgressiveReviewPackageRoot(moduleUrl),
    "src",
    "authoring.ts",
  );
}

export function readProgressiveReviewPackageVersion(
  moduleUrl: string = import.meta.url,
): string {
  try {
    const packageJson = jsonObject(
      parseJsonText(
        readFileSync(
          path.join(
            findProgressiveReviewPackageRoot(moduleUrl),
            "package.json",
          ),
          "utf8",
        ),
      ),
    );
    return jsonString(packageJson?.version) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function progressiveReviewModelModulePath(
  modelFileName: string,
  packageRoot = findProgressiveReviewPackageRoot(),
): string {
  if (!MODEL_SOURCE_FILES.has(modelFileName)) {
    throw new Error(
      `Unsupported Progressive Review model file ${modelFileName}`,
    );
  }

  const distFileName = modelFileName.replace(/\.ts$/, ".js");
  const candidates = [
    path.join(packageRoot, "dist", distFileName),
    path.join(packageRoot, "src", modelFileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function relativeImportPath(
  fromFilePath: string,
  targetFilePath: string,
) {
  if (path.isAbsolute(targetFilePath)) {
    return pathToFileURL(targetFilePath).href;
  }

  const relative = path.relative(path.dirname(fromFilePath), targetFilePath);
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
