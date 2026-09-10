import {
  type HostBinding,
  type HostDiagnostic,
  type HostDocument,
  type HostDocumentState,
  HostDocumentValidationError,
  type HostMapVersion,
  type HostNode,
  type HostSourceQuote,
  HostSourceQuoteSchema,
  type HostSourceRange,
  affectedHostNodeIds,
  canonicalHostJson,
  validateHostDocument,
} from "@dev.fast/review-protocol";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  type EvidenceProvider,
  EvidenceProviderError,
} from "./evidence-provider";

type Awaitable<T> = T | Promise<T>;

/** Lookups must be scoped to the current review by the application service.
 * Returned resources are immutable and retained while documents reference them. */
export interface HostDocumentEvidenceResources {
  mapVersion?: (id: string) => Awaitable<HostMapVersion | undefined>;
  traceEvent?: (
    traceId: string,
    eventId: string,
  ) => Awaitable<{ id: string; traceId: string; text: string } | undefined>;
  asset?: (id: string) => Awaitable<{ id: string } | undefined>;
}

export interface HostChangedLines {
  added: ReadonlySet<number>;
  deleted: ReadonlySet<number>;
}

export interface ValidateHostDocumentEvidenceInput {
  document: HostDocument;
  binding: HostBinding;
  previous?: HostDocumentState;
  provider: EvidenceProvider;
  resources?: HostDocumentEvidenceResources;
  changedLines?: (
    binding: HostBinding,
    file: string,
    side: "base" | "head",
  ) => Awaitable<HostChangedLines | null>;
}

/** Validate proposed JSON before the host commits it. No filesystem, authored
 * module, renderer, or checkout is part of this validation boundary. */
export async function validateHostDocumentEvidence(
  input: ValidateHostDocumentEvidenceInput,
): Promise<{
  evidence: Record<string, HostSourceQuote>;
  affectedNodeIds: string[];
}> {
  const { document, binding, previous } = input;
  const issues = validateHostDocument(document);
  if (issues.length) throw new HostDocumentValidationError(issues);
  const samePins =
    previous !== undefined && sameBinding(previous.binding, binding);
  const affectedNodeIds = samePins
    ? affectedHostNodeIds(previous!, document)
    : Object.keys(document.nodes);

  // Parse prose only when it changed, before doing any external evidence work.
  for (const id of affectedNodeIds) {
    const node = document.nodes[id]!;
    if (node.type === "markdown") validateMarkdown(node);
  }

  const evidence: Record<string, HostSourceQuote> = {};
  for (const [id, definition] of Object.entries(document.definitions)) {
    if (definition.kind !== "anchor") continue;
    const old = previous?.definitions[id];
    const retained = previous?.evidence[id];
    if (
      samePins &&
      old?.kind === "anchor" &&
      canonicalHostJson(old.source) === canonicalHostJson(definition.source) &&
      retained &&
      quoteMatches(retained, binding, definition.source)
    ) {
      evidence[id] = retained;
    } else {
      const quote = await dependency(() =>
        input.provider.resolve(binding, definition.source),
      );
      if (
        !HostSourceQuoteSchema.safeParse(quote).success ||
        !quoteMatches(quote, binding, definition.source)
      ) {
        invalid(
          ["definitions", id, "source"],
          "The evidence provider returned a quotation for a different or invalid source range.",
        );
      }
      evidence[id] = quote;
    }
  }

  const maps = new Map<string, Promise<HostMapVersion | undefined>>();
  const requireMap = async (id: string, location: string[]) => {
    if (!input.resources?.mapVersion)
      unavailable("Software map lookup is unavailable.");
    let pending = maps.get(id);
    if (!pending) {
      const lookup = input.resources.mapVersion;
      pending = dependency(() => lookup(id));
      maps.set(id, pending);
    }
    const map = await pending;
    if (!map || map.id !== id)
      invalid(location, "The referenced map version does not exist.");
    if (
      map.repositoryId !== binding.repositoryId ||
      (map.commit !== binding.baseCommit && map.commit !== binding.headCommit)
    ) {
      invalid(
        location,
        "The referenced map must describe an exact base or head commit of this review.",
      );
    }
    return map;
  };

  for (const [id, definition] of Object.entries(document.definitions)) {
    if (definition.kind !== "actor" || !definition.mapElement) continue;
    if (
      samePins &&
      canonicalHostJson(previous!.definitions[id] ?? null) ===
        canonicalHostJson(definition)
    )
      continue;
    const location = ["definitions", id, "mapElement"];
    const map = await requireMap(definition.mapElement.mapVersionId, location);
    if (!Object.hasOwn(map.elements, definition.mapElement.elementId)) {
      invalid(
        location,
        "The actor's map element does not exist in the referenced map version.",
      );
    }
  }

  const changes = new Map<string, Promise<HostChangedLines | null>>();
  const changedLines = (file: string, side: "base" | "head") => {
    if (!input.changedLines)
      unavailable("Changed-line evidence is unavailable.");
    const key = `${side}\0${file}`;
    let pending = changes.get(key);
    if (!pending) {
      const lookup = input.changedLines;
      pending = dependency(() => lookup(binding, file, side));
      changes.set(key, pending);
    }
    return pending;
  };

  for (const id of affectedNodeIds) {
    const node = document.nodes[id]!;
    const location = ["nodes", id];
    if (node.type === "call_stack_diff") {
      for (const row of changedStackFrames(node)) {
        const definition = document.definitions[row.anchorId];
        // Definition kind and source-side matching were checked by the protocol.
        if (definition?.kind !== "anchor")
          invalid(location, "The frame has no source anchor.");
        const { file, fromLine, toLine } = definition.source;
        const lines = await changedLines(file, row.side);
        const actual = row.side === "base" ? lines?.deleted : lines?.added;
        let intersects = false;
        for (let line = fromLine; line <= toLine; line += 1) {
          if (actual?.has(line)) {
            intersects = true;
            break;
          }
        }
        if (!intersects)
          invalid(
            [...location, row.side, String(row.index), "anchorId"],
            `This ${row.side === "base" ? "removed" : "added"} frame must include a line ${row.side === "base" ? "deleted" : "added"} by the pinned change.`,
          );
      }
    } else if (node.type === "trace_quote") {
      if (!input.resources?.traceEvent)
        unavailable("Trace evidence lookup is unavailable.");
      const event = await dependency(() =>
        input.resources!.traceEvent!(node.traceId, node.eventId),
      );
      if (!event || event.id !== node.eventId || event.traceId !== node.traceId)
        invalid(location, "The exact retained trace event does not exist.");
      const quoted = normalizedQuote(node.text);
      if (!quoted || !normalizedQuote(event.text).includes(quoted))
        invalid(
          [...location, "text"],
          "The quotation is not present in the retained trace event.",
        );
    } else if (node.type === "image") {
      if (!input.resources?.asset)
        unavailable("Image asset lookup is unavailable.");
      const asset = await dependency(() =>
        input.resources!.asset!(node.assetId),
      );
      if (!asset || asset.id !== node.assetId)
        invalid(
          [...location, "assetId"],
          "The referenced image asset does not exist.",
        );
    } else if (node.type === "software_map") {
      const map = await requireMap(node.mapVersionId, [
        ...location,
        "mapVersionId",
      ]);
      if (
        node.focusElementId &&
        !Object.hasOwn(map.elements, node.focusElementId)
      )
        invalid(
          [...location, "focusElementId"],
          "The focused element does not exist in the referenced map version.",
        );
    }
  }
  return { evidence, affectedNodeIds };
}

