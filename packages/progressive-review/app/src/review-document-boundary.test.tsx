// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sequenceDiagramPropsSchema } from "../../src/authoring";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { testReviewSession } from "./review-session-test-utils";
import { captureClientError } from "./ui-telemetry";

const session = testReviewSession();

vi.mock("./ui-telemetry", () => ({
  captureUiEvent:
    vi.fn<
      (
        session: unknown,
        name: string,
        properties?: Record<string, string | number | boolean>,
        error?: unknown,
      ) => void
    >(),
  captureClientError:
    vi.fn<(session: unknown, errorSource: string, error: unknown) => void>(),
  clientErrorName: (error: unknown) =>
    error instanceof Error ? error.name : "Error",
}));

const roots: Array<ReturnType<typeof createRoot>> = [];

describe("ReviewDocumentBoundary", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(captureClientError).mockClear();
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
    const onError = vi.fn<(revision: string, error: unknown) => void>();
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
    expect(captureClientError).toHaveBeenCalledWith(
      session,
      "render",
      expect.any(TypeError),
    );
    expect(captureClientError).toHaveBeenCalledTimes(1);

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

    expect(captureClientError).toHaveBeenCalledWith(
      session,
      "render",
      expect.objectContaining({ name: "ZodError" }),
    );
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
