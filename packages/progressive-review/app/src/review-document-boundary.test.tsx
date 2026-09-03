// @vitest-environment jsdom

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sequenceDiagramPropsSchema } from "../../src/authoring";
import type { ReviewSession } from "./host/review-session";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { testReviewSession } from "./review-session-test-utils";

let request: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let session: ReviewSession;

const roots: Array<ReturnType<typeof createRoot>> = [];

describe("ReviewDocumentBoundary", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ ok: true }),
    );
    session = testReviewSession({}, { request });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("contains a document render error, leaves the shell mounted, and recovers on a new revision", async () => {
    const onError = vi.fn<(revision: string, error: Error) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <StrictMode>
          <div data-testid="shell">Files Map Threads</div>
          <ReviewDocumentBoundary
            key="bad-1"
            revision="bad-1"
            onError={onError}
            session={session}
          >
            <ThrowingDocument />
          </ReviewDocumentBoundary>
        </StrictMode>,
      );
    });

    expect(container.querySelector('[data-testid="shell"]')?.textContent).toBe(
      "Files Map Threads",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Your coding agent is writing the canvas now",
    );
    expect(onError).toHaveBeenCalledWith("bad-1", expect.any(TypeError));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(clientErrorReports()).toEqual([
      expect.objectContaining({
        name: "client_error",
        properties: expect.objectContaining({
          error_source: "render",
          error_name: "TypeError",
        }),
        error: expect.objectContaining({
          name: "TypeError",
          message: "sequence actor exploded",
        }),
      }),
    ]);

    await act(async () => {
      root.render(
        <StrictMode>
          <div data-testid="shell">Files Map Threads</div>
          <ReviewDocumentBoundary
            key="good-2"
            revision="good-2"
            onError={onError}
            session={session}
          >
            <h1>Recovered document</h1>
          </ReviewDocumentBoundary>
        </StrictMode>,
      );
    });

    expect(container.querySelector("h1")?.textContent).toBe(
      "Recovered document",
    );
    expect(container.querySelector('[data-testid="shell"]')).not.toBeNull();
  });

  it("reports standard Zod authoring errors", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <ReviewDocumentBoundary
          revision="bad-authoring"
          onError={() => {}}
          session={session}
        >
          <ThrowingAuthoringDocument />
        </ReviewDocumentBoundary>,
      );
    });

    expect(clientErrorReports()).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({ error_source: "render" }),
        error: expect.objectContaining({ name: "ZodError" }),
      }),
    ]);
  });
});

function ThrowingDocument(): never {
  throw new TypeError("sequence actor exploded");
}

function ThrowingAuthoringDocument(): never {
  return sequenceDiagramPropsSchema.parse({
    label: "Request",
    messages: [{ from: "HeyGen" }],
  }) as never;
}

function clientErrorReports(): JsonObject[] {
  return request.mock.calls
    .filter(([url]) => url.includes("/telemetry/event"))
    .map(([, init]) => {
      const body = parseJsonText(String(init?.body));
      if (!isJsonObject(body)) {
        throw new Error("Telemetry event body is not an object");
      }
      return body;
    });
}

function jsonResponse(body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
