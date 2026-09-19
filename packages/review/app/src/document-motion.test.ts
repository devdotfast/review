import { describe, expect, it } from "vitest";

import type { StoredBlock } from "./blocks";
import { diffBlockRevisions } from "./document-motion";

const text = (id: string, markdown: string): StoredBlock => ({
  id,
  type: "markdown",
  markdown,
});

const outline = (entries: ReturnType<typeof diffBlockRevisions>) =>
  entries.map((entry) =>
    entry.kind === "block"
      ? `${entry.change}:${entry.block.id}@${entry.key}`
      : entry.kind === "ghost"
        ? `ghost:${entry.block.id}`
        : `slot:${entry.open ? "open" : "closed"}@${entry.key}`,
  );

describe("diffBlockRevisions", () => {
  it("classifies new, rewritten and removed blocks against the version before", () => {
    const first = diffBlockRevisions(
      undefined,
      [text("a", "One."), text("b", "Two."), text("c", "Three.")],
      false,
    );

    expect(outline(first)).toEqual([
      "unchanged:a@a",
      "unchanged:b@b",
      "unchanged:c@c",
    ]);

    const second = diffBlockRevisions(
      first,
      [text("a", "One."), text("d", "Four."), text("c", "Three, again.")],
      false,
    );

    // The ghost keeps b's place, right after the block that was before it.
    expect(outline(second)).toEqual([
      "unchanged:a@a",
      "ghost:b",
      "new:d@d",
      "replaced:c@c",
    ]);

    expect(second[3]).toMatchObject({ previous: text("c", "Three.") });

    // The ghost is gone with the next version; nothing else changed.
    expect(
      outline(
        diffBlockRevisions(
          second,
          second.flatMap((entry) =>
            entry.kind === "block" ? [entry.block] : [],
          ),
          false,
        ),
      ),
    ).toEqual(["unchanged:a@a", "unchanged:d@d", "unchanged:c@c"]);
  });

  it("does not rewrite a section whose title changed", () => {
    const section = (title: string): StoredBlock => ({
      id: "s",
      type: "section",
      title,
      children: [],
    });

    const entries = diffBlockRevisions(
      diffBlockRevisions(undefined, [section("Before")], false),
      [section("After")],
      false,
    );

    expect(outline(entries)).toEqual(["unchanged:s@s"]);
  });

  it("lets a block appended while awaiting land in the waiting slot, then opens another", () => {
    const waiting = diffBlockRevisions(undefined, [text("a", "One.")], true);
    expect(outline(waiting)).toEqual(["unchanged:a@a", "slot:open@slot:0"]);

    const landed = diffBlockRevisions(
      waiting,
      [text("a", "One."), text("b", "Two."), text("c", "Three.")],
      true,
    );

    expect(outline(landed)).toEqual([
      "unchanged:a@a",
      "new:b@slot:0",
      "new:c@c",
      "slot:open@slot:1",
    ]);

    // A block inserted before existing content gets its own slot.
    const inserted = diffBlockRevisions(
      landed,
      [
        text("z", "Zero."),
        text("a", "One."),
        text("b", "Two."),
        text("c", "Three."),
      ],
      false,
    );

    expect(outline(inserted)).toEqual([
      "new:z@z",
      "unchanged:a@a",
      "unchanged:b@slot:0",
      "unchanged:c@c",
      "slot:closed@slot:1",
    ]);

    expect(
      outline(
        diffBlockRevisions(
          inserted,
          [
            text("z", "Zero."),
            text("a", "One."),
            text("b", "Two."),
            text("c", "Three."),
          ],
          false,
        ),
      ),
    ).not.toContain("slot:closed@slot:1");
  });
});
