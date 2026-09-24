import { describe, expect, it } from "vitest";

import { exceptionProperties } from "./exception-telemetry";

describe("exceptionProperties", () => {
  it("builds a raw PostHog stack from bundle frames", () => {
    const result = exceptionProperties({
      error_name: "TypeError",
      error_process: "canvas",
      message: "Cannot read properties of undefined",
      message_hash: "0123456789abcdef",
      frames:
        "vs/review/browser/workbench.js:456:12|assets/canvas-a1.js:1:284712",
    });

    expect(result).toEqual({
      $exception_level: "error",
      $exception_fingerprint: "0123456789abcdef",
      $exception_list: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined",
          mechanism: { handled: true, synthetic: false },
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                filename: "vs/review/browser/workbench.js",
                lineno: 456,
                colno: 12,
                function: "?",
                in_app: true,
              },
              {
                platform: "web:javascript",
                filename: "assets/canvas-a1.js",
                lineno: 1,
                colno: 284712,
                function: "?",
                in_app: true,
              },
            ],
          },
        },
      ],
    });
  });

  it("marks main and server frames as Node frames", () => {
    for (const process of ["main", "server"]) {
      const result = exceptionProperties({
        error_name: "Error",
        error_process: process,
        frames: "review-runtime/server.js:2:3",
      });

      expect(result?.$exception_list).toEqual([
        expect.objectContaining({
          stacktrace: {
            type: "raw",
            frames: [
              expect.objectContaining({
                platform: "node:javascript",
                filename: "review-runtime/server.js",
              }),
            ],
          },
        }),
      ]);
    }
  });

  it("withholds the message when only the digest survived", () => {
    const result = exceptionProperties({
      error_name: "ZodError",
      message_hash: "0123456789abcdef",
    });

    expect(result?.$exception_list).toEqual([
      expect.objectContaining({
        type: "ZodError",
        value: "[message withheld] 0123456789abcdef",
      }),
    ]);
  });

  it("returns undefined without a class name or digest", () => {
    expect(exceptionProperties({ error_source: "window" })).toBeUndefined();
  });
});
