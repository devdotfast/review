import type { Block } from "../../src/session-api/document";
import { documentHeadings } from "../../src/session-api/document-headings";
import type { WhiteboardTocEntry } from "./whiteboard-document-headings";

/** A snapshot's heading slugs, resolved once for the renderer. */
export interface ApiHeadingIds {
  /** The slug of a section block, or of the nth h2/h3 of a markdown block. */
  get(blockId: string, index?: number): string | undefined;
  entries: WhiteboardTocEntry[];
}

export function apiHeadingIds(blocks: Block[]): ApiHeadingIds {
  const headings = documentHeadings(blocks);

  const slugs = new Map(
    headings.map((heading) => [
      headingKey(heading.block.id!, heading.index),
      heading.id,
    ]),
  );

  return {
    get: (blockId, index) => slugs.get(headingKey(blockId, index)),
    entries: headings,
  };
}

function headingKey(blockId: string, index?: number): string {
  return index === undefined ? blockId : `${blockId}:${index}`;
}
