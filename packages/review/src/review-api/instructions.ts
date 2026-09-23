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
}

export function scratchpadAvailable(context: InstructionContext): boolean {
  return (
    context.authoringMode === "interactive" &&
    context.desktopAvailable &&
    context.scratchpadEnabled
  );
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

export async function renderInstructions(
  topic: InstructionTopic,
  context: InstructionContext,
  root = findReviewPackageRoot(import.meta.url),
): Promise<string> {
  if (topic === "scratchpad" && !scratchpadAvailable(context)) {
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
    ...(scratchpadAvailable(context)
      ? [
          '- Explaining code visually outside a review: `review_get_instructions({topic:"scratchpad"})`',
        ]
      : []),
    '- Why code exists / past agent sessions: `review_get_instructions({topic:"trace-archaeology"})`',
  ];

  return [
    workflow,
    await read(root, "document-authoring"),
    `## More guidance\n\n${more.join("\n")}`,
  ].join("\n\n");
}
