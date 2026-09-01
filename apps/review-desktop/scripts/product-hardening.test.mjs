import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const product = JSON.parse(
  await readFile(new URL("../code-oss/product.json", import.meta.url), "utf8"),
);
const webviewPreloader = await readFile(
  new URL(
    "../code-oss/src/vs/workbench/contrib/webview/browser/pre/index.html",
    import.meta.url,
  ),
  "utf8",
);
const reviewCanvasPart = await readFile(
  new URL(
    "../code-oss/src/vs/review/browser/parts/canvas/reviewCanvasPart.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewConfiguration = await readFile(
  new URL(
    "../code-oss/src/vs/review/common/reviewConfigurationDefaults.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewUserConfigImport = await readFile(
  new URL(
    "../code-oss/src/vs/review/node/reviewUserConfigImport.ts",
    import.meta.url,
  ),
  "utf8",
);

test("keeps Review disconnected from Microsoft update and extension services", () => {
  assert.equal(product.enableTelemetry, false);
  assert.equal(product.extensionsGallery, null);
  assert.deepEqual(product.builtInExtensions, []);
  // Review must never fall back to Microsoft's update service; the sanctioned
  // feed below is the only one it may contact.
  assert.notEqual(product.updateUrl, "https://update.code.visualstudio.com");
});

test("updates only from the sanctioned dev.fast feed", () => {
  assert.equal(product.updateUrl, "https://update.dev.fast");
  assert.equal(
    product.quality,
    process.env.REVIEW_EXPECTED_QUALITY ?? "stable",
  );
});

test("publishes the release number the About panel shows", async () => {
  // The About panel reads `reviewVersion`, because `version` is the Code OSS
  // base version. Nothing else keeps the two files together, so a release that
  // bumps only package.json must fail here rather than ship a stale number.
  const appPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(product.reviewVersion, appPackage.version);
});

test("owns every install identity rather than sharing Code OSS's", () => {
  // These name the singleton mutexes, the Windows installer registration, and
  // the shared storage directory. Left at their upstream values they collide
  // with a real Code OSS or VS Code install on the same machine: one app's
  // installer blocks on the other's running process, and both write the same
  // sharedStorage database.
  assert.equal(product.sharedDataFolderName, ".dev-fast-review-shared");
  assert.equal(product.win32MutexName, "devfastreview");
  assert.equal(product.win32TunnelMutex, "devfastreview-tunnel");
  assert.equal(product.win32TunnelServiceMutex, "devfastreview-tunnelservice");
  assert.equal(product.win32AppUserModelId, "devfast.Review");

  const appIds = [
    product.win32x64AppId,
    product.win32arm64AppId,
    product.win32x64UserAppId,
    product.win32arm64UserAppId,
  ];
  // Stock Code OSS product GUIDs; a Review installer sharing one would be
  // mistaken for a Code OSS install by the Inno uninstall-key probe.
  const codeOssAppIds = new Set([
    "{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}",
    "{{D1ACE434-89C5-48D1-88D3-E2991DF85475}",
    "{{CC6B787D-37A0-49E8-AE24-8559A032BE0C}",
    "{{3AEBF0C8-F733-4AD4-BADE-FDB816D53D7B}",
  ]);
  assert.equal(new Set(appIds).size, 4, "each install target needs its own id");
  for (const appId of appIds) {
    assert.ok(!codeOssAppIds.has(appId), `${appId} is a Code OSS product id`);
    // Inno Setup escapes a literal "{" as "{{".
    assert.match(
      appId,
      /^\{\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/,
      `${appId} is not a brace-escaped GUID`,
    );
  }
});

test("keeps upstream identity out of the fields Review has claimed", () => {
  // A re-vendor rewrites product.json wholesale, so guard the values above
  // against silently reverting to anything Code OSS- or Microsoft-branded.
  const claimedKeys = [
    "nameShort",
    "nameLong",
    "applicationName",
    "dataFolderName",
    "sharedDataFolderName",
    "darwinBundleIdentifier",
    "urlProtocol",
    "linuxIconName",
    "win32MutexName",
    "win32TunnelMutex",
    "win32TunnelServiceMutex",
    "win32AppUserModelId",
    "win32DirName",
    "win32NameVersion",
    "win32RegValueName",
    "win32ShellNameShort",
  ];
  for (const key of claimedKeys) {
    const value = product[key];
    assert.equal(typeof value, "string", key);
    assert.doesNotMatch(value, /vscode|Microsoft|code-oss|CodeOSS/i, key);
  }
});

test("removes dormant Microsoft endpoint configuration that is safe to omit", () => {
  for (const key of [
    "agentsTelemetryAppName",
    "reportIssueUrl",
    "trustedExtensionAuthAccess",
    "voiceWsUrl",
    "webviewContentExternalBaseUrlTemplate",
  ]) {
    assert.equal(product[key], undefined, key);
  }
  assert.equal(product.defaultChatAgent.extensionId, "GitHub.copilot");
  assert.equal(product.defaultChatAgent.chatExtensionId, "GitHub.copilot-chat");
});

// Desktop Code OSS never reads `configurationDefaults` from product.json — only the
// extension contribution point and the web workbench options carry that name. Keeping
// a copy there reads as hardening while applying nothing, so the block is gone and
// `reviewConfigurationDefaults.ts` is the single channel.
test("keeps product.json free of defaults nothing reads", () => {
  assert.equal(product.configurationDefaults, undefined);
});

test("uses VSCodium-derived opt-out defaults", () => {
  for (const [key, value] of [
    ["telemetry.telemetryLevel", "'off'"],
    ["telemetry.enableTelemetry", "false"],
    ["telemetry.enableCrashReporter", "false"],
    ["telemetry.editStats.enabled", "false"],
    ["workbench.enableExperiments", "false"],
    [
      "workbench.commandPalette.experimental.enableNaturalLanguageSearch",
      "false",
    ],
    ["workbench.settings.enableNaturalLanguageSearch", "false"],
  ]) {
    assert.match(
      reviewConfiguration,
      new RegExp(`'${key.replaceAll(".", "\\.")}': ${value},`),
      key,
    );
  }
});

test("blocks every Review hardening default from user-config import", () => {
  const defaults = reviewConfiguration.match(
    /reviewConfigurationDefaults\s*=\s*\{([\s\S]*?)\}\s*as const/,
  );
  assert.ok(defaults, "reviewConfigurationDefaults declaration");
  const keys = [...defaults[1].matchAll(/'([^']+)':/g)].map(
    (match) => match[1],
  );
  assert.ok(keys.length > 0);
  assert.match(
    reviewUserConfigImport,
    /Object\.keys\(reviewConfigurationDefaults\)/,
  );
  // Otherwise a VS Code user who runs Pylance imports
  // `python.languageServer: "Pylance"` and re-arms the install prompt.
  assert.match(
    reviewUserConfigImport,
    /Object\.keys\(curatedExtensionConfigurationDefaults\)/,
  );
  assert.match(
    reviewUserConfigImport,
    /BLOCKED_SETTING_KEYS\.has\(key\)/,
  );
});

test("guards the active webview frame body while tracking focus", () => {
  assert.match(
    webviewPreloader,
    /target && target\.contentDocument && target\.contentDocument\.body && target\.contentDocument\.body\.classList\.contains\('vscode-context-menu-visible'\)/,
  );
});

test("configures Zod's CSP-safe mode before the canvas module evaluates", () => {
  const candidateConfig = reviewCanvasPart.indexOf(
    "canvasGlobal.__zod_globalConfig ??= {};",
  );
  const candidateModule = reviewCanvasPart.indexOf(
    "vs/review/canvas/canvas-loader.js",
  );
  assert.notEqual(candidateConfig, -1);
  assert.notEqual(candidateModule, -1);
  assert.ok(candidateConfig < candidateModule);
  assert.match(
    reviewCanvasPart,
    /canvasGlobal\.__zod_globalConfig\.jitless = true;/,
  );
});
