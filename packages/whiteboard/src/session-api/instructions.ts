import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { findWhiteboardPackageRoot } from "../package-paths.js";

export const INSTRUCTION_TOPICS = [
  "authoring",
  "file-lenses",
  "scratchpad",
  "trace-archaeology",
] as const;

export type InstructionTopic = (typeof INSTRUCTION_TOPICS)[number];

export const instructionsQuerySchema = z.strictObject({
  topic: z.enum(INSTRUCTION_TOPICS).default("authoring"),
});

export interface InstructionContext {
  desktopAvailable: boolean;
  scratchpadEnabled: boolean;
  traceEnabled: boolean;
}

export function scratchpadAvailable(context: InstructionContext): boolean {
  return context.desktopAvailable && context.scratchpadEnabled;
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
  root = findWhiteboardPackageRoot(import.meta.url),
): Promise<string> {
  if (topic === "scratchpad" && !scratchpadAvailable(context)) {
    return "The Whiteboard scratchpad is turned off or Whiteboard Desktop is not running. Answer in chat; the scratchpad can be turned on in Whiteboard Desktop Settings.";
  }

  if (topic === "trace-archaeology" && !context.traceEnabled)
    return "Trace capture is off on this machine, so no agent traces are available. It can be turned on in Whiteboard Desktop Settings under Experimental Features.";

  if (topic !== "authoring") return read(root, topic);

  const more = [
    ...(scratchpadAvailable(context)
      ? [
          '- Explaining code visually outside a whiteboard: `session_get_instructions({topic:"scratchpad"})`',
        ]
      : []),
    ...(context.traceEnabled
      ? [
          '- Why code exists / past agent sessions: `session_get_instructions({topic:"trace-archaeology"})`',
        ]
      : []),
  ];

  return [
    await read(root, "authoring"),
    ...(context.traceEnabled
      ? [
          '## Traces\n\nAt the end, check if traces are available via `session_get_instructions({topic:"trace-archaeology"})`, and rewrite as much as possible of the what/why, design, and requirements sections in terms of literal trace quotes from the user.',
        ]
      : []),
    ...(more.length ? [`## More guidance\n\n${more.join("\n")}`] : []),
  ].join("\n\n");
}
