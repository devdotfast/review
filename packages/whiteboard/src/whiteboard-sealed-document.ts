import { readFile } from "node:fs/promises";
import path from "node:path";

import { jsonObject, parseJsonText } from "@dev.fast/whiteboard-protocol";

import { isMissingFileError } from "./fs-utils";
import { evaluateWhiteboardDocumentBundleForPublish } from "./whiteboard-publish-evaluate";

/** Evaluates the JavaScript document bundle sealed into a materialized review
 * revision. The oldest presentations kept it directly in `.bundle`; later ones
 * moved it under `.bundle/document`. Ranges are not revalidated: the pinned
 * worktree of an old presentation may be long gone. */
export async function evaluateSealedWhiteboardDocument(
  whiteboardDir: string,
  onWarning?: (message: string) => void,
) {
  let bundleDir = path.join(whiteboardDir, ".bundle/document");
  let manifestText: string;

  try {
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    bundleDir = path.join(whiteboardDir, ".bundle");
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  }

  if (jsonObject(parseJsonText(manifestText))?.version !== 1)
    throw new Error("The sealed document manifest is invalid or unsupported.");

  const evaluated = await evaluateWhiteboardDocumentBundleForPublish({
    whiteboardDir,
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
