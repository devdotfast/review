import { z } from "zod";

import { activitySchema } from "./activity.js";
import { fileLineRangeSchema } from "./document.js";
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
      'Create a review with target: {kind: worktree, repositoryId, base?} for saved working files, or {kind: commits, repositoryId, head, base?} for immutable commits. Revisions are resolved on acceptance. Omitted commits base means source at head with no diff; supply the parent to review introduced changes. Legacy pins remain accepted. For a GitHub PR, pullRequestUrl alone is enough: target and title become optional, and the host fetches the PR into a registered checkout of its repository (or repositoryId) and pins the current PR head and GitHub diff base, titled from the PR. When a review for that PR exists, it is returned instead (created:false, a note saying so, its stored target, headMoved when the requested or current PR head differs, ownedBy when another session is authoring it); update it in place, move its target with review_set_target, or pass reuseExisting:false for a separate review. kind:"scratchpad" names the one scratchpad, which the host creates itself. The result carries review, the review as review_list shows it: its target with resolved commits, origin (its PR), repositoryName and repositoryPath, so no follow-up read is needed before diffing. When Desktop is available the review opens there and the result reports opened, softwareMapEnabled and environmentIssues, as review_open does; set open:false to author in the background without taking over Desktop.',
    set_target:
      "Change the review target, preserving document and component IDs. Returns warnings for source references needing repair. Earlier versions keep their retained source.",
    edit: "Insert, update, move, remove or replace a component. The host assigns short durable IDs; use returned IDs to edit components in place. The result names the target's type and, for an insert or replace, its first-level children as {id,type} (a container's blocks; a diagram's steps, or nodes then edges). Accepted edits are saved immediately. Omitted placement appends; on the scratchpad it lands at the top, so insert a multi-block thought bottom-up or chain each block with afterId. null removes an optional field in a patch. While a reader may be watching, write small and often: one paragraph per edit, so the document draws itself as you go. Insert a new diagram whole, with all its nodes and edges or steps; the board traces it in one quick pass. Change a diagram already on the board one unit at a time: insert, update or remove a flow_node, flow_edge or step by ID (parentId names the diagram). Give each added flow_node link:{from} (or to) naming a node already drawn, so it arrives attached; a separate flow_edge is only for two nodes that already exist. Removing a flow_node removes its edges.",
    lens: 'Insert, update or remove one Diff-view lens. Lenses partition the review\'s change for the Diff view; they sit beside the document (never in it) and version with it. insert {title, targets, afterId?} appends (or follows afterId) and the host assigns the id (lens-N); update {targetId, title?, targets?} replaces only the fields named; remove {targetId}. targets is a union of {kind:"files", patterns:[paths or globs]} and {kind:"ranges", sources:[selections]}. Write one lens per call while a reader may be watching; each draws in on the Diffs page. Requires the lenses lease: review_activity with scope:"lenses", which another agent can hold while the document lease is held elsewhere. The result names the lens (targetId, type:"lens") and reports uncategorized: the changed lines no lens selects yet, by file ({lines, files:[{path, lines, ranges}], moreFiles?}). Keep adding lenses until it is empty or what remains is deliberate. review_lens_get reads the current lenses and gaps.',
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
      "capabilities",
      "Discover whether Desktop is available and optional software-map generation is enabled. Read before authoring. Map uploads remain supported regardless of generation permission.",
      z.strictObject({}),
      "GET",
      "/capabilities",
    ),
    tool(
      "activity",
      'Acquire an exclusive authoring session for one scope of a review: begin with a fresh leaseId UUID, pass that leaseId on every write in that scope, and end when finished. scope "document" (default) covers every edit, rename, repin, target change, restore or delete; scope "lenses" covers review_lens_edit writes only, so one agent can author lenses while another holds the document lease. Each scope has its own lease and focus; a focus targetId in the lenses scope names a lens id. Each accepted write carrying the leaseId keeps the session alive; renew during long reads or pauses between edits. The lease expires after 3 minutes without an accepted edit or renewal. Another session gets a conflict while this lease is active. Include focus:{description,targetId?} to show current work; omitted focus preserves it and null clears it. End the session only when the review is finished: readers treat a review with content and no live session as ready. Ending it creates no document version.',
      activitySchema.extend(review),
      "POST",
      "/:reviewId/activity",
    ),
    ...commandSchema.shape.operation.options.map((operation) => {
      const type = operation.shape.type.value;
      const { type: _type, ...fields } = operation.shape;

      return tool(
        type === "lens" ? "lens_edit" : type,
        `${descriptions[type]} Supply a commandId UUID; reuse it with identical input after a lost response. For content changes to an owned review, include the leaseId from review_activity.`,
        z.strictObject({
          ...fields,
          ...(type === "create" && { open: z.boolean().optional() }),
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
      "lens_get",
      "Read the review's Diff-view lenses as authored (ids, titles, targets), each lens's resolved fileCount (and unavailable reason, if any), and uncategorized: the changed lines no lens selects yet, by file.",
      z.strictObject(review),
      "GET",
      "/:reviewId/lenses",
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
      "Show an existing review immediately and prepare current pinned checkouts in the background. Returns softwareMapEnabled and any already-recorded environmentIssues. Missing optional setup is not an issue; use review_environment to recheck.",
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
      "Read an exact code range from the current target. An explicit version reads retained historical source. source.pins {repositoryId, head, base?} reads at those commits of any registered repository instead; the same pins on a stored selection or markdown block make it resolve there.",
      z.strictObject({
        ...review,
        version,
        source: fileLineRangeSchema,
        commit: z.string().min(1).optional(),
      }),
      "POST",
      "/:reviewId/source",
    ),
    tool(
      "file",
      "Read a complete source file from the current target; version selects retained history. repositoryId and head (and base for the base side) read at explicit pins of any registered repository instead.",
      read("file"),
      "GET",
      "/:reviewId/file",
    ),
    tool(
      "tree",
      "List immediate directory entries in the target, including working files for worktree targets. repositoryId and head list a registered repository at explicit pins instead.",
      read("tree"),
      "GET",
      "/:reviewId/tree",
    ),
    tool(
      "diff",
      'Read this review\'s changes. paths selects files (default: all). format:"files" lists them with status and counts; format:"patch" returns plain-text patches with base and head line numbers on every line, ready for review-source links. Patches past maxBytes are listed with a paths:[…] hint. commit selects one commit from this review; repositoryId, base and head compare explicit pins of a registered repository instead.',
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
