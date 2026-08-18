import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoBlockedReviewRequests,
  blockedReviewRequestReason,
} from "./review-network-policy.mjs";

test("blocks disabled Microsoft service and asset hosts", () => {
  for (const url of [
    "https://mobile.events.data.microsoft.com/OneCollector/1.0",
    "https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest",
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    "https://cdn.vsassets.io/v/M123/file.js",
    "https://abc.vscode-cdn.net/stable/pre/index.html",
    "wss://falcon-caas.mai.microsoft.com/voice-code/api/v1/realtime/voice",
    "https://aka.ms/github-copilot-overview",
    "https://vscode.blob.core.windows.net/gallery/index",
    "https://vscode.download.prss.microsoft.com/dbazure/download/stable/file",
  ]) {
    assert.ok(blockedReviewRequestReason(url), url);
  }
});

test("blocks Copilot API paths without blocking ordinary GitHub API use", () => {
  assert.ok(
    blockedReviewRequestReason(
      "https://api.github.com/copilot_internal/v2/token",
    ),
  );
  assert.ok(
    blockedReviewRequestReason("https://api.github.com/copilot/mcp_registry"),
  );
  assert.equal(
    blockedReviewRequestReason(
      "https://api.github.com/repos/Fix-Fast/dev/pulls/1",
    ),
    undefined,
  );
});

test("allows local Review resources and non-service protocols", () => {
  for (const url of [
    "http://localhost:3000/api/review",
    "http://127.0.0.1:3000/api/review",
    "vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html",
    "vscode-webview://review/index.html",
    "data:text/plain,review",
    "https://open-vsx.org/api/swiftlang/swift-vscode",
  ]) {
    assert.equal(blockedReviewRequestReason(url), undefined, url);
  }
  assert.doesNotThrow(() =>
    assertNoBlockedReviewRequests([
      "http://localhost:3000/api/review",
      "https://api.github.com/repos/Fix-Fast/dev",
    ]),
  );
});

test("reports each blocked request once", () => {
  assert.throws(
    () =>
      assertNoBlockedReviewRequests([
        "https://mobile.events.data.microsoft.com/OneCollector/1.0",
        "https://mobile.events.data.microsoft.com/OneCollector/1.0",
      ]),
    (error) => {
      assert.match(error.message, /disabled Microsoft or Copilot services/);
      assert.equal(
        error.message.match(/mobile\.events\.data\.microsoft\.com/g)?.length,
        2,
      );
      return true;
    },
  );
});
