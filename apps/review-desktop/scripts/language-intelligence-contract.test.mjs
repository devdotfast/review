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
const reviewDesktopManifest = readFileSync(
  new URL(
    "../code-oss/src/vs/review/review.desktop.main.ts",
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
const mainThreadExtensionService = readFileSync(
  new URL(
    "../code-oss/src/vs/workbench/api/browser/mainThreadExtensionService.ts",
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
const inlineEditorService = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewInlineEditorService.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewDiffViewService = readFileSync(
  new URL(
    "../code-oss/src/vs/review/services/reviewDiffViewService.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewLspTelemetry = readFileSync(
  new URL(
    "../code-oss/src/vs/review/contrib/telemetry/reviewLspTelemetry.contribution.ts",
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
const keylessTelemetryClients = [
  {
    name: "JSON",
    manifest: JSON.parse(
      readFileSync(
        new URL(
          "../code-oss/extensions/json-language-features/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    source: readFileSync(
      new URL(
        "../code-oss/extensions/json-language-features/client/src/node/jsonClientMain.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  },
  {
    name: "HTML",
    manifest: JSON.parse(
      readFileSync(
        new URL(
          "../code-oss/extensions/html-language-features/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    source: readFileSync(
      new URL(
        "../code-oss/extensions/html-language-features/client/src/node/htmlClientMain.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  },
];

test("Review exposes a language-provider-generic extension host seam", () => {
  assert.match(
    mainThreadExtensionService,
    /ExtHostCustomersRegistry\.getNamedCustomers\(\)/,
  );
});

test("Review's module manifest loads its own extension-host seam and default-account service", () => {
  assert.match(reviewMain, /reviewExtensionHost\.contribution/);
  assert.doesNotMatch(reviewMain, /api\/browser\/extensionHost\.contribution/);
  assert.doesNotMatch(reviewMain, /quickDiff\.contribution/);
  assert.match(reviewServices, /registerSingleton\(IQuickDiffModelService,/);
  assert.match(reviewDesktopMain, /ReviewDefaultAccountService/);
  assert.doesNotMatch(
    reviewDesktopMain,
    /services\/accounts\/browser\/defaultAccount/,
  );
});

test("LSP telemetry attributes inline-peek usage only to editors the inline service owns", () => {
  // The in-tab diff is a real diff editor. Adopting its inner editors into the
  // inline-peek set would report their LSP use as inline_peek.
  assert.doesNotMatch(reviewDiffViewService, /registerExternalEditor/);
  assert.doesNotMatch(inlineEditorService, /registerExternalEditor/);
  assert.match(reviewLspTelemetry, /ReviewInlineEditorService\.owns\(editor\)/);
});

test("keyless bundled language clients skip their telemetry reporters", () => {
  for (const { name, manifest, source } of keylessTelemetryClients) {
    assert.equal(manifest.aiKey, undefined, `${name} manifest must stay keyless`);
    assert.match(
      source,
      /clientPackageJSON\.aiKey\s*\?\s*new TelemetryReporter\(clientPackageJSON\.aiKey\)\s*:\s*undefined/,
      `${name} must not construct telemetry with an absent key`,
    );
  }
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

// The contribution's behaviour is covered by
// `contrib/workspace/reviewWorkspaceFolder.contribution.test.ts`. What stays
// here is the wiring that test cannot see: that Review's module manifest loads
// the contribution at all, and that it registers for the right phase.
test("the workspace folder contribution is registered before restore", () => {
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
