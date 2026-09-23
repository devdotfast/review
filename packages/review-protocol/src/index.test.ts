import { describe, expect, it } from "vitest";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  parseReviewDesktopDiscovery,
  parseReviewDiffFilesResponse,
  parseReviewFileContentRequest,
  parseReviewFileContentResponse,
  parseReviewVerbRequest,
} from "./index.js";

describe("review protocol parsers", () => {
  it("parses global desktop discovery and session-prefixed runtime URLs", () => {
    expect(
      parseReviewDesktopDiscovery({
        version: REVIEW_DESKTOP_DISCOVERY_VERSION,
        instanceId: "desktop-1",
        url: "http://127.0.0.1:5590/ignored",
        appPid: 10,
        serverPid: 11,
        token: "secret",
        startedAt: 12,
      }),
    ).toMatchObject({ url: "http://127.0.0.1:5590", instanceId: "desktop-1" });
    expect(() =>
      parseReviewDesktopDiscovery({
        version: REVIEW_DESKTOP_DISCOVERY_VERSION + 1,
        instanceId: "desktop-1",
        url: "http://127.0.0.1:5590",
        appPid: 10,
        serverPid: 11,
        token: "secret",
        startedAt: 12,
      }),
    ).toThrow("Unsupported");
  });

  it("parses event and one-based range verb boundaries", () => {
    expect(
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 10,
          endLine: 12,
          side: "base",
          highlight: true,
          preserveFocus: true,
        },
      }),
    ).toEqual({
      name: "reveal",
      args: {
        path: "src/cli.ts",
        startLine: 10,
        endLine: 12,
        side: "base",
        highlight: true,
        preserveFocus: true,
      },
    });
    expect(
      parseReviewVerbRequest({
        name: "reveal",
        args: { path: "src/legacy.ts", startLine: 1, endLine: 1 },
      }),
    ).toEqual({
      name: "reveal",
      args: { path: "src/legacy.ts", startLine: 1, endLine: 1 },
    });
    expect(() =>
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 1,
          endLine: 1,
          side: "working",
        },
      }),
    ).toThrow("args.side");
    expect(() =>
      parseReviewVerbRequest({
        name: "reveal",
        args: {
          path: "src/cli.ts",
          startLine: 0,
          endLine: 1,
        },
      }),
    ).toThrow("positive integer");
  });

  it("parses file lists and file content variants", () => {
    expect(
      parseReviewFileContentRequest({ path: "src/new.ts", side: "base" }),
    ).toEqual({ path: "src/new.ts", side: "base" });
    expect(
      parseReviewDiffFilesResponse({
        ok: true,
        baseRef: "main",
        files: [
          {
            path: "src/new.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ],
      }),
    ).toMatchObject({ ok: true, files: [{ status: "renamed" }] });
    expect(
      parseReviewFileContentResponse({
        ok: true,
        content: "partial",
        truncated: true,
      }),
    ).toEqual({ ok: true, content: "partial", truncated: true });
    expect(parseReviewFileContentResponse({ ok: true, absent: true })).toEqual({
      ok: true,
      absent: true,
    });
    expect(parseReviewFileContentResponse({ ok: true, binary: true })).toEqual({
      ok: true,
      binary: true,
    });
  });
});
