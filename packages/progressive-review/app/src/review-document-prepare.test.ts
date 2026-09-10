import { parseJsonText } from "@dev.fast/review-protocol";
import { beforeEach, expect, it, vi } from "vitest";

import type { ReviewDocumentData } from "../../src/review-document-data";
import { reviewDocumentDataSchema } from "../../src/review-document-data";
import type { resolveCodePeekRequest } from "./code-peek-resolution";
import type { ReadyReviewDocumentLoad } from "./review-document-hydrate";
import { prepareReviewDocument } from "./review-document-prepare";
import { testReviewSession } from "./review-session-test-utils";

function documentData(): ReviewDocumentData {
  const anchor = {
    __kind: "db-anchor-ref" as const,
    id: "create-order",
    title: "Create order",
    peek: {
      __kind: "code-peek-ref" as const,
      props: { file: "src/orders.ts", fromLine: 3, toLine: 7 },
      resolution: null,
    },
  };
  return reviewDocumentDataSchema.parse(
    JSON.parse(
      JSON.stringify({
        format: "review-document/1",
        title: "Orders",
        routePath: "/",
        sourcePath: "review.mdx",
        anchors: { "create-order": anchor },
        anchorContents: { "create-order": "createOrder()" },
        softwareModels: [],
        body: [
          {
            type: "component",
            name: "CodePeek",
            props: { anchor },
            children: [],
          },
        ],
      }),
    ),
  );
}

let load: ReadyReviewDocumentLoad;
let resolveCodePeek: ReturnType<typeof vi.fn<typeof resolveCodePeekRequest>>;

beforeEach(() => {
  load = {
    state: "ready",
    contentHash: "document-hash",
    data: parseJsonText(JSON.stringify(documentData())),
  };
  resolveCodePeek = vi.fn<typeof resolveCodePeekRequest>();
  resolveCodePeek.mockResolvedValue({ snapshot: { roots: [], resolved: {} } });
});

it("hydrates a content hash once per session and resolves its peeks", async () => {
  const session = testReviewSession();

  const first = await prepareReviewDocument(load, session, {
    resolveCodePeek,
  });

  expect(await prepareReviewDocument(load, session, { resolveCodePeek })).toBe(
    first,
  );
  expect(resolveCodePeek).toHaveBeenCalledOnce();
  expect(resolveCodePeek).toHaveBeenCalledWith(
    "/",
    { file: "src/orders.ts", fromLine: 3, toLine: 7 },
    session,
  );
  expect(session.documents.get("document-hash")).toBeDefined();
  expect(first.anchors.get("create-order")?.peek?.resolution).toEqual({
    snapshot: { roots: [], resolved: {} },
  });
});

it("keeps a second session's hydration separate", async () => {
  const firstSession = testReviewSession();
  const secondSession = testReviewSession();

  const first = await prepareReviewDocument(load, firstSession, {
    resolveCodePeek,
  });
  const second = await prepareReviewDocument(load, secondSession, {
    resolveCodePeek,
  });

  expect(second).not.toBe(first);
  expect(resolveCodePeek).toHaveBeenCalledTimes(2);
  expect(resolveCodePeek.mock.calls.map((call) => call[2])).toEqual([
    firstSession,
    secondSession,
  ]);
});

it("shares concurrent preparation and keeps content hashes separate", async () => {
  const session = testReviewSession();
  const resolution =
    Promise.withResolvers<Awaited<ReturnType<typeof resolveCodePeekRequest>>>();
  resolveCodePeek.mockReturnValue(resolution.promise);

  const first = prepareReviewDocument(load, session, { resolveCodePeek });
  const concurrent = prepareReviewDocument(load, session, { resolveCodePeek });
  const different = prepareReviewDocument(
    { ...load, contentHash: "different-content" },
    session,
    { resolveCodePeek },
  );
  expect(concurrent).toBe(first);
  await Promise.resolve();
  expect(resolveCodePeek).toHaveBeenCalledTimes(2);

  resolution.resolve({ snapshot: { roots: [], resolved: {} } });
  expect(await concurrent).toBe(await first);
  expect(await different).not.toBe(await first);
});

it("keeps available peeks visible and retries incomplete preparation on a later load", async () => {
  const session = testReviewSession();
  const data = documentData();
  data.anchors.other = {
    __kind: "db-anchor-ref",
    id: "other",
    title: "Available",
    peek: {
      __kind: "code-peek-ref",
      props: { file: "src/available.ts", fromLine: 1, toLine: 1 },
      resolution: null,
    },
  };
  load = { ...load, data: parseJsonText(JSON.stringify(data)) };
  resolveCodePeek.mockRejectedValueOnce(new Error("peek unavailable"));

  const partial = await prepareReviewDocument(load, session, {
    resolveCodePeek,
  });
  expect(partial.body).toHaveLength(1);
  expect(partial.anchors.get("create-order")?.peek?.resolution).toBeNull();
  expect(partial.anchors.get("other")?.peek?.resolution).toEqual({
    snapshot: { roots: [], resolved: {} },
  });
  const available = partial.anchors.get("other");
  const availableResolution = available?.peek?.resolution;
  expect(session.documents.get("document-hash")?.document).toBe(partial);

  const retry = prepareReviewDocument(load, session, {
    resolveCodePeek,
  });
  expect(prepareReviewDocument(load, session, { resolveCodePeek })).toBe(retry);
  const recovered = await retry;
  expect(recovered).toBe(partial);
  expect(recovered.anchors.get("other")).toBe(available);
  expect(recovered.anchors.get("other")?.peek?.resolution).toBe(
    availableResolution,
  );
  expect(recovered.anchors.get("create-order")?.peek?.resolution).toBeDefined();
  expect(resolveCodePeek).toHaveBeenCalledTimes(3);
  expect(resolveCodePeek.mock.calls.map((call) => call[1].file)).toEqual([
    "src/orders.ts",
    "src/available.ts",
    "src/orders.ts",
  ]);
  expect(await prepareReviewDocument(load, session, { resolveCodePeek })).toBe(
    partial,
  );
  expect(resolveCodePeek).toHaveBeenCalledTimes(3);
});

it("evicts rejected hydration without caching invalid document data", async () => {
  const session = testReviewSession();
  const invalid = { ...documentData(), anchors: {} };
  await expect(
    prepareReviewDocument(
      {
        ...load,
        data: parseJsonText(JSON.stringify(invalid)),
      },
      session,
      { resolveCodePeek },
    ),
  ).rejects.toThrow("missing anchor");
  expect(session.documents.has("document-hash")).toBe(false);
  await expect(
    prepareReviewDocument(load, session, { resolveCodePeek }),
  ).resolves.toBeDefined();
  expect(resolveCodePeek).toHaveBeenCalledOnce();
});
