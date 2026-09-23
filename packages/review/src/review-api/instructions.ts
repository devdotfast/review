import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { findReviewPackageRoot } from "../package-paths.js";
import type { AuthoringMode } from "./drafts.js";

export const INSTRUCTION_TOPICS = [
  "authoring",
  "headless",
  "prepared-worktrees",
  "scratchpad",
  "trace-archaeology",
] as const;

export type InstructionTopic = (typeof INSTRUCTION_TOPICS)[number];

export const instructionsQuerySchema = z.strictObject({
  topic: z.enum(INSTRUCTION_TOPICS).default("authoring"),
});

export interface InstructionContext {
  authoringMode: AuthoringMode;
  desktopAvailable: boolean;
  scratchpadEnabled: boolean;
  softwareMapEnabled: boolean;
}

const cache = new Map<string, Promise<string>>();

function read(root: string, name: string): Promise<string> {
  const file = path.join(root, "instructions", `${name}.md`);
  let content = cache.get(file);

  if (!content) {
    content = readFile(file, "utf8").catch((error) => {
      cache.delete(file);
      throw error;
    });
    cache.set(file, content);
  }

  return content;
}

function withSoftwareMapGuidance(content: string, enabled: boolean): string {
  const selected = enabled
    ? content
    : content.replace(
        /^<!-- software-map-start -->[^\n]*<!-- software-map-end -->\n/gm,
        "",
      );

  return selected.replace(
    /<!-- software-map-start -->([\s\S]*?)<!-- software-map-end -->/g,
    (_match, guidance: string) => (enabled ? guidance : ""),
  );
}

export async function renderInstructions(
  topic: InstructionTopic,
  context: InstructionContext,
  root = findReviewPackageRoot(import.meta.url),
): Promise<string> {
  if (
    topic === "scratchpad" &&
    !(
      context.scratchpadEnabled &&
      context.desktopAvailable &&
      context.authoringMode === "interactive"
    )
  ) {
    return "The Review scratchpad is turned off or Review Desktop is not running. Answer in chat; the scratchpad can be turned on in Review Desktop Settings.";
  }

  if (topic !== "authoring") return read(root, topic);

  const workflow = await read(
    root,
    context.authoringMode === "batch" ? "authoring-batch" : "authoring-live",
  );

  const more = [
    '- Headless servers and CI: `review_get_instructions({topic:"headless"})`',
    '- Reviews of prepared worktrees: `review_get_instructions({topic:"prepared-worktrees"})`',
    ...(context.scratchpadEnabled &&
    context.desktopAvailable &&
    context.authoringMode === "interactive"
      ? [
          '- Explaining code visually outside a review: `review_get_instructions({topic:"scratchpad"})`',
        ]
      : []),
    '- Why code exists / past agent sessions: `review_get_instructions({topic:"trace-archaeology"})`',
  ];

  return [
    withSoftwareMapGuidance(workflow, context.softwareMapEnabled),
    withSoftwareMapGuidance(
      await read(root, "document-authoring"),
      context.softwareMapEnabled,
    ),
    `## More guidance\n\n${more.join("\n")}`,
  ].join("\n\n");
}
