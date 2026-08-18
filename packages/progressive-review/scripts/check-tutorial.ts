/* CI gate for the tutorial: runs the same asset builder the app build runs,
   into a throwaway directory, and checks the outputs plus the static
   authoring contracts. Authoring drift fails here, not on a user machine. */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";

import { reviewAuthoringPropsSchemas } from "../src/authoring";
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
    if (!("TutorialKeymapPicker" in reviewAuthoringPropsSchemas)) {
      throw new Error(
        "TutorialKeymapPicker is absent from the authoring registry.",
      );
    }

    const outDir = path.join(temporaryRoot, "assets");
    const built = await buildTutorialAssets({ outDir });

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
      mapManifest.baseCommit !== built.commit ||
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
    if (count !== "1") {
      throw new Error(`The tutorial repository must have one commit: ${count}`);
    }

    process.stdout.write(
      `Tutorial check passed: commit ${built.commit}, ${built.peekCount} code ranges, document and map bundles valid.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
