import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createReviewLogger } from "./review-logger";

describe("Review structured logger", () => {
  it("renders typed events as NDJSON by default", () => {
    const output = writableOutput();
    const logger = createReviewLogger({ output: output.stream });

    logger.event({
      event: "ready",
      url: "http://localhost:5620/",
      document: "/tmp/review.mdx",
    });

    expect(JSON.parse(output.text())).toEqual({
      level: "info",
      event: "ready",
      url: "http://localhost:5620/",
      document: "/tmp/review.mdx",
    });
  });

  it("switches the same event callsite to human-readable output by format", () => {
    const output = writableOutput();
    const logger = createReviewLogger({
      output: output.stream,
      format: "pretty",
      colorize: false,
    });

    logger.event({
      event: "ready",
      url: "http://localhost:5620/",
      document: "/tmp/review.mdx",
    });

    expect(output.text()).toBe(
      'INFO: ready {"url":"http://localhost:5620/","document":"/tmp/review.mdx"}\n',
    );
  });

  it("uses diagnostic severity as the structured log level", () => {
    const output = writableOutput();
    const logger = createReviewLogger({ output: output.stream });

    logger.event({
      event: "diagnostic",
      level: "warn",
      origin: "review",
      message: "browser warning",
    });

    expect(JSON.parse(output.text())).toEqual({
      level: "warn",
      event: "diagnostic",
      origin: "review",
      message: "browser warning",
    });
  });
});

function writableOutput() {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(""),
  };
}
