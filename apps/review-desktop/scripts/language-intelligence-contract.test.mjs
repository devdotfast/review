import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reviewMain = readFileSync(
  new URL("../code-oss/src/vs/review/review.common.main.ts", import.meta.url),
  "utf8",
);
const workspaceFolderContribution = readFileSync(
  new URL(
    "../code-oss/src/vs/review/contrib/workspace/reviewWorkspaceFolder.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewDesktopMain = readFileSync(
  new URL(
    "../code-oss/src/vs/review/electron-browser/review.main.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewDesktopManifest = readFileSync(
  new URL(
    "../code-oss/src/vs/review/review.desktop.main.ts",
    import.meta.url,
  ),
  "utf8",
);
const mainThreadExtensionService = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/api/browser/mainThreadExtensionService.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewExtensionHost = readFileSync(
  new URL(
    "../code-oss/src/vs/review/reviewExtensionHost.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);
const unsupportedApiPeers = readFileSync(
  new URL(
    "../code-oss/src/vs/review/reviewExtensionHostUnsupportedApiPeers.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewServices = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewWorkbenchServices.ts",
    import.meta.url,
  ),
  "utf8",
);
const resources = readFileSync(
  new URL(
    "../code-oss/src/vs/review/common/reviewCodeResources.ts",
    import.meta.url,
  ),
  "utf8",
);
const codeResourceService = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewCodeResourceService.ts",
    import.meta.url,
  ),
  "utf8",
);
const inlineEditorService = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewInlineEditorService.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewCanvas = readFileSync(
  new URL(
    "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
    import.meta.url,
  ),
  "utf8",
);

test("Review exposes a language-provider-generic extension host seam", () => {
  assert.match(reviewMain, /languageFeaturesService/);
  assert.match(reviewMain, /builtinExtensionsScannerService/);
  assert.match(reviewMain, /reviewExtensionHost\.contribution/);
  assert.doesNotMatch(reviewMain, /api\/browser\/extensionHost\.contribution/);
  assert.match(reviewDesktopMain, /ReviewDefaultAccountService/);
  assert.doesNotMatch(
    reviewDesktopMain,
    /services\/accounts\/browser\/defaultAccount/,
  );
  assert.match(reviewServices, /IExtensionsWorkbenchService/);
  assert.match(reviewServices, /class ReviewQuickDiffModelService/);
  assert.match(reviewServices, /registerSingleton\(IQuickDiffModelService,/);
  assert.doesNotMatch(reviewMain, /quickDiff\.contribution/);
  assert.doesNotMatch(reviewMain, /QuickDiffModelService/);
  assert.match(resources, /reviewHeadFileUri/);
  assert.match(
    mainThreadExtensionService,
    /ExtHostCustomersRegistry\.getNamedCustomers\(\)/,
  );
  for (const participant of [
    "mainThreadDebugService",
    "mainThreadDocuments",
    "mainThreadExtensionService",
    "mainThreadLanguageFeatures",
    "mainThreadLanguages",
  ]) {
    assert.match(reviewExtensionHost, new RegExp(participant));
  }
  assert.match(reviewExtensionHost, /reviewExtensionHostUnsupportedApiPeers/);
  for (const participant of [
    "MainThreadAuthentication",
    "MainThreadLanguageModelTools",
    "MainThreadTask",
    "MainThreadTerminalService",
    "MainThreadUrls",
  ]) {
    assert.match(unsupportedApiPeers, new RegExp(participant));
  }
  assert.doesNotMatch(reviewExtensionHost, /mainThreadChatAgents/);
  assert.doesNotMatch(reviewExtensionHost, /mainThreadSCM/);
  assert.doesNotMatch(reviewExtensionHost, /mainThreadUriOpeners/);
  assert.doesNotMatch(
    `${reviewServices}\n${resources}`,
    /typescript-language-features|javascript-language-features/,
  );
});

test("CodePeeks retain the same file-backed models as native file diffs", () => {
  assert.doesNotMatch(codeResourceService, /scheme:\s*["']review-peek["']/);
  assert.doesNotMatch(codeResourceService, /createDiffSlice/);
  assert.match(inlineEditorService, /MultiDiffEditorInput/);
  assert.doesNotMatch(inlineEditorService, /new MultiDiffEditorViewModel/);
  assert.doesNotMatch(inlineEditorService, /RefCounted/);
  assert.doesNotMatch(inlineEditorService, /createChild/);
  assert.match(inlineEditorService, /setHiddenAreas/);
});

test("the Review canvas exposes its focused CodePeek through VS Code's composite editor contract", () => {
  assert.match(inlineEditorService, /ICompositeCodeEditor/);
  assert.match(inlineEditorService, /activeCodeEditor/);
  assert.match(inlineEditorService, /onDidChangeActiveEditor/);
  assert.match(
    reviewCanvas,
    /reviewInstantiationService\.createInstance\(ReviewInlineEditorService\)/,
  );
  assert.doesNotMatch(
    reviewMain,
    /registerSingleton\(\s*IReviewInlineEditorService/,
  );
  assert.match(reviewCanvas, /getControl\(\)/);
  assert.match(reviewCanvas, /return this\.inlineEditors;/);
  assert.match(reviewCanvas, /inlineEditors\.onDidChangeActiveEditor/);
});

test("the workbench workspace folder follows the reviewed repository", () => {
  // Without a folder the workspace is empty, so `workspaceContains:` never
  // fires and language servers answer single-file questions only.
  assert.match(
    reviewMain,
    /contrib\/workspace\/reviewWorkspaceFolder\.contribution\.js/,
  );
  assert.match(
    workspaceFolderContribution,
    /registerWorkbenchContribution2\([\s\S]*WorkbenchPhase\.BlockRestore/,
  );
  assert.match(workspaceFolderContribution, /IWorkspaceEditingService/);
  assert.match(workspaceFolderContribution, /IReviewSessionModelService/);
  assert.match(workspaceFolderContribution, /onDidChangeActiveModel/);
  assert.match(workspaceFolderContribution, /activeModel\?\.session/);
});

test("changing the workspace folder never restarts the extension host", () => {
  // The folder shim mutates in memory; a reload would discard the folders and
  // a host restart would drop every warm language server on each switch.
  assert.doesNotMatch(workspaceFolderContribution, /stopExtensionHosts/);
  assert.doesNotMatch(workspaceFolderContribution, /startExtensionHosts/);
  assert.doesNotMatch(workspaceFolderContribution, /reloadWindow/);
});

test("Review wires the real update service, not the stock update UI", () => {
  // Review used to register an inert IUpdateService stub, so the renderer never
  // saw an update state and the app updated with no user-visible sign of it.
  assert.doesNotMatch(reviewServices, /IUpdateService/);
  assert.match(
    reviewDesktopManifest,
    /services\/update\/electron-browser\/updateService\.js/,
  );
  assert.match(
    reviewDesktopManifest,
    /contrib\/update\/reviewUpdate\.contribution\.js/,
  );
  // The stock contribution's title bar entry requires IChatService, which
  // Review does not register — importing it would fail to instantiate.
  assert.doesNotMatch(
    reviewDesktopManifest,
    /contrib\/update\/browser\/update\.contribution/,
  );
});
