import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ReviewInputError, documentSchema } from "../document.js";
import {
  type BlockType,
  type Definitions,
  blocks,
  checkReferences,
} from "./index.js";

const fixturesDir = path.resolve(import.meta.dirname, "../../fixtures/blocks");

const goldensDir = path.resolve(
  import.meta.dirname,
  "../../fixtures/legacy-reviews",
);

async function fixture<T extends BlockType>(type: T) {
  const raw = JSON.parse(
    await readFile(path.join(fixturesDir, `${type}.json`), "utf8"),
  );

  const definition: Definitions[T] = blocks[type];

  return documentSchema
    .parse(raw)
    .map((block) => definition.schema.parse(block));
}

describe("block definitions", () => {
  it("has one fixture file per kind and one kind per fixture file", async () => {
    const files = (await readdir(fixturesDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();

    expect(files).toEqual(Object.keys(blocks).sort());
  });

  it.each(Object.keys(blocks) as BlockType[])(
    "%s fixtures parse and pass their check",
    async (type) => {
      for (const block of await fixture(type)) {
        expect(block.type).toBe(type);
        expect(() => checkReferences([block])).not.toThrow();
      }
    },
  );

  it("accepts the three real reviews", async () => {
    const goldens = (await readdir(goldensDir)).filter((f) =>
      f.endsWith(".expected-blocks.json"),
    );

    expect(goldens).toHaveLength(3);

    for (const name of goldens) {
      const document = documentSchema.parse(
        JSON.parse(await readFile(path.join(goldensDir, name), "utf8")),
      );

      expect(() => checkReferences(document)).not.toThrow();
    }
  });

  describe("check rules", () => {
    it("sequence: a step must name declared actors", async () => {
      const [sequence] = await fixture("sequence");

      const broken = {
        ...sequence!,
        steps: [{ ...sequence!.steps[0]!, to: "ghost" }],
      };

      expect(() => checkReferences([broken])).toThrow(
        new ReviewInputError("Unknown component name: ghost"),
      );
    });
    it("call_stack_diff: frame keys are unique per side", async () => {
      const [diff] = await fixture("call_stack_diff");

      const broken = {
        ...diff!,
        head: [diff!.head[0]!, { ...diff!.head[0]!, id: "frame-3" }],
      };

      expect(() => checkReferences([broken])).toThrow(
        new ReviewInputError("Frame keys must be unique within head."),
      );
    });
    it("call_stack_diff: a frame carries a source on its own side", async () => {
      const [diff] = await fixture("call_stack_diff");

      const broken = {
        ...diff!,
        base: [
          {
            ...diff!.base[0]!,
            source: { ...diff!.base[0]!.source, side: "head" as const },
          },
        ],
      };

      expect(() => checkReferences([broken])).toThrow(
        new ReviewInputError("A base frame needs base source."),
      );
    });
    it.each([
      ["actor", { actor: "nobody" }, "Unknown component name: nobody"],
      ["store", { store: "missing" }, "Unknown component name: missing"],
      [
        "collection",
        { collection: "missing" },
        "Unknown component name: missing",
      ],
      ["field", { field: "missing" }, "Unknown component name: missing"],
      [
        "dotted field",
        { field: "status.nested" },
        "Unknown component name: status.nested",
      ],
    ])(
      "database_lens: an operation must resolve its %s",
      async (_, patch, message) => {
        const [lens] = await fixture("database_lens");
        const useCase = lens!.useCases[0]!;

        const broken = {
          ...lens!,
          useCases: [
            {
              ...useCase,
              operations: [{ ...useCase.operations[0]!, ...patch }],
            },
          ],
        };

        expect(() => checkReferences([broken])).toThrow(
          new ReviewInputError(message),
        );
      },
    );
    it("database_lens: a foreign key must resolve", async () => {
      const [lens] = await fixture("database_lens");
      const orders = lens!.stores.orders!;

      const broken = {
        ...lens!,
        stores: {
          orders: {
            ...orders,
            collections: {
              orders: {
                ...orders.collections.orders!,
                fields: {
                  ...orders.collections.orders!.fields,
                  status: {
                    label: "status",
                    dataType: "text",
                    references: {
                      store: "orders",
                      collection: "orders",
                      field: "missing",
                    },
                  },
                },
              },
            },
          },
        },
      };

      expect(() => checkReferences([broken])).toThrow(
        new ReviewInputError("Unknown component name: missing"),
      );
    });
  });

  describe("lens minimum rules (the class the mount uniquely caught)", () => {
    it("rejects a lens with no stores", async () => {
      const [lens] = await fixture("database_lens");
      expect(() =>
        blocks.database_lens.schema.parse({ ...lens!, stores: {} }),
      ).toThrow(/at least one store/);
    });
    it("rejects a lens with no use cases", async () => {
      const [lens] = await fixture("database_lens");
      expect(() =>
        blocks.database_lens.schema.parse({ ...lens!, useCases: [] }),
      ).toThrow(/at least one use case/);
    });
    it("rejects a use case with no operations", async () => {
      const [lens] = await fixture("database_lens");
      expect(() =>
        blocks.database_lens.schema.parse({
          ...lens!,
          useCases: [{ ...lens!.useCases[0]!, operations: [] }],
        }),
      ).toThrow(/at least one operation/);
    });
  });
});
