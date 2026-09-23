import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ts from "typescript";

import { createNativeTutorial } from "../src/server/tutorial-service";
import { openLocalSessionStore } from "../src/session-api/local-data";
import {
  buildTutorialAssets,
  readTutorialRuntimeManifest,
} from "./build-tutorial-assets";

const tutorialRoot = path.resolve(import.meta.dirname, "../tutorial");

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "native-tutorial-check-"),
);

const local = openLocalSessionStore(path.join(temporaryRoot, "review.db"));

try {
  checkSampleTypeScript(path.join(tutorialRoot, "sample-service"));
  const assetsRoot = path.join(temporaryRoot, "assets");
  await cp(tutorialRoot, assetsRoot, {
    recursive: true,
    filter: (source) => !source.includes("/.bundle"),
  });
  await buildTutorialAssets({ outDir: assetsRoot });
  const manifest = await readTutorialRuntimeManifest(assetsRoot);

  for (const entry of manifest.requiredPaths)
    await stat(path.join(assetsRoot, entry));
  const sampleRoot = path.join(assetsRoot, "sample-service");
  await cp(path.join(assetsRoot, "git-stub"), path.join(sampleRoot, ".git"), {
    recursive: true,
  });
  await createNativeTutorial({ assetsRoot, sampleRoot, ...local });
  console.log(
    "Native tutorial document, source references, trace and both maps validated.",
  );
} finally {
  await local.data.close();
  await local.store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
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
