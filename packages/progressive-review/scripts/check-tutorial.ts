/* CI gate for the tutorial: runs the same asset builder the app build runs,
   into a throwaway directory, and checks the outputs plus the static
   authoring contracts. Authoring drift fails here, not on a user machine. */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";

import {
  reviewAuthoringPropsSchemas,
  tutorialAuthoringConversationSchema,
} from "../src/authoring";
import { buildTutorialAssets } from "./build-tutorial-assets";

const execFilePromise = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const tutorialRoot = path.join(packageRoot, "tutorial");

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "review-tutorial-check-"),
  );
  try {
    process.env.DEV_REVIEW_HOME = path.join(temporaryRoot, "review-home");
    checkSampleTypeScript(path.join(tutorialRoot, "sample-service"));
    checkSequenceEvidence(
      await readFile(path.join(tutorialRoot, "data.ts"), "utf8"),
    );
    tutorialAuthoringConversationSchema.parse(
      JSON.parse(
        await readFile(
          path.join(tutorialRoot, "authoring-conversation.json"),
          "utf8",
        ),
      ),
    );
    if (!("TutorialAuthoringConversation" in reviewAuthoringPropsSchemas)) {
      throw new Error(
        "TutorialAuthoringConversation is absent from the authoring registry.",
      );
    }
    if (!("TutorialKeymapPicker" in reviewAuthoringPropsSchemas)) {
      throw new Error(
        "TutorialKeymapPicker is absent from the authoring registry.",
      );
    }
    for (const component of ["TutorialFeature", "TutorialViewButton"]) {
      if (!(component in reviewAuthoringPropsSchemas)) {
        throw new Error(`${component} is absent from the authoring registry.`);
      }
    }

    const builtAssetsPresent = await stat(path.join(tutorialRoot, ".bundle"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    const outDir = builtAssetsPresent
      ? tutorialRoot
      : path.join(temporaryRoot, "assets");
    const built = builtAssetsPresent
      ? await readBuiltTutorialIdentity(outDir)
      : await buildTutorialAssets({ outDir });
    await checkRuntimeManifest(outDir);

    const documentManifest = JSON.parse(
      await readFile(
        path.join(outDir, ".bundle", "document", "manifest.json"),
        "utf8",
      ),
    ) as { version?: unknown; routePath?: unknown };
    if (documentManifest.version !== 1 || documentManifest.routePath !== "/") {
      throw new Error("Tutorial document manifest is invalid.");
    }
    const bundle = await readFile(
      path.join(outDir, ".bundle", "document", "review-document.js"),
      "utf8",
    );
    if (bundle.length === 0) {
      throw new Error("Tutorial document bundle is empty.");
    }
    const mapManifest = JSON.parse(
      await readFile(
        path.join(outDir, ".bundle", "software-map", "manifest.json"),
        "utf8",
      ),
    ) as { headCommit?: unknown; baseCommit?: unknown };
    if (
      mapManifest.headCommit !== built.commit ||
      mapManifest.baseCommit !== built.baseCommit ||
      !/^[0-9a-f]{40}$/i.test(built.baseCommit) ||
      !/^[0-9a-f]{40}$/i.test(built.commit)
    ) {
      throw new Error("Tutorial software-map manifest commits are invalid.");
    }

    // Assemble the repo exactly like the runtime does and check the stub.
    const repo = path.join(temporaryRoot, "sample-service");
    await cp(path.join(tutorialRoot, "sample-service"), repo, {
      recursive: true,
    });
    await cp(path.join(outDir, "git-stub"), path.join(repo, ".git"), {
      recursive: true,
    });
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    if (head !== built.commit) {
      throw new Error(
        `Assembled tutorial repository HEAD ${head} does not match the built commit ${built.commit}.`,
      );
    }
    const count = (await git(repo, ["rev-list", "--count", "HEAD"])).trim();
    const base = (await git(repo, ["rev-parse", "HEAD^"])).trim();
    if (count !== "2" || base !== built.baseCommit) {
      throw new Error(
        `The tutorial repository must have the expected two-commit history: ${count}`,
      );
    }

    process.stdout.write(
      `Tutorial check passed: commit ${built.commit}, ${built.peekCount} code ranges, document and map bundles valid.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readBuiltTutorialIdentity(outDir: string): Promise<{
  baseCommit: string;
  commit: string;
  peekCount: number;
}> {
  const manifest = JSON.parse(
    await readFile(
      path.join(outDir, ".bundle", "software-map", "manifest.json"),
      "utf8",
    ),
  ) as { baseCommit?: unknown; headCommit?: unknown };
  if (
    typeof manifest.baseCommit !== "string" ||
    typeof manifest.headCommit !== "string"
  ) {
    throw new Error("Tutorial software-map manifest commits are invalid.");
  }
  return {
    baseCommit: manifest.baseCommit,
    commit: manifest.headCommit,
    peekCount: 0,
  };
}

async function checkRuntimeManifest(outDir: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(tutorialRoot, "runtime-manifest.json"), "utf8"),
  ) as {
    version?: unknown;
    reviewFiles?: unknown;
    requiredPaths?: unknown;
  };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.reviewFiles) ||
    !Array.isArray(manifest.requiredPaths) ||
    manifest.reviewFiles.length === 0 ||
    manifest.requiredPaths.length === 0 ||
    !manifest.reviewFiles.every((entry) =>
      isSafeManifestPath(entry, manifest.requiredPaths as unknown[]),
    ) ||
    !manifest.requiredPaths.every((entry) => isSafeManifestPath(entry))
  ) {
    throw new Error("Tutorial runtime manifest is invalid.");
  }
  for (const entry of manifest.requiredPaths) {
    if (typeof entry !== "string") {
      throw new Error("Tutorial runtime manifest contains an invalid path.");
    }
    const generated = path.join(outDir, entry);
    const source = path.join(tutorialRoot, entry);
    const exists = await stat(generated)
      .then(() => true)
      .catch(() =>
        stat(source)
          .then(() => true)
          .catch(() => false),
      );
    if (!exists) {
      throw new Error(`Tutorial runtime manifest references missing ${entry}.`);
    }
  }
}

function isSafeManifestPath(
  entry: unknown,
  requiredPaths?: unknown[],
): entry is string {
  return (
    typeof entry === "string" &&
    entry.length > 0 &&
    !path.isAbsolute(entry) &&
    !entry.split(/[\\/]/u).includes("..") &&
    (!requiredPaths || requiredPaths.includes(entry))
  );
}

function checkSampleTypeScript(repositoryRoot: string): void {
  const configPath = path.join(repositoryRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    repositoryRoot,
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      `Tutorial sample TypeScript failed:\n${ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => repositoryRoot,
          getNewLine: () => "\n",
        },
      )}`,
    );
  }
}

function checkSequenceEvidence(source: string): void {
  const file = ts.createSourceFile(
    "data.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let sequence: ts.ArrayLiteralExpression | undefined;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "checkoutSequence" &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        sequence = declaration.initializer;
      }
    }
  }
  if (!sequence || sequence.elements.length === 0) {
    throw new Error("The tutorial checkout sequence is missing.");
  }
  for (const message of sequence.elements) {
    if (
      !ts.isObjectLiteralExpression(message) ||
      !message.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "anchor",
      )
    ) {
      throw new Error(
        "Every tutorial sequence message must contain code evidence.",
      );
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

await main();
