import path from "node:path";

import { type Block, elements } from "../review-api/document";
import type {
  ReviewComponentNode,
  ReviewDocumentData,
  ReviewElementNode,
  ReviewNode,
} from "../review-document-data";
import {
  type RenderProseNode,
  collectFootnoteDefinitions,
  isFootnoteSection,
  isProseNode,
  proseToMarkdown,
} from "./prose-markdown";

/** A trace quote the caller must resolve against trace storage: the block in
 * `blocks` carries `placeholder` as its `traceId` until then. */
export interface TraceRequest {
  sessionId: string;
  trace?: string;
  eventIndex?: number;
  quote: string;
  placeholder: string;
}

/** An image file the caller must read beside the sealed document: the block in
 * `blocks` carries `placeholder` as its `assetId` until then. */
export interface ImageRequest {
  src: string;
  alt: string;
  placeholder: string;
}

export interface LegacyConversion {
  blocks: Block[];
  traces: TraceRequest[];
  images: ImageRequest[];
  warnings: string[];
}

interface WithId {
  id?: string;
}

/**
 * The sealed `review-document/1` tree as JSON blocks. The input must already be
 * upgraded (`upgradeReviewDocumentJson`), so peeks carry a source range, call
 * stacks carry frames, sequences carry steps and lenses are canonical.
 * Component ids are dropped everywhere: the store assigns its own.
 */
