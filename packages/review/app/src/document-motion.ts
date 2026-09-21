import type { StoredBlock } from "./blocks";

/**
 * What a document version did to one block, seen from the version before it.
 * Sections are only ever new or removed: their children are diffed as their
 * own list, and a title edit alone is not worth an erasure.
 */
export type BlockChange = "unchanged" | "new" | "replaced";

export type DocumentEntry =
  | {
      kind: "block";
      key: string;
      block: StoredBlock;
      change: BlockChange;
      /** The version before, when the block was rewritten in place. */
      previous?: StoredBlock;
    }
  /** A block the latest version removed; it stays one version so it can be erased. */
  | { kind: "ghost"; key: string; block: StoredBlock }
  /** The slot at the end of a section the agent is still writing; a slot no
   * longer awaited stays one more version, closed, so it can shrink away. */
  | { kind: "slot"; key: string; open: boolean };

const slotKey = (serial: number) => `slot:${serial}`;

const slotSerial = (key: string) => Number(key.slice("slot:".length));

function contentKey(block: StoredBlock): string {
  if (block.type === "section") return "section";

  return JSON.stringify({ ...block, id: undefined });
}

/**
 * Classify one list of blocks against the entries rendered for the version
 * before. Ghosts from the earlier version are dropped, removed blocks become
 * ghosts placed after their nearest surviving predecessor, and a block
 * appended at the end claims the waiting slot's key so it lands in the slot
 * that promised it. `awaiting` keeps (or opens) a trailing slot; a slot that
 * stops being awaited stays one more version so it can close.
 */
export function diffBlockRevisions(
  previous: readonly DocumentEntry[] | undefined,
  blocks: readonly StoredBlock[],
  awaiting: boolean,
): DocumentEntry[] {
  if (!previous)
    return [
      ...blocks.map(
        (block): DocumentEntry => ({
          kind: "block",
          key: block.id,
          block,
          change: "unchanged",
        }),
      ),
      ...(awaiting
        ? [{ kind: "slot" as const, key: slotKey(0), open: true }]
        : []),
    ];

  const before = previous.filter((entry) => entry.kind === "block");
  const ids = new Set(blocks.map((block) => block.id));
  const known = new Map(before.map((entry) => [entry.block.id, entry]));

  const previousSlot = previous.find(
    (entry): entry is Extract<DocumentEntry, { kind: "slot" }> =>
      entry.kind === "slot" && entry.open,
  );

  // Removed blocks anchor to the last block before them that survived.
  const ghostsAfter = new Map<string | null, DocumentEntry[]>();
  let anchor: string | null = null;

  for (const entry of before) {
    if (ids.has(entry.block.id)) {
      anchor = entry.block.id;
      continue;
    }

    const ghosts = ghostsAfter.get(anchor) ?? [];
    ghosts.push({ kind: "ghost", key: entry.key, block: entry.block });
    ghostsAfter.set(anchor, ghosts);
  }

  let appendedFrom = 0;

  for (const entry of before)
    if (ids.has(entry.block.id))
      appendedFrom =
        blocks.findIndex((block) => block.id === entry.block.id) + 1;

  let claimedSlot = false;
  const entries: DocumentEntry[] = [...(ghostsAfter.get(null) ?? [])];

  blocks.forEach((block, index) => {
    const was = known.get(block.id);

    if (was) {
      const replaced = contentKey(was.block) !== contentKey(block);

      entries.push({
        kind: "block",
        key: was.key,
        block,
        change: replaced ? "replaced" : "unchanged",
        previous: replaced ? was.block : undefined,
      });
    } else {
      const claims = previousSlot && !claimedSlot && index >= appendedFrom;

      if (claims) claimedSlot = true;

      entries.push({
        kind: "block",
        key: claims ? previousSlot.key : block.id,
        block,
        change: "new",
      });
    }

    entries.push(...(ghostsAfter.get(block.id) ?? []));
  });

  if (awaiting)
    entries.push({
      kind: "slot",
      key:
        previousSlot && !claimedSlot
          ? previousSlot.key
          : slotKey(previousSlot ? slotSerial(previousSlot.key) + 1 : 0),
      open: true,
    });
  else if (previousSlot && !claimedSlot)
    entries.push({ ...previousSlot, open: false });

  return entries;
}
