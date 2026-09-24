import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearOpenSession,
  recordOpenSession,
  takeOpenSessions,
} from "./session-markers";

describe("session markers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-markers-"));
    roots.push(root);

    return root;
  }

  it("records, clears and takes markers", async () => {
    const file = path.join(await tempRoot(), "telemetry", "open-sessions.json");

    recordOpenSession(file, {
      presentationSessionId: "p1",
      reviewUuid: "r1",
      startedAt: 1,
    });
    recordOpenSession(file, {
      presentationSessionId: "p2",
      reviewUuid: "r2",
      startedAt: 2,
    });
    clearOpenSession(file, "p1");

    expect(takeOpenSessions(file)).toEqual([
      { presentationSessionId: "p2", reviewUuid: "r2", startedAt: 2 },
    ]);
    expect(takeOpenSessions(file)).toEqual([]);
  });

  it("keeps a marker whose stored envelope is malformed, without it", async () => {
    const root = await tempRoot();
    const file = path.join(root, "open-sessions.json");

    const marker = {
      presentationSessionId: "p1",
      reviewUuid: "r1",
      startedAt: 1,
    };

    writeFileSync(
      file,
      JSON.stringify([{ ...marker, envelope: { surface: { nested: true } } }]),
    );

    expect(takeOpenSessions(file)).toEqual([marker]);
  });

  it("treats a corrupt file as empty", async () => {
    const root = await tempRoot();
    const file = path.join(root, "open-sessions.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(file, "{not json");

    expect(takeOpenSessions(file)).toEqual([]);
    expect(() => clearOpenSession(file, "p1")).not.toThrow();
  });
});
