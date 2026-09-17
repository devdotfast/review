import { z } from "zod";

import { activitySchema } from "./activity.js";
import { sourceSchema } from "./document.js";
import { uploadSchema } from "./local-data.js";
import { inspectQuerySchema, readQuerySchemas } from "./read-schemas.js";
import { commandSchema } from "./store.js";

/** The host publishes its actual input schemas; adapters do not validate documents. */
export function authoringTools() {
  const id = z.string().min(1);
  const review = { reviewId: id };
  const version = z.number().int().nonnegative().optional();

  const read = (name: keyof typeof readQuerySchemas) =>
    z.strictObject({ ...review, ...readQuerySchemas[name].shape });

  const descriptions = {
    create:
      "Create a review with target: {kind: worktree, repositoryId, base?} for saved working files, or {kind: commits, repositoryId, head, base?} for immutable commits. Revisions are resolved on acceptance. Omitted commits base means source at head with no diff; supply the parent to review introduced changes. Legacy pins remain accepted. For a PR supply pullRequestUrl.",
    set_target:
      "Change the review target, preserving document and component IDs. Returns warnings for source references needing repair. Earlier versions keep their retained source.",
    edit: "Insert, update, move, remove or replace a component. The host assigns short durable IDs. Create an outline of section headings and short descriptions with status:pending first. Patch each section to status:in_progress before filling it, then status:complete after checking its content. Use returned IDs to fill sections in place. Section status persists independently of activity; absent status is unspecified. Accepted edits are saved immediately. Omitted placement appends; null removes an optional field in a patch.",
    rename: "Change the review title.",
    repin:
      "Update source pins or PR identity while preserving the document and component IDs. Returns warnings for retained source ranges to verify and resources that no longer match; fix them with review_edit. Previous pins and content remain in history. Omitted pullRequestUrl preserves PR identity within the same repository; changing repositories clears it. Supply a URL to replace it or null to detach.",
    restore:
      "Restore title, source pins, PR identity and content from a saved version. Comments are not rolled back.",
    attention:
      "Mark a review viewed, dismissed or restored without changing its content.",
    delete: "Permanently delete this review and its history.",
  };

  const tool = (
    name: string,
    description: string,
    schema: z.ZodType,
    method: "GET" | "POST",
    path: string,
    commandType?: string,
  ) => ({
    name: `review_${name}`,
    description,
    inputSchema: {
      ...z.toJSONSchema(schema, { io: "input" }),
      type: "object" as const,
    },
    method,
    path,
    commandType,
  });

  return [
    tool(
      "activity",
      "Report authoring work: begin with a fresh leaseId UUID, renew at least every 30 seconds, and end when finished. Ending activity does not mark sections complete. Include focus:{description,targetId?} to show the current work and optionally mark an existing section or component. Draft the outline first, then update focus before filling each section. Omitted focus preserves it; null clears it. Activity expires after 60 seconds without renewal. It does not lock edits or create document versions.",
      activitySchema.extend(review),
      "POST",
      "/:reviewId/activity",
    ),
    ...commandSchema.shape.operation.options.map((operation) => {
      const type = operation.shape.type.value;
      const { type: _type, ...fields } = operation.shape;

      return tool(
        type,
        `${descriptions[type]} Supply a commandId UUID; reuse it with identical input after a lost response.`,
        z.strictObject({ ...fields, commandId: z.uuid() }),
        "POST",
        "/commands",
        type,
      );
    }),
    tool("list", "List saved reviews.", z.strictObject({}), "GET", ""),
    tool(
      "get",
      "Read a readable, nested text outline with editable IDs. targetId reads one component in full; full:true reads all content. Use format:json for raw node data or snapshots instead of text.",
      z.strictObject({ ...review, ...inspectQuerySchema.shape }),
      "GET",
      "/:reviewId/inspect",
    ),
    tool(
      "history",
      "List saved document versions.",
      z.strictObject(review),
      "GET",
      "/:reviewId/history",
    ),
    tool(
      "open",
      "Show a review in the running Desktop and return softwareMapEnabled.",
      z.strictObject(review),
      "POST",
      "/:reviewId/open",
    ),
    tool(
      "register_repository",
      "Register a local Git or jj repository. The path is on the desktop host.",
      z.strictObject({ path: id }),
      "POST",
      "/repositories",
    ),
    tool(
      "resolve_pins",
      "Resolve base and head revisions to immutable commit IDs for create or repin.",
      z.strictObject({ repositoryId: id, base: id, head: id }),
      "POST",
      "/pins",
    ),
    tool(
      "upload",
      'Retain a resource. kind must be "image" (base64), "trace" (trace), or "map" (pins, side, model). Reusing an upload ID requires identical content; rejected uploads are not saved.',
      uploadSchema,
      "POST",
      "/resources",
    ),
    tool(
      "source",
      "Read an exact code range from the current target. An explicit version reads retained historical source.",
      z.strictObject({ ...review, version, source: sourceSchema }),
      "POST",
      "/:reviewId/source",
    ),
    tool(
      "file",
      "Read a complete source file from the current target; version selects retained history.",
      read("file"),
      "GET",
      "/:reviewId/file",
    ),
    tool(
      "tree",
      "List immediate directory entries in the target, including working files for worktree targets.",
      read("tree"),
      "GET",
      "/:reviewId/tree",
    ),
    tool(
      "diff",
      "Read changed-file summaries, or patch text when file is supplied. commit selects one commit from this review.",
      read("diff"),
      "GET",
      "/:reviewId/diff",
    ),
    tool(
      "commits",
      "List commits in this review's pinned comparison.",
      read("commits"),
      "GET",
      "/:reviewId/commits",
    ),
  ];
}
