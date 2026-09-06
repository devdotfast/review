import { describe, expect, it } from "vitest";

import { defineSoftwareMap } from "./software-map-model";
import {
  softwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";

const model = defineSoftwareMap({
  systems: {
    api: {
      label: "API",
      containers: {
        server: {
          label: "Server",
          components: {
            handler: { label: "Handler", coverage: { files: ["src/a.ts"] } },
          },
        },
      },
    },
  },
  relationships: [{ kind: "semantic", from: "api", to: "api.server" }],
});

describe("softwareModelDataSchema", () => {
  it("round-trips a normalized model through JSON", () => {
    const data = softwareModelData(model);
    expect(
      softwareModelDataSchema.parse(JSON.parse(JSON.stringify(data))),
    ).toEqual(data);
  });

  it("rejects an element that is missing required normalized fields", () => {
    const parsed = softwareModelDataSchema.safeParse({
      elements: [{ path: "api", label: "API" }],
      relationships: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a call relationship without its call-site index", () => {
    const parsed = softwareModelDataSchema.safeParse({
      elements: [],
      relationships: [{ id: "r", from: "a", to: "b", kind: "call" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an element carrying an unknown field", () => {
    const [element] = softwareModelData(model).elements;
    const parsed = softwareModelDataSchema.safeParse({
      elements: [{ ...element, madeUp: true }],
      relationships: [],
    });
    expect(parsed.success).toBe(false);
  });
});
