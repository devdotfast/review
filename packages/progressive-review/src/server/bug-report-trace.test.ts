import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewAgentHarness } from "../authoring-session";
import { clearTraceEnvCache } from "../review-agent-traces";
import {
  type AuthoringTraceAttachment,
  readAuthoringTraceAttachment,
} from "./bug-report-trace";

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
    ["pi", "33333333-aaaa-bbbb-cccc-000000000003"],
  ] as const)("stores a complete %s source trace", async (harness, id) => {
    const source = jsonLine({ harness, id });
    writeReview(harness + ":" + id);
    writeHarnessTrace(harness, id, source);

    const attachment = await requiredAttachment();
    expect(attachment.payload).toEqual({
      harness,
      files: {},
      truncated: false,
    });
    expect(readPart(attachment, 0)).toBe(source);
    expect(attachment.parts[0]).toMatchObject({
      filename: "trace-0.jsonl.gz",
      session_id: id,
    });
    expect(attachment.parts).toHaveLength(1);
    await attachment.cleanup();
  });

  it("stores a standalone Codex trace as one complete source part", async () => {
    const id = "10101010-1010-4010-8010-101010101010";
    const source = codexTrace(id, 0, [{ standalone: true }]);
    writeCodexTrace(id, source);
    writeReview("codex:" + id);

    const attachment = await requiredAttachment();
    expect(attachment.payload.harness).toBe("codex");
    expect(readPart(attachment, 0)).toBe(source);
    expect(attachment.parts).toHaveLength(1);
    await attachment.cleanup();
  });

  it("stores Codex lineage leaf first and excludes post-fork records", async () => {
    const grandparentId = "11111111-1111-4111-8111-111111111111";
    const parentId = "22222222-2222-4222-8222-222222222222";
    const childId = "33333333-3333-4333-8333-333333333333";
    const grandparent = codexTrace(grandparentId, 0, [{ root: true }]);
    const parentAtFork = codexTrace(
      parentId,
      2,
      [{ parent: true }],
      historyBase(grandparentId, 2),
    );
    const parent = parentAtFork + jsonLine({ parentLater: true, ordinal: 4 });
    const child = codexTrace(
      childId,
      4,
      [{ child: true }],
      historyBase(parentId, 4),
    );
    writeCodexTrace(grandparentId, grandparent);
    writeCodexTrace(parentId, parent);
    writeCodexTrace(childId, child);
    writeReview("codex:" + childId);

    const attachment = await requiredAttachment();
    expect(attachment.payload).toMatchObject({
      harness: "codex",
      truncated: false,
    });
    expect(readPart(attachment, 0)).toBe(child);
    expect(readPart(attachment, 1)).toBe(parentAtFork);
    expect(readPart(attachment, 2)).toBe(grandparent);
    expect(attachment.parts.map((part) => part.filename)).toEqual([
      "trace-0.jsonl.gz",
      "trace-1.jsonl.gz",
      "trace-2.jsonl.gz",
    ]);
    await attachment.cleanup();
  });

  it("rejects an unresolved or malformed declared Codex parent", async () => {
    const childId = "44444444-4444-4444-8444-444444444444";
    const parentId = "55555555-5555-4555-8555-555555555555";
    writeCodexTrace(
      childId,
      codexTrace(childId, 2, [{ child: true }], historyBase(parentId, 2)),
    );
    writeReview("codex:" + childId);
    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("exactly one rollout");

    writeCodexTrace(parentId, '{"ordinal":0}\nnot-json\n');
    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("malformed JSONL");
  });

  it("rejects malformed Codex history metadata", async () => {
    const childId = "45454545-4545-4545-8545-454545454545";
    const parentId = "56565656-5656-4656-8656-565656565656";
    writeCodexTrace(
      childId,
      [
        {
          type: "session_meta",
          payload: { id: childId, history_base: { thread_id: parentId } },
          ordinal: 2,
        },
        { child: true, ordinal: 3 },
      ]
        .map(jsonLine)
        .join(""),
    );
    writeReview("codex:" + childId);

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("history base is malformed");
  });

  it("rejects Codex ancestry cycles", async () => {
    const childId = "47474747-4747-4747-8747-474747474747";
    const parentId = "58585858-5858-4858-8858-585858585858";
    writeCodexTrace(
      childId,
      codexTrace(childId, 4, [{ child: true }], historyBase(parentId, 4)),
    );
    writeCodexTrace(
      parentId,
      codexTrace(parentId, 2, [{ parent: true }], historyBase(childId, 2)),
    );
    writeReview("codex:" + childId);

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("ancestry contains a cycle");
  });

  it("rejects an ancestor record without an ordinal", async () => {
    const childId = "48484848-4848-4848-8848-484848484848";
    const parentId = "59595959-5959-4959-8959-595959595959";
    writeCodexTrace(
      parentId,
      jsonLine({
        type: "session_meta",
        payload: { id: parentId },
        ordinal: 0,
      }) + jsonLine({ missing: "ordinal" }),
    );
    writeCodexTrace(
      childId,
      codexTrace(childId, 2, [{ child: true }], historyBase(parentId, 2)),
    );
    writeReview("codex:" + childId);

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("missing a valid ordinal");
  });

  it("does not require contiguous Codex ordinals", async () => {
    const childId = "49494949-4949-4949-8949-494949494949";
    const parentId = "60606060-6060-4060-8060-606060606060";
    const parent =
      jsonLine({
        type: "session_meta",
        payload: { id: parentId },
        ordinal: 0,
      }) + jsonLine({ gap: true, ordinal: 2 });
    writeCodexTrace(parentId, parent);
    writeCodexTrace(
      childId,
      codexTrace(childId, 3, [{ child: true }], historyBase(parentId, 3)),
    );
    writeReview("codex:" + childId);

    const attachment = await requiredAttachment();
    expect(readPart(attachment, 1)).toBe(parent);
    await attachment.cleanup();
  });

  it("accepts 32 Codex parent levels and rejects 33", async () => {
    let parentId = codexId(0);
    writeCodexTrace(parentId, codexTrace(parentId, 0, [{ depth: 0 }]));
    for (let depth = 1; depth <= 32; depth++) {
      const id = codexId(depth);
      const trace = codexTrace(
        id,
        depth * 2,
        [{ depth }],
        historyBase(parentId, depth * 2),
      );
      writeCodexTrace(id, trace);
      parentId = id;
    }
    writeReview("codex:" + parentId);

    const accepted = await requiredAttachment();
    expect(accepted.parts).toHaveLength(33);
    await accepted.cleanup();

    const sourceId = codexId(33);
    writeCodexTrace(
      sourceId,
      codexTrace(sourceId, 66, [{ source: true }], historyBase(parentId, 66)),
    );
    writeReview("codex:" + sourceId);

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("exceeds the supported depth");
  });

  it("keeps a complete main trace that exceeds the old byte cap", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    const source = jsonLine({ data: "x".repeat(6 * 1024 * 1024 + 1) });
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, source);

    const attachment = await requiredAttachment();
    expect(readPart(attachment, 0)).toBe(source);
    expect(attachment.payload.truncated).toBe(false);
    await attachment.cleanup();
  });

  it("waits for an incomplete final record and then keeps it", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    const complete = jsonLine({ complete: true });
    writeReview("claude-code:" + id);
    const tracePath = writeHarnessTrace(
      "claude-code",
      id,
      complete + '{"later":',
    );
    const finish = setTimeout(() => appendFileSync(tracePath, "true}\n"), 60);

    const attachment = await requiredAttachment();
    clearTimeout(finish);
    expect(readPart(attachment, 0)).toBe(complete + jsonLine({ later: true }));
    await attachment.cleanup();
  });

  it("rejects a final record that stays incomplete", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, jsonLine({ complete: true }) + "{");

    await expect(
      readAuthoringTraceAttachment({ reviewRootPath }),
    ).rejects.toThrow("incomplete JSONL record");
  });

  it("redacts complete secret values but keeps valid JSONL", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    const slackToken = [
      "xoxb",
      "123456789012",
      "123456789012",
      "abcdefghijklmnop",
    ].join("-");
    const githubToken = "ghp_" + "b".repeat(36);
    const source = jsonLine({
      prompt: "Use " + slackToken,
      githubToken,
      path: "/Users/reviewer/project/src/auth.ts",
    });
    writeReview("claude-code:" + id);
    writeHarnessTrace("claude-code", id, source);

    const attachment = await requiredAttachment();
    const trace = readPart(attachment, 0);
    expect(trace).not.toContain(slackToken);
    expect(trace).not.toContain(githubToken);
    expect(trace).toContain("<REDACTED: Slack Token>");
    expect(trace).toContain("<REDACTED: GitHub Token>");
    expect(trace).toContain("/Users/reviewer/project/src/auth.ts");
    expect(() => JSON.parse(trace.trim())).not.toThrow();
    await attachment.cleanup();
  });

  it("keeps the ten newest bounded subagent traces", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
      const contents =
        index === 10
          ? jsonLine({ old: "x".repeat(SUBAGENT_TRACE_CAP_BYTES) }) +
            jsonLine({ recent: true })
          : jsonLine({ index });
      writeFileSync(subagentPath, contents);
      const modifiedAt = new Date(1_700_000_000_000 + index * 1000);
      utimesSync(subagentPath, modifiedAt, modifiedAt);
    }

    const attachment = await requiredAttachment();
    expect(attachment.payload.truncated).toBe(true);
    expect(attachment.payload.files["subagents/agent-10.jsonl"]).toBe(
      jsonLine({ recent: true }),
    );
    expect(attachment.payload.files).not.toHaveProperty(
      "subagents/agent-00.jsonl",
    );
    expect(attachment.payload.omitted_files).toEqual([
      "subagents/agent-00.jsonl",
    ]);
    await attachment.cleanup();
  });

  async function requiredAttachment(): Promise<AuthoringTraceAttachment> {
    const attachment = await readAuthoringTraceAttachment({ reviewRootPath });
    if (!attachment) throw new Error("Expected an authoring trace.");
    return attachment;
  }

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
      return writeCodexTrace(id, contents);
    } else {
      const projectDir = path.join(piRoot, "project");
      mkdirSync(projectDir, { recursive: true });
      tracePath = path.join(projectDir, "2026-08-31T12-00-00_" + id + ".jsonl");
    }
    writeFileSync(tracePath, contents);
    return tracePath;
  }

  function writeCodexTrace(id: string, contents: string): string {
    const dateDir = path.join(codexRoot, "2026", "08", "31");
    mkdirSync(dateDir, { recursive: true });
    const tracePath = path.join(
      dateDir,
      "rollout-2026-08-31T12-00-00-" + id + ".jsonl",
    );
    writeFileSync(tracePath, contents);
    return tracePath;
  }
});

function historyBase(
  parentId: string,
  endOrdinalExclusive: number,
): { parentId: string; endOrdinalExclusive: number } {
  return { parentId, endOrdinalExclusive };
}

function codexId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function codexTrace(
  id: string,
  startOrdinal: number,
  records: Array<Record<string, unknown>>,
  parent?: ReturnType<typeof historyBase>,
): string {
  const metaPayload = {
    id,
    ...(parent
      ? {
          history_base: {
            thread_id: parent.parentId,
            end_ordinal_exclusive: parent.endOrdinalExclusive,
          },
        }
      : {}),
  };
  return [{ type: "session_meta", payload: metaPayload }, ...records]
    .map((value, index) =>
      jsonLine({ ...value, ordinal: startOrdinal + index }),
    )
    .join("");
}

function readPart(attachment: AuthoringTraceAttachment, index: number): string {
  const part = attachment.parts[index];
  if (!part) throw new Error(`Missing trace part ${index}.`);
  return gunzipSync(readFileSync(part.path)).toString("utf8");
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
