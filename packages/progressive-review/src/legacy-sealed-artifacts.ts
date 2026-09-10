import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type JsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { isMissingFileError } from "./native-agent/transcript-json";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
} from "./software-map-bundle";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

/** Evaluates the JavaScript document bundle sealed into a materialized review
 * revision. The oldest presentations kept it directly in `.bundle`; later ones
 * moved it under `.bundle/document`. Ranges are not revalidated: the pinned
 * worktree of an old presentation may be long gone. */
export async function evaluateSealedReviewDocument(
  reviewDir: string,
  onWarning?: (message: string) => void,
) {
  let bundleDir = path.join(reviewDir, ".bundle/document");
  let manifestText: string;
  try {
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    bundleDir = path.join(reviewDir, ".bundle");
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  }
  if (jsonObject(parseJsonText(manifestText))?.version !== 1)
    throw new Error("The sealed document manifest is invalid or unsupported.");
  const evaluated = await evaluateReviewDocumentBundleForPublish({
    reviewDir,
    bundleCode: await readFile(
      path.join(bundleDir, "review-document.js"),
      "utf8",
    ),
    ranges: "skip",
  });
  for (const warning of evaluated.warnings) onWarning?.(warning);
  if (!evaluated.document)
    throw new Error(
      evaluated.errors.join("; ") || "Sealed document did not materialize.",
    );
  return { ...evaluated, document: evaluated.document };
}

/** Converts a Git-sealed software-map revision (`.bundle/software-map`, a
 * pair of JavaScript modules) into the current JSON bundle shape. Returns
 * `null` when the revision has no software-map bundle at all, which is only
 * valid for the schema that predates the required software map. */
export async function legacySoftwareMapBundle(
  legacyBuildDir: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const mapDir = path.join(legacyBuildDir, ".bundle", "software-map");
  let manifestValue: JsonObject | undefined;
  try {
    manifestValue = jsonObject(
      parseJsonText(await readFile(path.join(mapDir, "manifest.json"), "utf8")),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      try {
        await readdir(mapDir);
      } catch (directoryError) {
        if (isMissingFileError(directoryError)) return null;
        throw directoryError;
      }
      throw new Error("The presented software map has no manifest.");
    }
    throw error;
  }
  const headCommit = jsonString(manifestValue?.headCommit);
  const baseCommit = jsonString(manifestValue?.baseCommit);
  if (
    manifestValue?.version !== 1 ||
    !headCommit ||
    !baseCommit ||
    !/^[0-9a-f]{40}$/i.test(headCommit) ||
    !/^[0-9a-f]{40}$/i.test(baseCommit)
  ) {
    throw new Error(
      "The presented software-map manifest is invalid or unsupported.",
    );
  }
  const load = async (
    file: string,
  ): Promise<NormalizedSoftwareModel | null> => {
    const url = pathToFileURL(path.join(mapDir, file));
    url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
    try {
      // SAFETY: an imported legacy map module has no static TypeScript shape;
      // isNormalizedSoftwareModel validates its default export before use.
      const module = (await import(url.href)) as { default?: unknown };
      return isNormalizedSoftwareModel(module.default) ? module.default : null;
    } catch {
      return null;
    }
  };
  const [head, base] = await Promise.all([
    load("head-map.js"),
    load("base-map.js"),
  ]);
  if (!head || !base)
    throw new Error(
      "The presented software map could not be converted; its sealed head or base bundle is invalid.",
    );
  return bundleReviewSoftwareMap({ head, base, headCommit, baseCommit });
}

/** Full 40-hex pins from a sealed software-map manifest, when it has them.
 * Both the version-1 and version-2 manifests carry the pair. */
export interface SealedSoftwareMapPins {
  baseCommit: string;
  headCommit: string;
}

export async function readSealedMapManifestPins(
  mapDir: string,
): Promise<SealedSoftwareMapPins | undefined> {
  const manifest = await readFile(
    path.join(mapDir, ".bundle/software-map/manifest.json"),
    "utf8",
  )
    .then((value) => jsonObject(parseJsonText(value)))
    .catch(() => undefined);
  const baseCommit = jsonString(manifest?.baseCommit);
  const headCommit = jsonString(manifest?.headCommit);
  if (
    !baseCommit ||
    !headCommit ||
    !/^[0-9a-f]{40}$/i.test(baseCommit) ||
    !/^[0-9a-f]{40}$/i.test(headCommit)
  )
    return undefined;
  return { baseCommit, headCommit };
}
