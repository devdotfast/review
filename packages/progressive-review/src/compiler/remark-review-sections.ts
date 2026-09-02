import type {
  BlockContent,
  DefinitionContent,
  Heading,
  Root,
  RootContent,
} from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement } from "mdast-util-mdx-jsx";

const COLLAPSED_MARKER = /\s*\[collapsed\]\s*$/i;

/**
 * Wraps every `##` heading and the content that follows it (up to the next
 * `##` heading) in a `<ReviewSection>` JSX element so the app can render
 * sections as collapsible units. A heading suffixed with `[collapsed]`
 * renders collapsed by default; the marker is stripped from the visible
 * title.
 *
 * ESM nodes (`export`/`import` statements) are never pulled inside a section:
 * they are hoisted to the document root while the open section stays open,
 * because MDX cannot compile ESM nested inside JSX.
 */
export function remarkReviewSections() {
  return (tree: Root) => {
    const next: RootContent[] = [];
    let section: MdxJsxFlowElement | null = null;

    const closeSection = () => {
      if (section) next.push(section);
      section = null;
    };

    for (const node of tree.children) {
      if (node.type === "heading" && node.depth <= 2) {
        closeSection();
        if (node.depth === 2) {
          section = sectionForHeading(node);
          continue;
        }
        next.push(node);
        continue;
      }
      if (node.type === "mdxjsEsm") {
        next.push(node);
        continue;
      }
      if (section) {
        // SAFETY: remark-parse only emits flow content as root children, and
        // ESM nodes are hoisted above; mdast types Root.children more loosely.
        section.children.push(node as BlockContent | DefinitionContent);
        continue;
      }
      next.push(node);
    }
    closeSection();
    tree.children = next;
  };
}

function sectionForHeading(heading: Heading): MdxJsxFlowElement {
  const collapsed = stripCollapsedMarker(heading);
  const attributes: MdxJsxAttribute[] = [
    { type: "mdxJsxAttribute", name: "title", value: headingText(heading) },
  ];
  if (collapsed) {
    attributes.push({ type: "mdxJsxAttribute", name: "defaultCollapsed" });
  }
  return {
    type: "mdxJsxFlowElement",
    name: "ReviewSection",
    attributes,
    children: [heading],
  };
}

function stripCollapsedMarker(heading: Heading): boolean {
  const lastText = [...heading.children]
    .reverse()
    .find((child) => child.type === "text");
  if (!lastText || !COLLAPSED_MARKER.test(lastText.value)) return false;
  lastText.value = lastText.value.replace(COLLAPSED_MARKER, "");
  return true;
}

function headingText(heading: Heading): string {
  return heading.children
    .map((child) =>
      child.type === "text" || child.type === "inlineCode" ? child.value : "",
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
