import { createHash } from "node:crypto";

import { parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { ReviewServerError } from "./server/http-json";

const marker = "review-live/";
const nodeSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
  source: z
    .string()
    .min(1)
    .refine((source) => !source.includes(marker), {
      message: "MDX fragments cannot contain reserved review-live markers.",
    }),
});
const nodesSchema = z
  .array(nodeSchema)
  .max(1000)
  .refine(
    (nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length,
    { message: "Node IDs must be unique." },
  );
const headerSchema = z.strictObject({
  revision: z.number().int().positive(),
  mutationId: z.uuid(),
  requestHash: z.string(),
});

export const ReviewLiveMutationSchema = z.strictObject({
  reviewUuid: z.uuid(),
  mutationId: z.uuid(),
  expectedSourceHash: z.string().nullable(),
  operation: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("replace"), nodes: nodesSchema }),
    z.strictObject({
      type: z.literal("insert"),
      node: nodeSchema,
      afterId: nodeSchema.shape.id.nullable(),
    }),
    z.strictObject({
      type: z.literal("update"),
      node: nodeSchema,
    }),
    z.strictObject({ type: z.literal("delete"), id: nodeSchema.shape.id }),
    z.strictObject({
      type: z.literal("move"),
      id: nodeSchema.shape.id,
      afterId: nodeSchema.shape.id.nullable(),
    }),
  ]),
});

export type ReviewLiveMutation = z.infer<typeof ReviewLiveMutationSchema>;
type LiveNode = z.infer<typeof nodeSchema>;
interface LiveDocument extends z.infer<typeof headerSchema> {
  nodes: LiveNode[];
}

/** Ordinary MDX, compiled by the same native compiler as a sealed document. */
export function serializeLiveDocument(document: LiveDocument): string {
  const { nodes, ...header } = document;
  return [
    `{/* review-live/1 ${JSON.stringify(header)} */}`,
    'import * as data from "./data.ts";',
    ...nodes.map(
      ({ id, source }) =>
        `{/* review-live/node ${id} */}\n<section id="review-node-${id}" className="review-live-${createHash("sha256").update(source).digest("hex")}">\n\n${source}\n\n</section>\n{/* review-live/end */}`,
    ),
    "",
  ].join("\n\n");
}

export function parseLiveDocument(source: string | null): LiveDocument | null {
  if (!source?.startsWith("{/* review-live/1 ")) return null;
  const header = /^\{\/\* review-live\/1 (.+) \*\/\}/.exec(source);
  if (!header) throw conflict("Invalid live document header.");
  const metadata = headerSchema.parse(parseJsonText(header[1]!));
  const nodes = [
    ...source.matchAll(
      /\{\/\* review-live\/node ([\w-]+) \*\/\}\n<section id="review-node-\1" className="review-live-[a-f0-9]+">\n\n([\s\S]*?)\n\n<\/section>\n\{\/\* review-live\/end \*\/\}/g,
    ),
  ].map((match) => ({ id: match[1]!, source: match[2]! }));
  const document = { ...metadata, nodes: nodesSchema.parse(nodes) };
  if (serializeLiveDocument(document) !== source)
    throw conflict(
      "Live document structure changed outside the node API. Replace the document explicitly to recover.",
    );
  return document;
}

/** Pure edit planning: no source is changed until the native compiler accepts it. */
export function planLiveMutation(
  current: { source: string | null; sourceHash: string | null },
  request: ReviewLiveMutation,
): string {
  // An explicit replacement can also recover a manually damaged live document.
  let document: LiveDocument | null;
  try {
    document = parseLiveDocument(current.source);
  } catch (error) {
    if (request.operation.type !== "replace") throw error;
    document = null;
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  if (document?.mutationId === request.mutationId) {
    if (document.requestHash !== requestHash)
      throw conflict("Mutation ID was already used for a different edit.");
    return current.source!;
  }
  if (current.sourceHash !== request.expectedSourceHash)
    throw conflict(
      "Document source changed. Read the live document before retrying.",
    );
  const operation = request.operation;
  if (!document && operation.type !== "replace")
    throw conflict(
      "Use replace to explicitly start live authoring of this document.",
    );
  const nodes = [...(document?.nodes ?? [])];
  const indexOf = (id: string) => {
    const index = nodes.findIndex((node) => node.id === id);
    if (index < 0) throw conflict(`Unknown live node: ${id}`);
    return index;
  };
  switch (operation.type) {
    case "replace":
      nodes.splice(0, nodes.length, ...operation.nodes);
      break;
    case "update":
      nodes[indexOf(operation.node.id)] = operation.node;
      break;
    case "delete":
      nodes.splice(indexOf(operation.id), 1);
      break;
    case "insert":
      if (nodes.some((node) => node.id === operation.node.id))
        throw conflict(`Live node already exists: ${operation.node.id}`);
      nodes.splice(
        operation.afterId === null ? 0 : indexOf(operation.afterId) + 1,
        0,
        operation.node,
      );
      break;
    case "move": {
      if (operation.id === operation.afterId)
        throw conflict("A node cannot be moved after itself.");
      const [node] = nodes.splice(indexOf(operation.id), 1);
      nodes.splice(
        operation.afterId === null ? 0 : indexOf(operation.afterId) + 1,
        0,
        node!,
      );
      break;
    }
  }
  return serializeLiveDocument({
    revision: (document?.revision ?? 0) + 1,
    mutationId: request.mutationId,
    requestHash,
    nodes: nodesSchema.parse(nodes),
  });
}

function conflict(message: string): ReviewServerError {
  return new ReviewServerError(message, 409);
}
