import { describe, expect, it } from "vitest";

import type { PeekableAnchorRef } from "./authoring";
import { selectSource } from "./lens-selection.js";
import { sequenceBlockFromProps } from "./sequence-steps";

const anchor = (id: string): PeekableAnchorRef => ({
  __kind: "db-anchor-ref",
  id,
  title: `Anchor ${id}`,
  peek: selectSource({
    side: "head",
    file: `src/${id}.ts`,
    fromLine: 1,
    toLine: 3,
  }),
});

const actor = (id: string, label: string) =>
  ({ __kind: "db-actor-ref", id, label }) as const;

describe("sequenceBlockFromProps", () => {
  it("keeps explicit actor ids, derives inline ones, and keeps legacy ids", () => {
    const block = sequenceBlockFromProps({
      label: "Sign in flow",
      messages: [
        {
          from: actor("auth", "Better Auth"),
          to: { label: "Web D1" },
          label: "write user",
          anchor: anchor("authUserWrite"),
        },
        {
          from: { label: "Web D1" },
          to: { label: "Settings page" },
          label: "read organization",
          anchor: anchor("authUserWrite"),
        },
        {
          from: { label: "Settings page" },
          to: { label: "Map CLI" },
          label: "run the map",
          code: { language: "bash", text: " review map init " },
        },
      ],
    });

    expect(block.id).toBe("sequence-sign-in-flow");
    expect(block.title).toBe("Sign in flow");
    expect(block.actors).toEqual({
      auth: "Better Auth",
      "inline-web-d1": "Web D1",
      "inline-settings-page": "Settings page",
      "inline-map-cli": "Map CLI",
    });
    expect(block.steps).toEqual([
      {
        id: "authUserWrite",
        type: "step",
        from: "auth",
        to: "inline-web-d1",
        label: "write user",
        style: "call",
        source: selectSource({
          side: "head",
          file: "src/authUserWrite.ts",
          fromLine: 1,
          toLine: 3,
        }),
      },
      {
        id: "authUserWrite--sequence-use-2",
        type: "step",
        from: "inline-web-d1",
        to: "inline-settings-page",
        label: "read organization",
        style: "call",
        source: selectSource({
          side: "head",
          file: "src/authUserWrite.ts",
          fromLine: 1,
          toLine: 3,
        }),
      },
      {
        id: "sequence-sign-in-flow-message-3",
        type: "step",
        from: "inline-settings-page",
        to: "inline-map-cli",
        label: "run the map",
        style: "call",
        code: { language: "bash", text: "review map init" },
      },
    ]);
  });

  it("prefers code over source when a message carries both", () => {
    const [step] = sequenceBlockFromProps({
      label: "Reuse",
      messages: [
        {
          from: { label: "A" },
          to: { label: "B" },
          label: "call",
          anchor: anchor("request"),
          code: "plain text",
        },
      ],
    }).steps;

    expect(step).toMatchObject({
      id: "request",
      code: { language: "text", text: "plain text" },
    });
    expect(step?.source).toBeUndefined();
  });
});
