import type { JsonValue } from "@dev.fast/review-protocol";
import { act } from "react";
import { afterEach, expect, it } from "vitest";

import {
  assignFreshIds,
  documentSchema,
  elements,
} from "../../src/review-api/document";
import type { Snapshot } from "../../src/review-api/store";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { fixtureReviewBridge, settled } from "./fixture-review-bridge";

// The archived real reviews as the importer translates them, before ids.
const goldens = import.meta.glob<{ default: JsonValue }>(
  "../../src/fixtures/legacy-reviews/*.expected-blocks.json",
  { eager: true },
);

/** The title heading of each archived review's golden document. */
const phrases = {
  "schema4-bug-report-dialog": "Bug reports: screenshots and simpler consent",
  "schema4-opencode-agentserver": "OpenCode on AgentServer",
  "schema4-three-minute-tour": "Review Desktop: three-minute tour",
};

let canvas: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
});

it.each(Object.keys(phrases) as (keyof typeof phrases)[])(
  "renders the real review %s through the JSON canvas",
  async (name) => {
    const file = Object.keys(goldens).find((key) =>
      key.endsWith(`/${name}.expected-blocks.json`),
    )!;

    // Ids are assigned exactly as SessionStore.importVersion assigns them.
    const blocks = documentSchema.parse(goldens[file]!.default);
    let nextId = 0;

    for (const block of blocks)
      assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

    const snapshot: Snapshot = {
      sessionId: `real-${name}`,
      version: 0,
      title: name,
      pins: { repositoryId: "repo", base: "base", head: "head" },
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
      document: blocks,
      createdAt: "2026-09-16T00:00:00.000Z",
    };

    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      canvas = mount(container, {
        kind: "api",
        sessionId: snapshot.sessionId,
        version: 0,
        bridge: fixtureReviewBridge({ snapshot }),
      });
    });

    expect(
      await settled(() => container.textContent?.includes(phrases[name])),
    ).toBe(true);
    expect(container.textContent).not.toContain("Layout failed");

    expect(container.querySelector("[data-block-error]")).toBeNull();

    // No golden collapses a section, so every block must be in the DOM with content.
    const missing = elements(blocks)
      .filter((element) => {
        if (element.type === "step") return false;

        const node = container.querySelector(
          `[data-review-node-id="${element.id}"]`,
        );

        return !node || node.innerHTML.trim() === "";
      })
      .map((element) => element.id);

    expect(missing).toEqual([]);
  },
);
