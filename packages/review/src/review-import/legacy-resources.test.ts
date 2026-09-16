import { describe, expect, it } from "vitest";

import { bundleReviewSoftwareMap } from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import {
  mapResourcesFromBundle,
  traceResourceFromLoaded,
} from "./legacy-resources";

describe("traceResourceFromLoaded", () => {
  it("flattens parsed events into id, role, text", () => {
    const resource = traceResourceFromLoaded({
      parserVersion: "1",
      traceName: "main",
      subagents: [],
      cacheStatus: "fresh" as never,
      descriptor: { sessionId: "s1" } as never,
      trace: {
        harness: "codex" as never,
        title: "Fix",
        startedAt: null,
        endedAt: null,
        activeMs: null,
        userTurns: 1,
        toolCalls: 1,
        events: [
          { kind: "user", text: "please fix" },
          { kind: "assistant", markdown: "On it." },
          { kind: "tool", tool: "shell", verb: "ran", title: "pnpm test" },
        ] as never,
      },
    });

    expect(resource).toEqual({
      label: "Fix",
      events: [
        { id: "0", role: "user", text: "please fix" },
        { id: "1", role: "assistant", text: "On it." },
        { id: "2", role: "tool", text: "shell ran pnpm test" },
      ],
    });
  });
});

describe("mapResourcesFromBundle", () => {
  it("produces one map resource per side in the store's saved shape", () => {
    const model = defineSoftwareMap({
      systems: {
        s: {
          label: "S",
          containers: {
            c: {
              label: "C",
              components: { k: { label: "K", coverage: { files: ["a.ts"] } } },
            },
          },
        },
      },
    });

    const bundle = bundleReviewSoftwareMap({
      head: model,
      base: model,
      headCommit: "b".repeat(40),
      baseCommit: "a".repeat(40),
    });

    const resources = mapResourcesFromBundle(bundle);
    expect(resources.map((resource) => resource.side)).toEqual([
      "base",
      "head",
    ]);
    const saved = JSON.parse(resources[1]!.json);
    expect(saved).toMatchObject({ commit: "b".repeat(40), side: "head" });
    expect(Array.isArray(saved.elements)).toBe(true);
    expect(Array.isArray(saved.relationships)).toBe(true);
  });
});