export function legacyDocumentToBlocks(
  document: ReviewDocumentData,
): LegacyConversion {
  const traces: TraceRequest[] = [];
  const images: ImageRequest[] = [];
  const warnings: string[] = [];

  const traceQuote = (
    node: Extract<ReviewNode, { type: "component"; name: "TraceQuote" }>,
  ): Extract<Block, { type: "trace_quote" }> => {
    const placeholder = `trace-placeholder-${traces.length + 1}`;
    const quote = plainText(node.children);
    const eventIndex = node.props.event;
    traces.push({
      sessionId: node.props.sessionId,
      trace: node.props.trace,
      eventIndex,
      quote,
      placeholder,
    });

    return {
      type: "trace_quote",
      traceId: placeholder,
      eventId: String(eventIndex ?? 0),
      text: quote,
    };
  };

  const imageRequest = (
    node: ReviewElementNode,
  ): Extract<Block, { type: "image" }> => {
    const placeholder = `image-placeholder-${images.length + 1}`;
    const src = String(node.props.src ?? "");
    // `alt` is a label, so a decorative image still needs a name to show.
    const alt =
      String(node.props.alt ?? "").trim() ||
      path.posix.basename(src) ||
      "Image";
    images.push({ src, alt, placeholder });

    return { type: "image", assetId: placeholder, alt };
  };

  const render: RenderProseNode = (node) => {
    if (node.name !== "TraceQuote") return undefined;

    const quote = traceQuote(node);
    const label = quote.text.replace(/([\\`*_[\]<>])/g, "\\$1");

    return `[${label}](review-trace:${quote.traceId}#${quote.eventId})`;
  };

  /** The block a node nested in prose becomes, Markdown carrying neither a
   * diagram nor a stored image. */
  const hoistable = (node: ReviewNode): Block | undefined => {
    if (node.type === "element")
      return isStoredImage(node) ? imageRequest(node) : undefined;

    return node.type === "component" ? diagramBlock(node) : undefined;
  };

  const withoutHoisted = (node: ReviewNode, hoisted: Block[]): ReviewNode => {
    if (node.type === "text") return node;

    const children = node.children.flatMap((child): ReviewNode[] => {
      const block = hoistable(child);

      if (!block) return [withoutHoisted(child, hoisted)];

      hoisted.push(block);

      return [];
    });

    return { ...node, children };
  };

  /** `nodes` with each hoistable node lifted out of the prose that held it and
   * emitted right after it. Footnote sections are dropped, their definitions
   * already collected, so what a definition holds stays inside it. */
  const hoistBlocks = (nodes: ReviewNode[]): Array<ReviewNode | Block> => {
    const out: Array<ReviewNode | Block> = [];

    for (const node of nodes) {
      if (!isProseNode(node)) {
        out.push(node);
        continue;
      }

      if (isFootnoteSection(node)) continue;

      const hoisted: Block[] = [];

      out.push(withoutHoisted(node, hoisted), ...hoisted);
    }

    return out;
  };

  const footnotes = collectFootnoteDefinitions(document.body, warnings, render);

  const convert = (nodes: ReviewNode[]): Block[] => {
    const out: Block[] = [];
    let prose: ReviewNode[] = [];

    const flush = () => {
      if (prose.length === 0) return;

      const markdown = proseToMarkdown(
        prose,
        footnotes,
        warnings,
        render,
      ).trim();

      if (markdown) out.push({ type: "markdown", markdown: `${markdown}\n` });
      prose = [];
    };

    for (const node of hoistBlocks(nodes)) {
      if (
        node.type !== "text" &&
        node.type !== "element" &&
        node.type !== "component"
      ) {
        flush();
        out.push(node);
        continue;
      }

      if (isProseNode(node)) {
        prose.push(node);
        continue;
      }

      flush();

      if (node.type !== "component") continue;

      const diagram = diagramBlock(node);

      if (diagram) {
        out.push(diagram);
        continue;
      }

      switch (node.name) {
        case "ReviewSection": {
          const section: Block = {
            type: "section",
            title: node.props.title,
            // The old renderer consumed this heading as section metadata.
            children: convert(sectionBody(node)),
          };

          if (node.props.defaultCollapsed === true)
            section.defaultCollapsed = true;
          out.push(section);
          break;
        }

        case "CodePeek": {
          const peek: Block = {
            type: "code_peek",
            source: node.props.anchor.peek,
          };

          if (node.props.anchor.title) peek.caption = node.props.anchor.title;
          out.push(peek);
          break;
        }

        case "TraceQuote": {
          out.push(traceQuote(node));
          break;
        }

        case "TutorialViewButton":
          out.push({
            type: "tutorial",
            kind: "view",
            view: node.props.view,
            label: proseToMarkdown(node.children, footnotes, warnings).trim(),
          });
          break;
        case "TutorialFeature":
          out.push({
            type: "tutorial",
            kind: "feature",
            feature: node.props.feature,
            children: convert(node.children),
          });
          break;
        case "TutorialKeymapPicker":
          out.push({ type: "tutorial", kind: "keymap" });
          break;
        case "TutorialAuthoringConversation":
          out.push({
            type: "tutorial",
            kind: "conversation",
            conversation: node.props.conversation,
          });
          break;
        default:
          warnings.push(`Dropped ${node.name} outside its parent.`);
      }
    }

    flush();

    return out;
  };

  return { blocks: convert(document.body), traces, images, warnings };
}

/** The diagram components as blocks, wherever they were authored. */
function diagramBlock(node: ReviewComponentNode): Block | undefined {
  switch (node.name) {
    case "CallStackDiff":
      return {
        type: "call_stack_diff",
        title: node.props.title || "Call stack",
        base: stripIds(node.props.base),
        head: stripIds(node.props.head),
      };
    case "SequenceDiagram":
      return {
        type: "sequence",
        title: node.props.title,
        actors: node.props.actors,
        steps: stripIds(node.props.steps),
      };
    case "DatabaseLens": {
      const { title, actors, stores, useCases } = node.props;

      return {
        type: "database_lens",
        title: title ?? "Database",
        actors,
        stores,
        useCases: useCases.map(({ id: _id, operations, ...useCase }) => ({
          ...useCase,
          operations: stripIds(operations),
        })),
      };
    }

    default:
      return undefined;
  }
}

/** An image the review published alongside its document, so the import has a
 * file to store. One with a scheme (`https:`, `data:`) stays a Markdown image,
 * which the reader can still fetch. */
function isStoredImage(node: ReviewElementNode): boolean {
  return (
    node.tag === "img" &&
    !/^[a-z][\d+.a-z-]*:/i.test(String(node.props.src ?? ""))
  );
}

function stripIds<T extends WithId>(items: T[]): Omit<T, "id">[] {
  return items.map(({ id: _id, ...rest }) => rest);
}

function plainText(nodes: ReviewNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : plainText(node.children),
    )
    .join("")
    .trim();
}

function sectionBody(
  node: Extract<ReviewNode, { name: "ReviewSection" }>,
): ReviewNode[] {
  const first = node.children[0];

  return first?.type === "element" && first.tag === "h2"
    ? node.children.slice(1)
    : node.children;
}

/** Repair only headings proven to come from the sealed document. Keep edits,
 * element IDs, and every historical JSON snapshot intact. */
export function repairImportedSectionHeadings(
  current: Block[],
  sealed: ReviewDocumentData,
): Block[] | undefined {
  const headings = new Map<string, Set<string>>();
  const footnotes = collectFootnoteDefinitions(sealed.body);

  const visit = (nodes: ReviewNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") continue;

      if (node.type === "component" && node.name === "ReviewSection") {
        const first = node.children[0];

        if (first?.type === "element" && first.tag === "h2") {
          const heading = proseToMarkdown([first], footnotes, []).trim();
          const matches = headings.get(node.props.title) ?? new Set<string>();
          matches.add(heading);
          headings.set(node.props.title, matches);
        }
      }

      visit(node.children);
    }
  };

  visit(sealed.body);
  const document = structuredClone(current);
  let changed = false;

  for (const block of elements(document)) {
    if (block.type !== "section") continue;
    const first = block.children[0];

    if (first?.type !== "markdown") continue;

    for (const heading of headings.get(block.title) ?? []) {
      if (first.markdown.trimEnd() === heading) {
        block.children.shift();
        changed = true;
        break;
      }

      if (first.markdown.startsWith(`${heading}\n\n`)) {
        first.markdown = first.markdown.slice(heading.length + 2);
        changed = true;
        break;
      }
    }
  }

  return changed ? document : undefined;
}
