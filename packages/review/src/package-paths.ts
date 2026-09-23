import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { jsonObject, jsonString, parseJsonText } from "@dev.fast/json";
import { findPackageRoot } from "@dev.fast/trace-core";

const MODEL_SOURCE_FILES = new Set([
  "software-map-model.ts",
  "tolerant-software-map-model.ts",
]);

export function findReviewPackageRoot(
  moduleUrl: string = import.meta.url,
): string {
  return findPackageRoot(moduleUrl);
}

export function readReviewPackageVersion(
  moduleUrl: string = import.meta.url,
): string {
  try {
    const packageJson = jsonObject(
      parseJsonText(
        readFileSync(
          path.join(findReviewPackageRoot(moduleUrl), "package.json"),
          "utf8",
        ),
      ),
    );

    return jsonString(packageJson?.version) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function reviewModelModulePath(
  modelFileName: string,
  packageRoot = findReviewPackageRoot(),
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
