import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

const sourceRoot = new URL("../code-oss/src/vs/", import.meta.url);

const require = createRequire(import.meta.url);

const noOp = () => {};

const decorators = new Proxy({}, { get: () => noOp });

// Execute the production methods with Electron/DI boundaries replaced. No
// native updater, user's installation, preferences, or network is touched.
function load(relative, imports = {}, appended = "") {
  const filename = new URL(relative, sourceRoot);

  const { outputText, diagnostics } = ts.transpileModule(
    readFileSync(filename, "utf8") + appended,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
      },
      reportDiagnostics: true,
      fileName: filename.pathname,
    },
  );

  assert.equal(diagnostics.length, 0);
  const module = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      process,
      require: (name) => {
        if (name in imports) return imports[name];

        if (name.startsWith("node:")) return require(name);

        if (/common\/instantiation.js$/.test(name))
          return { createDecorator: () => noOp };

        if (/common\/types.js$/.test(name)) return { upcast: (value) => value };

        return decorators;
      },
    },
    { filename: filename.pathname },
  );

  return module.exports;
}

const recovery = load("platform/update/common/darwinUpdateRecovery.ts");

const update = load("platform/update/common/update.ts");

const readOnlyError =
  "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";

function service() {
  let checks = 0;

  const { DarwinUpdateService } = load(
    "platform/update/electron-main/updateService.darwin.ts",
    {
      electron: {
        autoUpdater: {
          checkForUpdates: () => {
            checks++;
          },
        },
      },
      "./abstractUpdateService.js": { AbstractUpdateService: Object },
      "../common/update.js": update,
      "../common/darwinUpdateRecovery.js": recovery,
      "../../../base/common/hash.js": { hash: () => 0 },
    },
  );

  const instance = Object.create(DarwinUpdateService.prototype);
  Object.assign(instance, {
    quality: "stable",
    productService: { commit: "current" },
    telemetryService: { publicLog2: noOp },
    logService: { trace: noOp, error: noOp },
    meteredConnectionService: { isConnectionMetered: false },
    state: update.State.Idle(update.UpdateType.Archive),
    setState(state) {
      this.state = state;
    },
    getInternalOrg: () => undefined,
    getFailedUpdate: () => undefined,
    buildUpdateFeedUrl: () => "https://updates.example.test/",
  });

  return { instance, checks: () => checks };
}

test("native read-only failure is surfaced once and stops scheduled attempts for this process", () => {
  const { instance, checks } = service();
  instance.doCheckForUpdates(false);
  assert.equal(checks(), 1);
  instance.onError(readOnlyError);
  assert.equal(instance.state.error, readOnlyError);

  for (let hour = 0; hour < 3; hour++) instance.doCheckForUpdates(false);
  assert.equal(checks(), 1);
  assert.equal(instance.state.error, readOnlyError);
});

test("manual retry and a fresh process can recover after relocating the app", () => {
  const { instance, checks } = service();
  instance.doCheckForUpdates(false);
  instance.onError(readOnlyError);
  instance.doCheckForUpdates(true);
  assert.equal(checks(), 2);
  instance.onUpdateNotAvailable();
  instance.doCheckForUpdates(false);
  assert.equal(checks(), 3);
  const restarted = service();
  restarted.instance.doCheckForUpdates(false);
  assert.equal(restarted.checks(), 1);
});

test("ordinary update failures remain retryable and late native errors do not clobber Ready", () => {
  const { instance, checks } = service();
  instance.doCheckForUpdates(false);
  instance.onError("The Internet connection appears to be offline.");
  instance.doCheckForUpdates(false);
  assert.equal(checks(), 2);
  const ready = update.State.Ready({ version: "next" }, false, false);
  instance.state = ready;
  instance.onError(readOnlyError);
  assert.equal(instance.state, ready);
  instance.state = update.State.Idle(update.UpdateType.Archive);
  instance.doCheckForUpdates(false);
  assert.equal(checks(), 3);
});

test("recovery notice is sticky, deduplicated, and specific to native macOS read-only failures", () => {
  const notices = [];

  const { ReviewUpdateNotifications } = load(
    "review/contrib/update/reviewUpdate.contribution.ts",
    {
      "../../../base/common/lifecycle.js": { Disposable: Object },
      "../../../base/common/platform.js": { isMacintosh: true, isLinux: false },
      "../../../platform/actions/common/actions.js": {
        Action2: Object,
        registerAction2: noOp,
      },
      "../../../platform/update/common/update.js": update,
      "../../../platform/update/common/darwinUpdateRecovery.js": recovery,
      "../../../workbench/common/contributions.js": {
        WorkbenchPhase: {},
        registerWorkbenchContribution2: noOp,
      },
      "../../../nls.js": { localize: (_key, text) => text },
    },
    "\nexports.ReviewUpdateNotifications = ReviewUpdateNotifications;",
  );

  const instance = Object.create(ReviewUpdateNotifications.prototype);
  instance.notificationService = { notify: (notice) => notices.push(notice) };
  instance.onStateChange(
    update.State.Idle(update.UpdateType.Archive, "offline"),
  );
  assert.equal(notices.length, 0);
  const blocked = update.State.Idle(update.UpdateType.Archive, readOnlyError);
  instance.onStateChange(blocked);
  instance.onStateChange(blocked);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sticky, true);
  assert.match(notices[0].message, /Applications folder/);
  assert.match(notices[0].message, /disk image/);
});
