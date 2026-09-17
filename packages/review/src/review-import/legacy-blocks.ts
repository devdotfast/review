import type { Block } from "../review-api/document";
import type {
  ReviewComponentNode,
  ReviewDocumentData,
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

export interface LegacyConversion {
  blocks: Block[];
  traces: TraceRequest[];
  warnings: string[];
}

function viewLabel(view: "review" | "commits" | "diff" | "map"): string {
  switch (view) {
    case "review":
      return "Review";
    case "commits":
      return "Commits";
    case "diff":
      return "Files";
    case "map":
      return "Map";
  }
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

  const render: RenderProseNode = (node) => {
    if (node.name !== "TraceQuote") return undefined;

    const quote = traceQuote(node);
    const label = quote.text.replace(/([\\`*_[\]<>])/g, "\\$1");

    return `[${label}](review-trace:${quote.traceId}#${quote.eventId})`;
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

    for (const node of hoistDiagrams(nodes, warnings)) {
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
            children: convert(node.children),
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
            type: "markdown",
            markdown: `Open the **${viewLabel(node.props.view)}** tab.\n`,
          });
          break;
        case "TutorialFeature":
        case "TutorialKeymapPicker":
        case "TutorialAuthoringConversation":
          warnings.push(
            `${node.name} has no JSON block; rendered as a callout.`,
          );
          out.push({
            type: "callout",
            tone: "info",
            title: "Tutorial",
            children: [
              {
                type: "markdown",
                markdown: `This step used the interactive ${node.name} component.\n`,
              },
            ],
          });
          break;
        default:
          warnings.push(`Dropped ${node.name} outside its parent.`);
      }
    }

    flush();

    return out;
  };

  return { blocks: convert(document.body), traces, warnings };
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

const DIAGRAM_NAMES = new Set([
  "CallStackDiff",
  "SequenceDiagram",
  "DatabaseLens",
]);

/** `nodes` with the diagrams nested in prose lifted out, each emitted right
 * after the prose node that held it: Markdown cannot carry a diagram. Footnote
 * sections are dropped, their definitions having been collected already, so a
 * diagram inside a definition stays where it is. */
function hoistDiagrams(
  nodes: ReviewNode[],
  warnings: string[],
): Array<ReviewNode | Block> {
  const out: Array<ReviewNode | Block> = [];

  for (const node of nodes) {
    if (!isProseNode(node)) {
      out.push(node);
      continue;
    }

    if (isFootnoteSection(node)) continue;

    const hoisted: Block[] = [];

    out.push(withoutDiagrams(node, hoisted, warnings), ...hoisted);
  }

  return out;
}

function withoutDiagrams(
  node: ReviewNode,
  hoisted: Block[],
  warnings: string[],
): ReviewNode {
  if (node.type === "text") return node;

  const children = node.children.flatMap((child): ReviewNode[] => {
    if (child.type === "component" && DIAGRAM_NAMES.has(child.name)) {
      const diagram = diagramBlock(child);

      if (diagram) {
        hoisted.push(diagram);
        warnings.push(`${child.name} was moved after the enclosing prose`);

        return [];
      }
    }

    return [withoutDiagrams(child, hoisted, warnings)];
  });

  return { ...node, children };
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
