import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewAgentHarness } from "../authoring-session";
import { clearTraceEnvCache } from "../review-agent-traces";
import { readAuthoringTraceAttachment } from "./bug-report-trace";

const TRACE_CAP_BYTES = 6 * 1024 * 1024;
const SUBAGENT_TRACE_CAP_BYTES = 1024 * 1024;

describe("readAuthoringTraceAttachment", () => {
  let tempDir: string;
  let reviewRootPath: string;
  let claudeRoot: string;
  let codexRoot: string;
  let piRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "bug-report-trace-"));
    reviewRootPath = path.join(tempDir, "review");
    claudeRoot = path.join(tempDir, "claude");
    codexRoot = path.join(tempDir, "codex");
    piRoot = path.join(tempDir, "pi");
    for (const directory of [reviewRootPath, claudeRoot, codexRoot, piRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    process.env.TRACE_LOCAL_TRACE_ROOT = claudeRoot;
    process.env.TRACE_CODEX_SESSIONS_ROOT = codexRoot;
    process.env.TRACE_PI_SESSIONS_ROOT = piRoot;
    clearTraceEnvCache();
  });

  afterEach(() => {
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    delete process.env.TRACE_CODEX_SESSIONS_ROOT;
    delete process.env.TRACE_PI_SESSIONS_ROOT;
    clearTraceEnvCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null without an attributable source session or local trace", async () => {
    writeReview("disabled:review");
    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).resolves.toBeNull();

    writeReview("codex:missing-session");
    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).resolves.toBeNull();
  });

  it.each([
    ["claude-code", "11111111-aaaa-bbbb-cccc-000000000001"],
    ["codex", "22222222-aaaa-bbbb-cccc-000000000002"],
    ["pi", "33333333-aaaa-bbbb-cccc-000000000003"],
  ] as const)(
    "reads a %s trace from its local harness root",
    async (harness, id) => {
      writeReview(harness + ":" + id);
      writeHarnessTrace(harness, id, jsonLine({ harness, id }));

      await expect(
        readAuthoringTraceAttachment({ reviewRootPath }),
      ).resolves.toEqual({
        harness,
        session_id: id,
        files: {
          "trace.jsonl": jsonLine({ harness, id }),
        },
        truncated: false,
      });
    },
  );

  it("redacts complete known-secret values while retaining paths, prompts, and code", async () => {
    const id = "44444444-aaaa-bbbb-cccc-000000000004";
    const googleKey = "AIza" + "a".repeat(35);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    const slackToken = [
      "xoxb",
      "123456789012",
      "123456789012",
      "abcdefghijklmnopqrstuvwx",
    ].join("-");
    const githubToken = "ghp_" + "b".repeat(36);
    const entraToken =
      "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGkifQ.microsoft-signature";
    const ordinaryBase64Json = "eyJmb28iOiJiYXIifQ==";
    const source = [
      {
        prompt: "Use " + googleKey + " and " + slackToken,
        path: "/Users/reviewer/project/src/auth.ts",
        code: "export const answer = 42;",
        ordinaryBase64Json,
      },
      {
        jwt,
        githubToken,
        entraToken,
      },
    ]
      .map(jsonLine)
      .join("");
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, source);

    const attachment = await readAuthoringTraceAttachment({ reviewRootPath });
    const trace = attachment?.files["trace.jsonl"] ?? "";

    expect(trace).toContain("<REDACTED: Google API Key>");
    expect(trace).toContain("<REDACTED: Slack Token>");
    expect(trace).toContain("<REDACTED: JWT>");
    expect(trace).toContain("<REDACTED: GitHub Token>");
    expect(trace).not.toContain(googleKey);
    expect(trace).not.toContain(jwt);
    expect(trace).not.toContain(slackToken);
    expect(trace).not.toContain(githubToken);
    expect(trace).not.toContain(entraToken);
    expect(trace).toContain(ordinaryBase64Json);
    expect(trace).toContain("/Users/reviewer/project/src/auth.ts");
    expect(trace).toContain("export const answer = 42;");
    for (const line of trace.trimEnd().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("keeps the newest complete main-trace lines within the byte cap", async () => {
    const id = "55555555-aaaa-bbbb-cccc-000000000005";
    const oversizedOldLine = jsonLine({ old: "x".repeat(TRACE_CAP_BYTES) });
    const recentLines = [jsonLine({ recent: 1 }), jsonLine({ recent: 2 })].join(
      "",
    );
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, oversizedOldLine + recentLines);

    const attachment = await readAuthoringTraceAttachment({ reviewRootPath });

    expect(attachment?.truncated).toBe(true);
    expect(attachment?.files["trace.jsonl"]).toBe(recentLines);
    for (const line of recentLines.trimEnd().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("drops an incomplete final line from a trace being written", async () => {
    const id = "56565656-aaaa-bbbb-cccc-000000000005";
    const completeLine = jsonLine({ complete: true });
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, completeLine + '{"partial":');

    const attachment = await readAuthoringTraceAttachment({ reviewRootPath });

    expect(attachment?.files["trace.jsonl"]).toBe(completeLine);
    expect(attachment?.truncated).toBe(true);
  });

  it("treats a capped main trace without a complete line as unavailable", async () => {
    const id = "57575757-aaaa-bbbb-cccc-000000000005";
    writeReview("claude-code:" + id);
    writeHarnessTrace(
      "claude-code",
      id,
      JSON.stringify({ oversized: "x".repeat(TRACE_CAP_BYTES) }),
    );

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).resolves.toBeNull();
  });

  it("keeps the ten newest subagent traces and names unreadable or excess files as omitted", async () => {
    const id = "66666666-aaaa-bbbb-cccc-000000000006";
    writeReview("claude-code:" + id);
    const tracePath = writeHarnessTrace(
      "claude-code",
      id,
      jsonLine({ main: true }),
    );
    const subagentsDir = path.join(
      tracePath.slice(0, -".jsonl".length),
      "subagents",
    );
    mkdirSync(subagentsDir, { recursive: true });
    for (let index = 0; index < 11; index++) {
      const name = "agent-" + String(index).padStart(2, "0") + ".jsonl";
      const subagentPath = path.join(subagentsDir, name);
      if (index === 9) {
        mkdirSync(subagentPath);
      } else {
        const contents =
          index === 10
            ? jsonLine({ old: "x".repeat(SUBAGENT_TRACE_CAP_BYTES) }) +
              jsonLine({ recent: true })
            : jsonLine({ index });
        writeFileSync(subagentPath, contents);
      }
      const modifiedAt = new Date(1_700_000_000_000 + index * 1000);
      utimesSync(subagentPath, modifiedAt, modifiedAt);
    }

    const attachment = await readAuthoringTraceAttachment({ reviewRootPath });

    expect(attachment?.truncated).toBe(true);
    expect(attachment?.files["subagents/agent-10.jsonl"]).toBe(
      jsonLine({ recent: true }),
    );
    expect(attachment?.files).not.toHaveProperty("subagents/agent-00.jsonl");
    expect(attachment?.files).not.toHaveProperty("subagents/agent-09.jsonl");
    expect(attachment?.omitted_files).toEqual([
      "subagents/agent-00.jsonl",
      "subagents/agent-09.jsonl",
    ]);
  });

  function writeReview(sourceSession: string): void {
    writeFileSync(
      path.join(reviewRootPath, "review.json"),
      JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        uuid: "00000000-0000-4000-8000-000000000000",
        repoKey: "example/review",
        worktreePath: tempDir,
        baseRef: "main",
        baseCommit: "a".repeat(40),
        sourceCommit: null,
        sourceIdentity: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        title: "Trace test",
        sourceSession,
        status: "draft",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
        createdAt: "2026-08-31T12:00:00.000Z",
        lastPublishedAt: null,
      }),
    );
  }

  function writeHarnessTrace(
    harness: ReviewAgentHarness,
    id: string,
    contents: string,
  ): string {
    let tracePath: string;
    if (harness === "claude-code") {
      const projectDir = path.join(claudeRoot, "project");
      mkdirSync(projectDir, { recursive: true });
      tracePath = path.join(projectDir, id + ".jsonl");
    } else if (harness === "codex") {
      const dateDir = path.join(codexRoot, "2026", "08", "31");
      mkdirSync(dateDir, { recursive: true });
      tracePath = path.join(
        dateDir,
        "rollout-2026-08-31T12-00-00-" + id + ".jsonl",
      );
    } else {
      const projectDir = path.join(piRoot, "project");
      mkdirSync(projectDir, { recursive: true });
      tracePath = path.join(projectDir, "2026-08-31T12-00-00_" + id + ".jsonl");
    }
    writeFileSync(tracePath, contents);
    return tracePath;
  }
});

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
