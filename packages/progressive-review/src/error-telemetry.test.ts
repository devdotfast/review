import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  deriveErrorTelemetryProperties,
  mergeErrorTelemetryProperties,
  packBundleFrames,
} from "./error-telemetry";
import { sanitizeUiTelemetryEvent } from "./ui-telemetry-events";

// A stack of the shape Review actually sees: two frames inside the packaged
// app, one inside the packed canvas, and three that belong to the user.
const MIXED_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'uri')",
  "    at handleUnexpectedError (vscode-file://vscode-app/Applications/Review.app/Contents/Resources/app/out/vs/review/browser/workbench.js:456:12)",
  "    at emit (vscode-file://vscode-app/Applications/Review.app/Contents/Resources/app/out/vs/base/common/errors.js:78:3)",
  "    at r (vscode-file://vscode-app/Applications/Review.app/Contents/Resources/app/out/review-runtime/assets/canvas-a1b2c3.js:1:284712)",
  "    at loadPlan (file:///Users/alice/secret-repo/src/plan.ts:12:9)",
  "    at Object.render (/Users/alice/secret-repo/node_modules/react-dom/index.js:4:1)",
  "    at C:\\Users\\alice\\secret-repo\\build\\out\\bundle.js:7:2",
].join("\n");

const USER_TOKENS = [
  "alice",
  "secret-repo",
  "node_modules",
  "Users",
  "plan.ts",
];

describe("packBundleFrames", () => {
  it("keeps shipped frames and drops everything else", () => {
    expect(packBundleFrames(MIXED_STACK)).toBe(
      [
        "vs/review/browser/workbench.js:456:12",
        "vs/base/common/errors.js:78:3",
        "assets/canvas-a1b2c3.js:1:284712",
      ].join("|"),
    );
  });

  it("leaves no trace of the user's machine", () => {
    const frames = packBundleFrames(MIXED_STACK) ?? "";
    for (const token of USER_TOKENS) expect(frames).not.toContain(token);
  });

  it("drops a frame whose only anchor is a user directory named out", () => {
    expect(
      packBundleFrames(
        "    at build (/Users/alice/secret-repo/out/secret.js:3:1)",
      ),
    ).toBeUndefined();
  });

  it("keeps the Electron entry files, where a pre-start crash lands", () => {
    expect(
      packBundleFrames(
        [
          "TypeError: cannot load main",
          "    at startup (file:///Users/alice/Review.app/out/main.js:164:8)",
          "    at onReady (file:///Users/alice/Review.app/out/bootstrap-esm.js:12:3)",
        ].join("\n"),
      ),
    ).toBe("main.js:164:8|bootstrap-esm.js:12:3");
  });

  it("strips a cache-busting query", () => {
    expect(
      packBundleFrames(
        "    at r (https://localhost/out/vs/review/browser/workbench.js?v=9:1:2)",
      ),
    ).toBe("vs/review/browser/workbench.js:1:2");
  });

  it("reads the Firefox and bare stack forms", () => {
    expect(
      packBundleFrames(
        "handleUnexpectedError@file:///app/out/vs/review/browser/workbench.js:5:6",
      ),
    ).toBe("vs/review/browser/workbench.js:5:6");
    expect(packBundleFrames(["/app/out/vs/base/common/errors.js:1:1"])).toBe(
      "vs/base/common/errors.js:1:1",
    );
  });

  it("reports at most ten frames", () => {
    const deep = Array.from(
      { length: 40 },
      (_unused, index) =>
        `    at f (/app/out/vs/base/common/errors.js:${index + 1}:1)`,
    ).join("\n");
    expect(packBundleFrames(deep)?.split("|")).toHaveLength(10);
  });

  it("returns nothing for a stack it cannot read", () => {
    expect(packBundleFrames(undefined)).toBeUndefined();
    expect(packBundleFrames("")).toBeUndefined();
    expect(packBundleFrames({ stack: "no" })).toBeUndefined();
  });
});

