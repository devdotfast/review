import { describe, expect, it } from "vitest";

import {
  diffrConfigDefaultText,
  diffrConfigFields,
  diffrConfigInputValue,
} from "./diffr-config-form";

const schema = {
  type: "object",
  properties: {
    plugins: {
      properties: {
        bundled: {
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
            "deleted-bodies": { $ref: "#/$defs/Folds" },
          },
        },
      },
    },
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
        enabled: { type: "boolean", default: true },
      },
    },
  },
};

describe("diffrConfigFields", () => {
  it("flattens nested objects and $refs into dotted keys with current values", () => {
    const fields = diffrConfigFields(schema, {
      plugins: {
        bundled: {
          summarize: { provider: "gemini" },
          "deleted-bodies": { min_lines: 20, enabled: false },
        },
      },
    });

    expect(fields.map((field) => [field.key, field.kind, field.value])).toEqual(
      [
        ["plugins.bundled.summarize.provider", "enum", "gemini"],
        ["plugins.bundled.summarize.api_key", "string", undefined],
        ["plugins.bundled.deleted-bodies.min_lines", "number", 20],
        ["plugins.bundled.deleted-bodies.enabled", "boolean", false],
      ],
    );
    expect(fields[0].choices).toEqual(["gemini"]);
    expect(fields[2].description).toBe(
      "Bodies shorter than this are never summarized.",
    );
  });

  it("marks credential keys as secret and hides their defaults", () => {
    const fields = diffrConfigFields(schema, {});

    const key = fields.find(
      (field) => field.key === "plugins.bundled.summarize.api_key",
    );

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
  it("exposes bundled plugin and test-summary settings while hiding legacy options", () => {
    const fields = diffrConfigFields(
      {
        properties: {
          plugins: {
            properties: {
              bundled: {
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
                      tests: {
                        type: "boolean",
                        title: "Summarize tests",
                        default: true,
                      },
                      test_min_lines: {
                        type: "integer",
                        title: "Shortest test body to summarize (lines)",
                        default: 20,
                      },
                      max_concurrency: {
                        type: "integer",
                        "x-settings": false,
                        default: 16,
                      },
                      system_prompt: { type: "string", "x-settings": false },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        plugins: {
          bundled: {
            "deleted-bodies": { min_lines: 20 },
            summarize: { tests: false, test_min_lines: 30, max_concurrency: 8 },
          },
        },
      },
    );

    expect(
      fields.find(
        (field) => field.key === "plugins.bundled.deleted-bodies.min_lines",
      ),
    ).toMatchObject({
      label: "Shortest body to collapse",
      group: "Deleted function bodies",
      value: 20,
    });

    const tests = fields.find(
      (field) => field.key === "plugins.bundled.summarize.tests",
    )!;

    expect(tests).toMatchObject({
      kind: "boolean",
      value: false,
      default: true,
    });

    const threshold = fields.find(
      (field) => field.key === "plugins.bundled.summarize.test_min_lines",
    )!;

    expect(threshold).toMatchObject({ kind: "number", value: 30, default: 20 });
    expect(diffrConfigInputValue(threshold, "24")).toBe(24);
    expect(
      fields.some(
        (field) =>
          field.key.endsWith(".max_concurrency") ||
          field.key.endsWith(".system_prompt"),
      ),
    ).toBe(false);
  });
});
