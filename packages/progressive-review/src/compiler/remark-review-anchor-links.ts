import type { Link, Nodes, Root } from "mdast";

const ANCHOR_LINK = /^anchors\.([A-Za-z_$][A-Za-z0-9_$]*)$/;

interface ParentNode {
  children?: unknown[];
}

interface VFileLike {
  fail(message: string, node?: Nodes): never;
}

/** Compile Markdown `[label](anchors.key)` into a typed AnchorLink. */
export function remarkReviewAnchorLinks() {
  return (tree: Root, file: VFileLike) => {
    rewriteChildren(tree, file);
  };
}

function rewriteChildren(parent: ParentNode, file: VFileLike): void {
  if (!parent.children) return;
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index] as ParentNode & { type?: string };
    if (child.type === "link") {
      const link = child as Link;
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

function anchorExpressionProgram(property: string) {
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