describe("deriveErrorTelemetryProperties", () => {
  const raw = {
    name: "TypeError",
    message: "Cannot read /Users/alice/secret-repo/plan.md on branch fix/oops",
    stack: MIXED_STACK,
  };

  it("keeps a plain engine message as it is", () => {
    expect(
      deriveErrorTelemetryProperties({
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'uri')",
      }).message,
    ).toBe("Cannot read properties of undefined (reading 'uri')");
  });

  it("replaces every path in a message and keeps the rest", () => {
    const derived = deriveErrorTelemetryProperties(raw);
    expect(derived.message).toBe(
      "Cannot read <REDACTED: user-file-path> on branch <REDACTED: user-file-path>",
    );
    expect(derived.message_hash).toMatch(/^[0-9a-f]{16}$/);
    const serialized = JSON.stringify(derived);
    for (const token of [...USER_TOKENS, "fix/oops"]) {
      expect(serialized).not.toContain(token);
    }
  });

  it("keeps the useful half of a file error and drops the path", () => {
    expect(
      deriveErrorTelemetryProperties({
        name: "Error",
        message:
          "ENOENT: no such file or directory, open '/Users/alice/secret-repo/review.json'",
      }).message,
    ).toBe(
      "ENOENT: no such file or directory, open '<REDACTED: user-file-path>'",
    );
  });

  it("replaces the whole path even under the reporting machine's own home", () => {
    // VS Code deletes its known directories as a prefix, which would leave
    // "/work/acme-repo/plan.md" — the repository name intact. Review gives the
    // cleaner no directories to delete so the whole path goes.
    expect(
      deriveErrorTelemetryProperties({
        name: "Error",
        message: `ENOENT: open '${homedir()}/work/acme-repo/plan.md'`,
      }).message,
    ).toBe("ENOENT: open '<REDACTED: user-file-path>'");
  });

  it("replaces an address, an e-mail address and a token with markers", () => {
    const message = (text: string): string | undefined =>
      deriveErrorTelemetryProperties({ name: "Error", message: text }).message;

    expect(message("no account for alice@example.com")).toBe(
      "<REDACTED: Email>",
    );
    expect(
      message("bad credential ghp_012345678901234567890123456789012345"),
    ).toBe("<REDACTED: GitHub Token>");
    expect(message("api_key was rejected")).toBe("<REDACTED: Generic Secret>");
    // A web address is path-shaped, so the path pass reaches it first. Either
    // marker is fine; what matters is that no part of the address survives.
    const url = message(
      "request to https://github.example/alice/secret failed",
    );
    expect(url).toMatch(/^request to .*<REDACTED: [^>]+>.* failed$/);
    for (const token of ["github.example", "alice", "secret"]) {
      expect(url).not.toContain(token);
    }
  });

  it("keeps a marker even though the marker names a secret", () => {
    // "<REDACTED: GitHub Token>" contains the word "token", which the secret
    // rule matches. The second check must not re-flag the cleaner's own output.
    expect(
      deriveErrorTelemetryProperties({
        name: "Error",
        message: "bad credential ghp_012345678901234567890123456789012345",
      }).message,
    ).toBeDefined();
  });

  it("sends no message for a schema error, which quotes the document", () => {
    const derived = deriveErrorTelemetryProperties({
      name: "ZodError",
      message: 'messages[0].from received string "HeyGen"',
    });
    expect(derived.message).toBeUndefined();
    expect(derived.error_name).toBe("ZodError");
    expect(derived.message_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("always returns a digest, cleaned message or not", () => {
    expect(deriveErrorTelemetryProperties(raw).message_hash).toBeDefined();
    expect(
      deriveErrorTelemetryProperties({ name: "Error", message: "plain" })
        .message_hash,
    ).toBeDefined();
  });

  it("gives the same digest for the same cause", () => {
    expect(deriveErrorTelemetryProperties(raw).message_hash).toBe(
      deriveErrorTelemetryProperties({ ...raw }).message_hash,
    );
    expect(deriveErrorTelemetryProperties(raw).message_hash).not.toBe(
      deriveErrorTelemetryProperties({ ...raw, message: "other" }).message_hash,
    );
  });

  it("keeps the class name only when it is identifier-like", () => {
    expect(deriveErrorTelemetryProperties(raw).error_name).toBe("TypeError");
    expect(
      deriveErrorTelemetryProperties({ name: "/Users/alice/oops" }).error_name,
    ).toBeUndefined();
  });

  it("refuses error fields a client tried to assert", () => {
    // The allowlist cannot tell a cleaned message from a raw one, so provenance
    // is enforced here instead: these three come from the envelope or not at
    // all. Without this a canvas could post a raw message and reach PostHog.
    const merged = mergeErrorTelemetryProperties(
      {
        error_source: "document",
        error_name: "ZodError",
        message: 'messages[0].from received string "HeyGen"',
        message_hash: "0000000000000000",
        frames: "vs/review/browser/workbench.js:1:1",
      },
      undefined,
    );
    expect(merged).toEqual({
      error_source: "document",
      error_name: "ZodError",
    });
  });

  it("lets the derived fields win over a client's own", () => {
    const merged = mergeErrorTelemetryProperties(
      { message: "trust me", message_hash: "0000000000000000" },
      { name: "TypeError", message: "Cannot read properties of undefined" },
    );
    expect(merged.message).toBe("Cannot read properties of undefined");
    expect(merged.message_hash).not.toBe("0000000000000000");
  });

  it("never throws on hostile input", () => {
    for (const input of [undefined, null, 42, "boom", [], { stack: 1 }]) {
      expect(() => deriveErrorTelemetryProperties(input)).not.toThrow();
    }
  });

  it("survives the allowlist that runs after it", () => {
    const sanitized = sanitizeUiTelemetryEvent({
      name: "client_error",
      properties: {
        error_source: "renderer_unexpected",
        error_process: "renderer",
        ...deriveErrorTelemetryProperties({
          ...raw,
          message: "Cannot read properties of undefined (reading 'uri')",
        }),
      },
    });
    expect(sanitized?.properties).toEqual({
      error_source: "renderer_unexpected",
      error_process: "renderer",
      error_name: "TypeError",
      message: "Cannot read properties of undefined (reading 'uri')",
      message_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      frames: [
        "vs/review/browser/workbench.js:456:12",
        "vs/base/common/errors.js:78:3",
        "assets/canvas-a1b2c3.js:1:284712",
      ].join("|"),
    });
  });

  it("cleans a concise ShipIt failure before update telemetry is allowed", () => {
    const sanitized = sanitizeUiTelemetryEvent({
      name: "update_failed",
      properties: mergeErrorTelemetryProperties(
        { phase: "install", message_source: "shipit" },
        {
          name: "UpdateInstallError",
          message:
            'Error Domain=SQRLInstallerErrorDomain Code=-1 "Failed to copy bundle file:///Users/alice/Review.app to directory file:///Applications"',
        },
      ),
    });
    expect(sanitized?.properties).toEqual({
      phase: "install",
      message_source: "shipit",
      error_name: "UpdateInstallError",
      message: expect.stringContaining("<REDACTED:"),
      message_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(JSON.stringify(sanitized)).not.toContain("alice");
  });
});
