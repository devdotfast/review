import { describe, expect, it } from "vitest";

import {
  type ReviewTelemetryCapture,
  captureSanitizedUiTelemetry,
} from "./ui-telemetry";

function request(sessionId: string) {
  return new Request("http://127.0.0.1/telemetry/event", {
    method: "POST",
    headers: { "x-review-app-session-id": sessionId },
  });
}

describe("client error budget", () => {
  it("replaces the sixth identical error with one burst event", async () => {
    const captured: Array<[string, Record<string, string | number | boolean>]> =
      [];

    const telemetry: ReviewTelemetryCapture = {
      captureTabViewed: async () => {},
      captureUiEvent: async (event, properties) => {
        captured.push([event, properties]);
      },
    };

    const error = {
      name: "TypeError",
      message: "boom",
      stack:
        "TypeError: boom\n    at f (/app/out/vs/review/browser/workbench.js:1:1)",
    };

    for (let i = 0; i < 7; i++) {
      await captureSanitizedUiTelemetry(
        telemetry,
        request("burst-session-000"),
        "client_error",
        {
          error_source: "window",
          error_process: "canvas",
          error_name: "TypeError",
        },
        undefined,
        error,
      );
    }

    expect(captured.map(([event]) => event)).toEqual([
      ...Array(5).fill("review_client_error"),
      "review_error_burst",
    ]);
    expect(captured[5][1]).toMatchObject({
      suppressed: 1,
      app_session_id: "burst-session-000",
      message_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });
});
