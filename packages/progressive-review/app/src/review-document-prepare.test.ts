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

it("evicts a rejected hydration so a later load can retry", async () => {
  const session = testReviewSession();
  resolveCodePeek.mockRejectedValueOnce(new Error("peek unavailable"));

  await expect(
    prepareReviewDocument(load, session, { resolveCodePeek }),
  ).rejects.toThrow("peek unavailable");
  expect(session.documents.has("document-hash")).toBe(false);

  await expect(
    prepareReviewDocument(load, session, { resolveCodePeek }),
  ).resolves.toBeDefined();
  expect(resolveCodePeek).toHaveBeenCalledTimes(2);
});
