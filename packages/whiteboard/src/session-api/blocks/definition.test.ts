import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SessionInputError } from "../input-error.js";
import {
  type BlockDefinition,
  defineBlock,
  label,
  requireKey,
} from "./definition.js";

describe("defineBlock", () => {
  const schema = defineBlock("note", { body: label });

  const note = {
    type: "note",
    schema,
    check(block: z.infer<typeof schema>) {
      if (block.body === "forbidden")
        throw new SessionInputError("Forbidden body.");
    },
  } satisfies BlockDefinition<z.infer<typeof schema>>;

  it("builds a strict block schema with an optional id and a literal type", () => {
    expect(note.type).toBe("note");
    expect(note.schema.parse({ type: "note", body: "hi" })).toEqual({
      type: "note",
      body: "hi",
    });
    expect(
      note.schema.parse({ id: "block-1", type: "note", body: "hi" }).id,
    ).toBe("block-1");
    expect(() =>
      note.schema.parse({ type: "note", body: "hi", extra: 1 }),
    ).toThrow(z.ZodError);
    expect(() => note.schema.parse({ type: "other", body: "hi" })).toThrow(
      z.ZodError,
    );
  });

  it("carries the check through", () => {
    expect(() => note.check({ type: "note", body: "forbidden" })).toThrow(
      "Forbidden body.",
    );
    expect(() => note.check({ type: "note", body: "fine" })).not.toThrow();
  });
});

describe("requireKey", () => {
  it("names the missing key the way checkReferences always has", () => {
    expect(() => requireKey({ a: 1 }, "b")).toThrow(
      new SessionInputError("Unknown component name: b"),
    );
    expect(() => requireKey({ a: 1 }, "a")).not.toThrow();
  });
});
