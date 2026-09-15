import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

test("Review Files handles missing source locally and releases partial models", () => {
  // Run the real browser model loader in its own DOM environment. Reuse
  // Review's jsdom test dependency; tsx supplies Code OSS decorator semantics.
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      String.raw`
    import assert from "node:assert/strict";
    import { createRequire, registerHooks } from "node:module";
    const require = createRequire(new URL("../../packages/review/package.json", import.meta.url));
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<html><body></body></html>");
    for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "Element", "navigator", "customElements", "UIEvent", "MouseEvent", "KeyboardEvent"]) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    registerHooks({ load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    } });
    const native = "./code-oss/src/vs/";
    const { MultiDiffEditorInput } = await import(native + "workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.ts");
    const { MultiDiffEditorItem } = await import(native + "workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts");
    const { Event } = await import(native + "base/common/event.ts");
    const { URI } = await import(native + "base/common/uri.ts");
    const { errorHandler, setUnexpectedErrorHandler } = await import(native + "base/common/errors.ts");
    const { FileOperationError, FileOperationResult } = await import(native + "platform/files/common/files.ts");
    const originalConsole = console.error;
    const previous = errorHandler.getUnexpectedErrorHandler();
    const logged = [];
    const reported = [];
    console.error = error => logged.push(error);
    setUnexpectedErrorHandler(error => reported.push(error));
    try {
      for (const [scheme, result, expectedReports] of [
        ["devfast-review-files", FileOperationResult.FILE_NOT_FOUND, 0],
        ["devfast-review-files", FileOperationResult.FILE_PERMISSION_DENIED, 1],
        ["multi-diff-editor", FileOperationResult.FILE_NOT_FOUND, 1],
      ]) {
        for (const missingSide of ["base", "head"]) {
          logged.length = reported.length = 0;
          const error = new FileOperationError("source unavailable", result);
          let fail = true;
          let open = 0;
          let released = 0;
          let resume;
          const ready = new Promise(resolve => { resume = resolve; });
          const input = new MultiDiffEditorInput(
            URI.from({ scheme, path: "/session" }), "Files",
            [new MultiDiffEditorItem(URI.file("/base"), URI.file("/head"), URI.file("/head"))], true,
            { async createModelReference(resource) {
              if (fail && resource.path === "/" + missingSide) throw error;
              if (fail) await ready;
              open++;
              return { object: { textEditorModel: { uri: resource }, isReadonly: () => true }, dispose() { open--; released++; } };
            } },
            { getValue: () => ({}), onDidChangeConfiguration: Event.None }, {}, {},
            { files: { onDidChangeDirty: Event.None }, isDirty: () => false },
          );
          let model;
          try {
            // Exercise the same loader used by getViewModel without constructing
            // editor widgets. This is runtime invocation, not source inspection.
            const pending = input._createModel();
            await new Promise(resolve => setImmediate(resolve));
            resume();
            model = await pending;
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(model.documents.value.length, 0);
            assert.equal(open, 0);
            assert.equal(released, 1);
            assert.equal(logged.length, expectedReports);
            assert.equal(reported.length, expectedReports);
            if (expectedReports) {
              assert.strictEqual(logged[0], error);
              assert.strictEqual(reported[0], error);
            }
            model.dispose();
            model = undefined;
            fail = false;
            model = await input._createModel();
            assert.equal(model.documents.value.length, 1);
            assert.equal(open, 2);
          } finally {
            resume();
            model?.dispose();
            input.dispose();
          }
          assert.equal(open, 0);
        }
      }
    } finally {
      console.error = originalConsole;
      setUnexpectedErrorHandler(previous);
      dom.window.close();
    }
  `,
    ],
    {
      cwd: desktopRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.test.json" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
});
