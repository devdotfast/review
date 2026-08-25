import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ReviewModuleImporter,
  importReviewModule,
  reviewApiUrl,
  reviewFetch,
  reviewStorageKey,
  reviewWasmUrl,
  rewriteReviewDocumentRuntime,
} from "./review-client";

const injectedConfig = {
  serverUrl: "http://127.0.0.1:5570",
  sessionUrl: "http://127.0.0.1:5570/sessions/desktop-session",
  routePath: "/pr/42",
  sessionId: "desktop-session",
  token: "secret-token",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  docRuntimeUrl: "vscode-file://review/doc-runtime.js",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies ReviewRuntimeConfig;

const reviewModuleSource =
  'import { createActiveReviewDocument } from "review-doc-runtime";\nexport const version = 1;';
let moduleUrlSequence = 0;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review host client", () => {
  it("uses injected desktop routing and asset configuration", () => {
    expect(injectedConfig.host).toBe("desktop");
    expect(injectedConfig.routePath).toBe("/pr/42");
    expect(reviewApiUrl(injectedConfig, "/diff-files")).toBe(
      "http://127.0.0.1:5570/sessions/desktop-session/__progressive-review/diff-files?document=%2Fpr%2F42",
    );
    expect(reviewWasmUrl(injectedConfig)).toBe(
      "vscode-file://review/libavoid.wasm",
    );
    expect(reviewStorageKey(injectedConfig, "files", "main", "head")).toBe(
      "progressive-review:files:desktop-session:/pr/42:main:head",
    );
  });

  it("adds the desktop bearer token to API requests", async () => {
    let requestInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetchMock);

    await reviewFetch(injectedConfig, "/session");

    expect(new Headers(requestInit?.headers).get("x-review-token")).toBe(
      "secret-token",
    );
  });

  it("rewrites each document rebuild to the current bundled runtime URL", () => {
    const source =
      'import { createActiveReviewDocument } from "review-doc-runtime";\nexport const version = 1;';
    expect(
      rewriteReviewDocumentRuntime(
        source,
        "vscode-file://review/assets/doc-runtime-first.js",
      ),
    ).toContain("vscode-file://review/assets/doc-runtime-first.js");
    expect(
      rewriteReviewDocumentRuntime(
        source.replace("version = 1", "version = 2"),
        "vscode-file://review/assets/doc-runtime-second.js",
      ),
    ).toContain("vscode-file://review/assets/doc-runtime-second.js");
    expect(() =>
      rewriteReviewDocumentRuntime(
        "export const version = 3;",
        "vscode-file://review/assets/doc-runtime.js",
      ),
    ).toThrow("no runtime import");
  });

  it("retries a rejected document module import", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response(reviewModuleSource),
    );
    vi.stubGlobal("fetch", fetchMock);
    const namespace = { version: 2 };
    let documentAttempts = 0;
    const { importer } = documentImporter(async () => {
      documentAttempts += 1;
      if (documentAttempts === 1) {
        throw new Error("module evaluation failed");
      }
      return namespace;
    });
    const moduleUrl = uniqueModuleUrl("retry");

    await expect(
      importReviewModule(injectedConfig, moduleUrl, importer),
    ).rejects.toThrow("module evaluation failed");
    await expect(
      importReviewModule(injectedConfig, moduleUrl, importer),
    ).resolves.toBe(namespace);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(documentAttempts).toBe(2);
  });

  it("imports the same document URL again for a different runtime URL", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response(reviewModuleSource),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { importer } = documentImporter(async () => ({
      call: fetchMock.mock.calls.length,
    }));
    const moduleUrl = uniqueModuleUrl("runtime");

    const first = await importReviewModule(injectedConfig, moduleUrl, importer);
    const second = await importReviewModule(
      {
        ...injectedConfig,
        docRuntimeUrl: "vscode-file://review/doc-runtime-next.js",
      },
      moduleUrl,
      importer,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });
});

// The loader imports the runtime module for the request context, then the
// rewritten document blob. Route blob imports to the document namespace and
// everything else to a runtime stub.
function documentImporter(importDocument: () => Promise<unknown>): {
  importer: ReviewModuleImporter;
  setReviewRequestContext: ReturnType<
    typeof vi.fn<(context: { origin?: string; token?: string }) => void>
  >;
} {
  const setReviewRequestContext =
    vi.fn<(context: { origin?: string; token?: string }) => void>();
  const importer = vi.fn<ReviewModuleImporter>(async (url) =>
    url.startsWith("blob:") ? importDocument() : { setReviewRequestContext },
  );
  return { importer, setReviewRequestContext };
}

function uniqueModuleUrl(name: string): string {
  moduleUrlSequence += 1;
  return `http://127.0.0.1:5570/doc-modules/${name}-${moduleUrlSequence}.js`;
}
