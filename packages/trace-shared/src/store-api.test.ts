import { describe, expect, it } from "vitest";

import {
  MAX_TRACE_OBJECT_BYTES,
  TRACE_STORE_API_PREFIX,
  beginUploadRequestSchema,
  createStoreRequestSchema,
  traceObjectNameSchema,
} from "./store-api.js";

describe("store-api contracts", () => {
  it("fixes the versioned prefix", () => {
    expect(TRACE_STORE_API_PREFIX).toBe("/api/trace/v1");
  });

  it("accepts main and subagent object names only", () => {
    expect(traceObjectNameSchema.safeParse("main.jsonl.gz").success).toBe(true);
    expect(
      traceObjectNameSchema.safeParse("subagents/agent-a1.jsonl.gz").success,
    ).toBe(true);
    expect(traceObjectNameSchema.safeParse("../x.jsonl.gz").success).toBe(
      false,
    );
    expect(
      traceObjectNameSchema.safeParse("subagents/a/b.jsonl.gz").success,
    ).toBe(false);
    expect(traceObjectNameSchema.safeParse("main.jsonl").success).toBe(false);
  });

  it("requires lowercase hex sha256 and positive size", () => {
    const ok = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [{ name: "main.jsonl.gz", size: 10, sha256: "a".repeat(64) }],
    });
    expect(ok.success).toBe(true);
    const bad = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [{ name: "main.jsonl.gz", size: 0, sha256: "A".repeat(64) }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an object above the size cap", () => {
    const oversize = beginUploadRequestSchema.safeParse({
      harness: "claude",
      objects: [
        {
          name: "main.jsonl.gz",
          size: MAX_TRACE_OBJECT_BYTES + 1,
          sha256: "a".repeat(64),
        },
      ],
    });
    expect(oversize.success).toBe(false);
  });

  it("rejects owner/name with path characters", () => {
    expect(
      createStoreRequestSchema.safeParse({ owner: "a/b", name: "c" }).success,
    ).toBe(false);
  });
});
