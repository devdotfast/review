import type { Program } from "estree";
import type { Link, Nodes, Root } from "mdast";

import type { SourceSpan } from "./syntax";

declare module "mdast-util-mdx-jsx" {
  interface MdxJsxAttributeValueExpressionData {
    /** The authored link destination represented by a synthesized expression. */
    reviewSourceSpan?: SourceSpan;
  }
}

const ANCHOR_LINK = /^anchors\.([A-Za-z_$][A-Za-z0-9_$]*)$/;

interface ParentNode {
  type: string;
  children?: Nodes[];
}

interface VFileLike {
  fail(message: string, node?: Nodes): never;
  toString(): string;
}

/** Compile Markdown `[label](anchors.key)` into a typed AnchorLink. */
export function remarkReviewAnchorLinks() {
  return (tree: Root, file: VFileLike) => {
    rewriteChildren(tree, file);
  };
}

function rewriteChildren(parent: ParentNode, file: VFileLike): void {
  if (!parent.children) return;
  for (const [index, child] of parent.children.entries()) {
    if (child.type === "link") {
      const link = child;
      if (link.url.startsWith("anchors.")) {
        const match = ANCHOR_LINK.exec(link.url);
        if (!match) {
          file.fail(
            `Review anchor links must use [label](anchors.key); received ${link.url}.`,
            link,
          );
        }
        const expression = `anchors.${match[1]}`;
        parent.children[index] = {
          type: "mdxJsxTextElement",
          name: "AnchorLink",
          attributes: [
            {
              type: "mdxJsxAttribute",
              name: "anchor",
              value: {
                type: "mdxJsxAttributeValueExpression",
                value: expression,
                data: {
                  estree: anchorExpressionProgram(match[1]),
                  reviewSourceSpan: anchorDestinationSpan(
                    link,
                    file.toString(),
                  ),
                },
              },
            },
          ],
          children: link.children,
          position: link.position,
        };
        continue;
      }
    }
    rewriteChildren(child, file);
  }
}

function anchorDestinationSpan(link: Link, source: string): SourceSpan {
  const start = link.position?.start.offset;
  const end = link.position?.end.offset;
  if (start === undefined || end === undefined)
    throw new Error("Missing source position for Review anchor link");
  const labelEnd = link.children.at(-1)?.position?.end.offset ?? start + 1;
  const destination = /\]\(\s*<?/.exec(source.slice(labelEnd, end));
  if (!destination)
    throw new Error("Missing source destination for Review anchor link");
  const destinationStart = labelEnd + destination.index + destination[0].length;
  return { start: destinationStart, end: destinationStart + link.url.length };
}

function anchorExpressionProgram(property: string): Program {
  return {
    type: "Program",
    sourceType: "module",
    body: [
      {
        type: "ExpressionStatement",
        expression: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "anchors" },
          property: { type: "Identifier", name: property },
          computed: false,
          optional: false,
        },
      },
    ],
  };
}
