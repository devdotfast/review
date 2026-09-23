import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INSTRUCTION_TOPICS,
  instructionsQuerySchema,
  renderInstructions,
} from "./instructions.js";

const live = {
  authoringMode: "interactive" as const,
  desktopAvailable: true,
  scratchpadEnabled: true,
  softwareMapEnabled: false,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-instructions-"));
  await mkdir(path.join(root, "instructions"));
  await Promise.all(
    Object.entries({
      "authoring-live": "LIVE_WORKFLOW",
      "authoring-batch": "BATCH_WORKFLOW<!-- software-map-start --> BATCH_MAP_GUIDANCE<!-- software-map-end -->",
      "document-authoring": "DOCUMENT_GUIDANCE\n| A |\n<!-- software-map-start -->MAP_COMPONENT_GUIDANCE<!-- software-map-end -->\n| B |",
      headless: "HEADLESS_GUIDANCE",
      "prepared-worktrees": "WORKTREE_GUIDANCE",
      scratchpad: "SCRATCHPAD_GUIDANCE",
      "trace-archaeology": "TRACE_GUIDANCE",
    }).map(([name, content]) =>
      writeFile(path.join(root, "instructions", `${name}.md`), content),
    ),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("renderInstructions", () => {
  it("selects the server's authoring mode and includes shared guidance", async () => {
    const interactive = await renderInstructions("authoring", live, root);
    const batch = await renderInstructions("authoring", { ...live, authoringMode: "batch" }, root);

    expect(interactive).toContain("LIVE_WORKFLOW\n\nDOCUMENT_GUIDANCE");
    expect(interactive).not.toContain("BATCH_WORKFLOW");
    expect(batch).toContain("BATCH_WORKFLOW");
    expect(batch).toContain("DOCUMENT_GUIDANCE");
    expect(batch).not.toContain("LIVE_WORKFLOW");
  });

  it("hides optional software map guidance in both workflow and shared content", async () => {
    const disabled = await renderInstructions("authoring", { ...live, authoringMode: "batch" }, root);
    const enabled = await renderInstructions(
      "authoring",
      { ...live, authoringMode: "batch", softwareMapEnabled: true },
      root,
    );

    expect(disabled).not.toContain("BATCH_MAP_GUIDANCE");
    expect(disabled).not.toContain("MAP_COMPONENT_GUIDANCE");
    expect(disabled).toContain("| A |\n| B |");
    expect(enabled).toContain("BATCH_MAP_GUIDANCE");
    expect(enabled).toContain("MAP_COMPONENT_GUIDANCE");
    expect(enabled).not.toContain("<!-- software-map");
  });

  it("advertises the scratchpad only when interactive Desktop access is available", async () => {
    expect(await renderInstructions("authoring", live, root)).toContain('topic:"scratchpad"');
    for (const context of [
      { ...live, scratchpadEnabled: false },
      { ...live, desktopAvailable: false },
      { ...live, authoringMode: "batch" as const },
    ]) {
      expect(await renderInstructions("authoring", context, root)).not.toContain('topic:"scratchpad"');
    }
    expect(await renderInstructions("scratchpad", { ...live, scratchpadEnabled: false }, root))
      .not.toContain("SCRATCHPAD_GUIDANCE");
  });

  it("serves other fixed topics independently of authoring mode and Desktop", async () => {
    const context = { ...live, authoringMode: "batch" as const, desktopAvailable: false };
    for (const [topic, marker] of [
      ["headless", "HEADLESS_GUIDANCE"],
      ["prepared-worktrees", "WORKTREE_GUIDANCE"],
      ["trace-archaeology", "TRACE_GUIDANCE"],
    ] as const) {
      expect(await renderInstructions(topic, context, root)).toBe(marker);
    }
  });

  it("accepts only named topics, defaulting to authoring", () => {
    expect(instructionsQuerySchema.parse({})).toEqual({ topic: "authoring" });
    for (const topic of INSTRUCTION_TOPICS) {
      expect(instructionsQuerySchema.parse({ topic })).toEqual({ topic });
    }
    expect(instructionsQuerySchema.safeParse({ topic: "../secrets" }).success).toBe(false);
    expect(instructionsQuerySchema.safeParse({ topic: "authoring", file: "secret.md" }).success).toBe(false);
  });
});
