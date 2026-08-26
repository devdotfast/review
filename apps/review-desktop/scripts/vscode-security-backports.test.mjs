import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const codeOss = new URL("../code-oss/", import.meta.url);

async function source(path) {
  return readFile(new URL(path, codeOss), "utf8");
}

test("pins the hardened Electron runtime", async () => {
  const npmrc = await source(".npmrc");
  const packageJson = JSON.parse(await source("package.json"));
  const lock = JSON.parse(await source("package-lock.json"));
  const manifest = await source("cgmanifest.json");
  const checksums = await source("build/checksums/electron.txt");

  assert.match(npmrc, /^target="42\.9\.3"$/m);
  assert.match(npmrc, /^ms_build_id="15072006"$/m);
  assert.equal(packageJson.devDependencies.electron, "42.9.3");
  assert.equal(lock.packages["node_modules/electron"].version, "42.9.3");
  assert.match(manifest, /"tag": "42\.9\.3"/);
  assert.match(checksums, /electron-v42\.9\.3-darwin-arm64\.zip/);
  assert.doesNotMatch(checksums, /42\.6\.0/);
});

test("keeps the Anthropic SDK out of production dependencies", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  const lock = JSON.parse(await source("package-lock.json"));

  assert.equal(packageJson.dependencies["@anthropic-ai/sdk"], undefined);
  assert.equal(packageJson.devDependencies["@anthropic-ai/sdk"], "^0.93.0");
  assert.equal(lock.packages[""].dependencies["@anthropic-ai/sdk"], undefined);
  assert.equal(lock.packages["node_modules/@anthropic-ai/sdk"].dev, true);
});

test("keeps the security boundary backports", async () => {
  const processes = await source("src/vs/base/common/processes.ts");
  const commands = await source(
    "src/vs/workbench/api/common/extHostCommands.ts",
  );
  const webview = await source(
    "src/vs/workbench/contrib/webview/browser/webviewElement.ts",
  );
  const environment = await source(
    "src/vs/workbench/services/environment/browser/environmentService.ts",
  );
  const terminal = await source(
    "src/vs/workbench/contrib/terminal/browser/terminalInstance.ts",
  );
  const urlHandler = await source(
    "src/vs/workbench/services/extensions/browser/extensionUrlHandler.ts",
  );

  for (const name of [
    "DEBUG",
    "NODE_OPTIONS",
    "VSCODE_NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
  ]) {
    assert.match(processes, new RegExp(`'${name}'`));
  }
  assert.match(processes, /dangerousEnvVariables\.has\(key\.toUpperCase\(\)\)/);
  assert.match(commands, /\.slice\(obj\.buffer\.byteOffset,/);
  assert.match(webview, /new Uint8Array\(chunk\.buffer\)/g);
  assert.match(
    environment,
    /this\.payload && \(!this\.isBuilt \|\| this\.enableSmokeTestDriver\)/,
  );
  assert.match(
    terminal,
    /workspaceEmptyCreateTerminalCwd[\s\S]*?this\._userHome\)\n\s*\}\);\n\s*return;/,
  );

  const confirmation = urlHandler.indexOf("dialogService.confirm");
  const override = urlHandler.indexOf("overrideHandler.handleURL");
  assert.ok(confirmation !== -1 && override > confirmation);
});

test("keeps the memory and crash backports", async () => {
  const ipc = await source("src/vs/base/parts/ipc/common/ipc.ts");
  const app = await source("src/vs/code/electron-main/app.ts");
  const events = await source("src/vs/base/common/event.ts");
  const editors = await source(
    "src/vs/workbench/api/browser/mainThreadDocumentsAndEditors.ts",
  );
  const codeActions = await source(
    "src/vs/editor/contrib/codeAction/browser/codeActionModel.ts",
  );
  const multiDiff = await source(
    "src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.ts",
  );
  const textMate = await source(
    "src/vs/workbench/services/textMate/browser/textMateTokenizationFeatureImpl.ts",
  );

  assert.match(ipc, /unbufferedEvents\?: readonly string\[\]/);
  assert.match(app, /unbufferedEvents: \['onDidBlurMainWindow'\]/);
  assert.match(events, /private _getLeakageMonitor\(\)/);
  assert.match(events, /this\._stacks!\.delete\(stackKey\)/);
  assert.match(editors, /new DisposableMap<string, MainThreadTextEditor>\(\)/);
  assert.match(editors, /this\._textEditors\.deleteAndDispose\(id\)/);
  assert.match(codeActions, /this\.codeActionsDisposable\.clear\(\)/g);
  assert.match(multiDiff, /if \(this\._store\.isDisposed\) \{\n\s*return;/);
  assert.ok((app.match(/frame\.isDestroyed\(\)/g) ?? []).length >= 3);
  assert.match(textMate, /this\._vscodeOniguruma = null;\n\s*throw error;/);
});
