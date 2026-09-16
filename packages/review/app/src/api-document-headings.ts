import type { Block } from "../../src/review-api/document";
import { documentHeadings } from "../../src/review-api/document-headings";
import type { ReviewTocEntry } from "./review-document-headings";

/** The heading slugs of one document snapshot, for the renderer. */
export interface ApiHeadingIds {
  /** The slug of a section block, or of the h2/h3 at `index` among a markdown
   * block's root nodes. */
  get(blockId: string, index?: number): string | undefined;
  /** Whether a `#fragment` link names a heading of this document. */
  has(id: string): boolean;
}

export function apiDocumentHeadings(blocks: Block[]): ReviewTocEntry[] {
  return documentHeadings(blocks).map(({ id, text, level }) => ({
    id,
    text,
    level,
  }));
}

export function apiHeadingIds(blocks: Block[]): ApiHeadingIds {
  const headings = documentHeadings(blocks);

  const slugs = new Map(
    headings.map((heading) => [
      headingKey(heading.block.id!, heading.index),
      heading.id,
    ]),
  );

  const ids = new Set(headings.map((heading) => heading.id));

  return {
    get: (blockId, index) => slugs.get(headingKey(blockId, index)),
    has: (id) => ids.has(id),
  };
}

function headingKey(blockId: string, index?: number): string {
  return index === undefined ? blockId : `${blockId}:${index}`;
}