function sameBinding(before: HostBinding, after: HostBinding): boolean {
  return (
    before.repositoryId === after.repositoryId &&
    before.baseCommit === after.baseCommit &&
    before.headCommit === after.headCommit
  );
}

function quoteMatches(
  quote: HostSourceQuote,
  binding: HostBinding,
  range: HostSourceRange,
): boolean {
  const { span } = quote;
  return (
    span.repositoryId === binding.repositoryId &&
    span.commit ===
      (range.side === "base" ? binding.baseCommit : binding.headCommit) &&
    span.file === range.file &&
    span.fromLine === range.fromLine &&
    span.toLine === range.toLine
  );
}

function validateMarkdown(node: Extract<HostNode, { type: "markdown" }>): void {
  const pending: Nodes[] = [
    fromMarkdown(node.markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  ];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.type === "html")
      invalid(
        ["nodes", node.id, "markdown"],
        "Raw HTML is not allowed in review Markdown.",
      );
    if (item.type === "image" || item.type === "imageReference")
      invalid(
        ["nodes", node.id, "markdown"],
        "Markdown image embeds are not allowed; use a retained image asset node.",
      );
    // Definition URLs are checked too, including links referenced elsewhere.
    if (
      (item.type === "link" || item.type === "definition") &&
      !safeLink(item.url)
    )
      invalid(
        ["nodes", node.id, "markdown"],
        "Markdown links must use HTTP, HTTPS, mailto, or a local heading fragment.",
      );
    if ("children" in item) pending.push(...item.children);
  }
}

function safeLink(href: string): boolean {
  if (/^#[A-Za-z0-9_-]+$/.test(href)) return true;
  if (
    /[\u0000-\u0020\u007f]/.test(href) ||
    !/^(?:https?:\/\/|mailto:)/i.test(href)
  )
    return false;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** Match stable frame IDs, not source IDs: one frame has different base/head
 * anchors. Reordering a shared frame is a move, not a changed-source claim. */
function changedStackFrames(
  node: Extract<HostNode, { type: "call_stack_diff" }>,
) {
  const { base, head } = node;
  const baseIds = new Set(base.map((frame) => frame.id));
  const headIds = new Set(head.map((frame) => frame.id));
  const rows: { side: "base" | "head"; index: number; anchorId: string }[] = [];
  base.forEach((frame, index) => {
    if (!headIds.has(frame.id))
      rows.push({ side: "base", index, anchorId: frame.anchorId });
  });
  head.forEach((frame, index) => {
    if (!baseIds.has(frame.id))
      rows.push({ side: "head", index, anchorId: frame.anchorId });
  });
  return rows;
}

function normalizedQuote(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function invalid(parts: string[], message: string): never {
  const issue: HostDiagnostic = {
    severity: "error",
    code: "INVALID_EVIDENCE",
    message,
    path: `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`,
  };
  if (parts[0] === "nodes") issue.nodeId = parts[1];
  if (parts[0] === "definitions") issue.definitionId = parts[1];
  throw new HostDocumentValidationError([issue]);
}

function unavailable(message: string): never {
  throw new EvidenceProviderError("DEPENDENCY_UNAVAILABLE", message);
}

async function dependency<T>(read: () => Awaitable<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof EvidenceProviderError ||
      error instanceof HostDocumentValidationError
    )
      throw error;
    return unavailable("The referenced review evidence is unavailable.");
  }
}
