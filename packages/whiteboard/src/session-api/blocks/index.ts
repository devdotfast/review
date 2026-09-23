import { z } from "zod";

import { FILE_LENS_MOVED } from "../diff-lenses.js";
import { call_stack_diff } from "./call_stack_diff.js";
import { type CalloutBlock, callout } from "./callout.js";
import { code } from "./code.js";
import { code_peek } from "./code_peek.js";
import { database_lens } from "./database_lens.js";
import type { BlockDefinition } from "./definition.js";
import { divider } from "./divider.js";
import { flow_diagram } from "./flow_diagram.js";
import { image } from "./image.js";
import { markdown } from "./markdown.js";
import { type SectionBlock, section } from "./section.js";
import { sequence } from "./sequence.js";
import { software_map } from "./software_map.js";
import { trace_quote } from "./trace_quote.js";
import { type TutorialBlock, tutorial } from "./tutorial.js";

/** Lenses left the document; say where they went instead of listing every
 * block type the input did not match. */
function fileLensMoved(issue: { input?: unknown }) {
  return retiredFileLens.safeParse(issue.input).success
    ? FILE_LENS_MOVED
    : undefined;
}

const retiredFileLens = z.object({ type: z.literal("file_lens") });

const typedInput = z.object({ type: z.string() });

/** A failed union names the type it tried and that type's field errors,
 * instead of zod's bare "Invalid input". */
export function unionError(kinds: () => Record<string, z.ZodType>) {
  return (issue: { input?: unknown }) => {
    const moved = fileLensMoved(issue);

    if (moved) return moved;

    const typed = typedInput.safeParse(issue.input);

    if (!typed.success) return undefined;

    const { type } = typed.data;
    const all = kinds();
    const schema = Object.hasOwn(all, type) ? all[type] : undefined;

    if (!schema)
      return `Unknown content type "${type}". Use one of: ${Object.keys(all).join(", ")}.`;

    const result = schema.safeParse(issue.input);

    if (result.success) return undefined;

    return `Invalid ${type}: ${result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message)
      .join("; ")}`;
  };
}

/** Leaf kinds share one discriminated union so unknown types read as they always have. */
export const leafSchema = z.discriminatedUnion(
  "type",
  [
    markdown.schema,
    code.schema,
    divider.schema,
    code_peek.schema,
    sequence.schema,
    call_stack_diff.schema,
    database_lens.schema,
    image.schema,
    trace_quote.schema,
    software_map.schema,
    flow_diagram.schema,
  ],
  { error: fileLensMoved },
);

export type LeafBlock = z.infer<typeof leafSchema>;

export type Block = LeafBlock | SectionBlock | CalloutBlock | TutorialBlock;

export type BlockType = Block["type"];

export type Definitions = {
  [K in BlockType]: BlockDefinition<Extract<Block, { type: K }>>;
};

/** Every block kind, keyed by type. A kind without a definition is a compile error. */
export const blocks = {
  markdown,
  code,
  divider,
  code_peek,
  sequence,
  call_stack_diff,
  database_lens,
  image,
  trace_quote,
  software_map,
  flow_diagram,
  section,
  callout,
  tutorial,
} satisfies Definitions;

/** Every block type and its schema. */
export const blockKinds = (): Record<string, z.ZodType> =>
  Object.fromEntries(
    Object.entries(blocks).map(([type, definition]) => [
      type,
      definition.schema,
    ]),
  );

export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.union([leafSchema, section.schema, callout.schema, tutorial.schema], {
    error: unionError(blockKinds),
  }),
);

function checkBlock<K extends BlockType>(
  type: K,
  block: Extract<Block, { type: K }>,
): void {
  const definition: Definitions[K] = blocks[type];
  definition.check?.(block);
}

/** Relationships not expressible in a field schema. Sources/resources are checked by host providers. */
export function checkReferences(document: Block[]): void {
  const visit = (block: Block) => {
    checkBlock(block.type, block);

    if ("children" in block) block.children.forEach(visit);
  };

  document.forEach(visit);
}
