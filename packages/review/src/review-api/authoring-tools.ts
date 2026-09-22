import { z } from "zod";

import { activitySchema } from "./activity.js";
import { fileLineRangeSchema } from "./document.js";
import { type AuthoringMode, draftCommandSchema } from "./drafts.js";
import { uploadSchema } from "./local-data.js";
import { inspectQuerySchema, readQuerySchemas } from "./read-schemas.js";
import { commandSchema } from "./store.js";

/** The host publishes its actual input schemas; adapters do not validate documents. */
export function authoringTools(mode: AuthoringMode = "interactive") {
  const id = z.string().min(1);
  const review = { reviewId: id };
  const sourceReview = mode === "batch" ? { draftId: id } : review;
  const sourcePath = mode === "batch" ? "/drafts/:draftId" : "/:reviewId";
  const version = z.number().int().nonnegative().optional();

  const read = (name: keyof typeof readQuerySchemas) => {
    const { version: _version, ...fields } = readQuerySchemas[name].shape;

    return z.strictObject({
      ...sourceReview,
      ...(mode === "batch" ? fields : readQuerySchemas[name].shape),
    });
  };

  const descriptions = {
    create:
      'Create a review with target: {kind: worktree, repositoryId, base?} for saved working files, or {kind: commits, repositoryId, head, base?} for immutable commits. Revisions are resolved on acceptance. Omitted commits base means source at head with no diff; supply the parent to review introduced changes. Legacy pins remain accepted. For a PR supply pullRequestUrl. kind:"scratchpad" names the one scratchpad, which the host creates itself.',
    set_target:
      "Change the review target, preserving document and component IDs. Returns warnings for source references needing repair. Earlier versions keep their retained source.",
    edit: "Insert, update, move, remove or replace a component. The host assigns short durable IDs. Create an outline of section headings and short descriptions with status:pending first. Patch each section to status:in_progress before filling it, then status:complete after checking its content. Use returned IDs to fill sections in place. Section status persists independently of activity; absent status is unspecified. Accepted edits are saved immediately. Omitted placement appends; on the scratchpad it lands at the top, so insert a multi-block thought bottom-up or chain each block with afterId. null removes an optional field in a patch. While a reader may be watching, write small and often: one paragraph per edit, so the document draws itself as you go. Insert a new diagram whole, with all its nodes and edges or steps; the board traces it in one quick pass. Change a diagram already on the board one unit at a time: insert, update or remove a flow_node, flow_edge or step by ID (parentId names the diagram). Give each added flow_node link:{from} (or to) naming a node already drawn, so it arrives attached; a separate flow_edge is only for two nodes that already exist. Removing a flow_node removes its edges.",
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

  const tools = [
    tool(
      "capabilities",
      "Discover the explicitly selected authoringMode (interactive or batch), whether Desktop is available and optional software-map generation is enabled. Read before authoring; only call review_open when desktopAvailable is true. Map uploads remain supported regardless of generation permission.",
      z.strictObject({}),
      "GET",
      "/capabilities",
    ),
    tool(
      "activity",
      "Acquire an exclusive authoring session: begin with a fresh leaseId UUID, pass that leaseId on every edit, rename, repin, target change, restore or delete, renew at least every 30 seconds, and end when finished. Another session gets a conflict while this lease is active. The lease expires after 60 seconds without renewal. Include focus:{description,targetId?} to show current work; omitted focus preserves it and null clears it. Ending the session does not mark sections complete or create document versions.",
      activitySchema.extend(review),
      "POST",
      "/:reviewId/activity",
    ),
    ...commandSchema.shape.operation.options.map((operation) => {
      const type = operation.shape.type.value;
      const { type: _type, ...fields } = operation.shape;

      return tool(
        type,
        `${descriptions[type]} Supply a commandId UUID; reuse it with identical input after a lost response. For content changes to an owned review, include the leaseId from review_activity.`,
        z.strictObject({
          ...fields,
          commandId: z.uuid(),
          leaseId: commandSchema.shape.leaseId,
        }),
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
      "Show a review immediately and prepare current pinned checkouts in the background. Returns softwareMapEnabled and any already-recorded environmentIssues. Missing optional setup is not an issue; use review_environment to recheck.",
      z.strictObject(review),
      "POST",
      "/:reviewId/open",
    ),
    tool(
      "environment",
      "Acquire and recheck this review's current base/head language checkouts (not historical or selected commits). Returns acquisition issues, not full LSP health. Missing optional setup and failed setup with a usable checkout stay silent. Set retry:true to rerun failed preparation after an actual language-feature failure; preparation runs in the background.",
      z.strictObject({ ...review, retry: z.boolean().optional() }),
      "POST",
      "/:reviewId/environment",
    ),
    tool(
      "workspace_cleanup",
      "Inspect failed cleanup of retired Review-owned checkouts. Supply workspaceId to retry removal of that checkout. This does not remove active review checkouts.",
      z.strictObject({ workspaceId: id.optional() }),
      "POST",
      "/workspace-cleanup",
    ),
    tool(
      "register_repository",
      "Register a local Git or jj repository. The prepared checkout path is on the authoring server.",
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
      "Read an exact code range from the current target (or batch draft pins). An explicit version reads retained historical source. source.pins {repositoryId, head, base?} reads at those commits of any registered repository instead; the same pins on a stored selection or markdown block make it resolve there.",
      mode === "batch"
        ? z.strictObject({
            draftId: id,
            source: fileLineRangeSchema,
            commit: z.string().min(1).optional(),
          })
        : z.strictObject({
            ...review,
            version,
            source: fileLineRangeSchema,
            commit: z.string().min(1).optional(),
          }),
      "POST",
      `${sourcePath}/source`,
    ),
    tool(
      "file",
      "Read a complete source file from the current target; version selects retained history. repositoryId and head (and base for the base side) read at explicit pins of any registered repository instead.",
      read("file"),
      "GET",
      `${sourcePath}/file`,
    ),
    tool(
      "tree",
      "List immediate directory entries in the target, including working files for worktree targets. repositoryId and head list a registered repository at explicit pins instead.",
      read("tree"),
      "GET",
      `${sourcePath}/tree`,
    ),
    tool(
      "diff",
      "Read changed-file summaries, or patch text when file is supplied. commit selects one commit from this review; repositoryId, base and head compare explicit pins of a registered repository instead.",
      read("diff"),
      "GET",
      `${sourcePath}/diff`,
    ),
    tool(
      "commits",
      "List commits in this review's pinned comparison.",
      read("commits"),
      "GET",
      `${sourcePath}/commits`,
    ),
  ];

  if (mode === "interactive") return tools;

  const draftDescriptions = {
    begin:
      "Begin an exclusive server-owned scratch draft. Supply reviewId to update a saved review, or title and resolved pins for a new review. Updating a live worktree review requires explicit resolved pins and commits it as a fixed commit target. No committed placeholder is created. No activity or heartbeat is needed. A live server retains ownership until commit, abort or shutdown.",
    write:
      "Replace the complete scratch document and optionally its metadata. Omit component IDs; the server allocates fresh IDs and returns the draft. Writes do not create committed versions. Prefer this bulk operation to many edits.",
    edit: "Apply a targeted edit to the scratch document using IDs returned by draft_get or draft_write. No committed version is created.",
    validate:
      "Check draft shape, references, pins, source ranges and resources before commit. Errors leave the draft editable.",
    commit:
      "Validate and atomically commit exactly one snapshot, marking every section complete and releasing ownership. Supply a fresh commandId UUID; retry with the same draftId and commandId after a lost response. Readers see the previous committed version until this succeeds.",
    abort:
      "Discard scratch content and release ownership, preserving the last committed version. Drafts are also discarded when their server stops; there is no resume or merge.",
  };

  return [
    ...tools.filter(
      (entry) =>
        entry.name !== "review_activity" &&
        (!entry.commandType || entry.commandType === "attention"),
    ),
    tool(
      "draft_get",
      "Read scratch content and its server-assigned editable IDs.",
      z.strictObject({ draftId: z.uuid() }),
      "GET",
      "/drafts/:draftId",
    ),
    ...draftCommandSchema.options.map((operation) => {
      const type = operation.shape.type.value;
      const { type: _type, ...fields } = operation.shape;

      return tool(
        `draft_${type}`,
        draftDescriptions[type],
        z.strictObject(fields),
        "POST",
        `/draft-commands/${type}`,
      );
    }),
  ];
}
