import { describe, expect, it } from "vitest";

import {
  diffrConfigDefaultText,
  diffrConfigFields,
  diffrConfigInputValue,
} from "./diffr-config-form";

const schema = {
  type: "object",
  properties: {
    summarize: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["gemini"],
          default: "gemini",
          description: "Model provider used for fold summaries.",
        },
        api_key: {
          type: ["string", "null"],
          description: "API key for the provider.",
        },
      },
    },
    folds: { $ref: "#/$defs/Folds" },
    languages: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Per-language query overrides.",
    },
  },
  $defs: {
    Folds: {
      type: "object",
      properties: {
        min_lines: {
          type: "integer",
          default: 12,
          description: "Bodies shorter than this are never summarized.",
        },
        collapse_deleted: { type: "boolean", default: true },
      },
    },
  },
};

describe("diffrConfigFields", () => {
  it("flattens nested objects and $refs into dotted keys with current values", () => {
    const fields = diffrConfigFields(schema, {
      summarize: { provider: "gemini" },
      folds: { min_lines: 20, collapse_deleted: false },
    });

    expect(fields.map((field) => [field.key, field.kind, field.value])).toEqual(
      [
        ["summarize.provider", "enum", "gemini"],
        ["summarize.api_key", "string", undefined],
        ["folds.min_lines", "number", 20],
        ["folds.collapse_deleted", "boolean", false],
      ],
    );
    expect(fields[0].choices).toEqual(["gemini"]);
    expect(fields[2].description).toBe(
      "Bodies shorter than this are never summarized.",
    );
  });

  it("marks credential keys as secret and hides their defaults", () => {
    const fields = diffrConfigFields(schema, {});
    const key = fields.find((field) => field.key === "summarize.api_key");
    expect(key?.secret).toBe(true);
    expect(diffrConfigDefaultText(fields[2])).toBe("12");
    expect(diffrConfigDefaultText(key!)).toBe("");
  });

  it("refuses to guess at an unknown definition", () => {
    expect(() =>
      diffrConfigFields({ properties: { x: { $ref: "#/$defs/Missing" } } }, {}),
    ).toThrow("unknown definition");
  });
});

describe("diffrConfigInputValue", () => {
  it("parses numbers and rejects blanks", () => {
    const field = diffrConfigFields(schema, {})[2];
    expect(diffrConfigInputValue(field, "8")).toBe(8);
    expect(() => diffrConfigInputValue(field, "")).toThrow("must be a number");
  });
});

describe("current diffr plugin schema", () => {
  it("uses setting titles and groups and omits fields marked non-editable", () => {
    const fields = diffrConfigFields(
      {
        properties: {
          plugins: {
            properties: {
              "deleted-bodies": {
                properties: {
                  min_lines: {
                    type: "integer",
                    title: "Shortest body to collapse",
                    "x-group": "Deleted function bodies",
                    default: 12,
                  },
                },
              },
              summarize: {
                properties: {
                  system_prompt: { type: "string", "x-settings": false },
                },
              },
            },
          },
        },
      },
      { plugins: { "deleted-bodies": { min_lines: 20 } } },
    );

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: "plugins.deleted-bodies.min_lines",
      label: "Shortest body to collapse",
      group: "Deleted function bodies",
      value: 20,
    });
  });
});
