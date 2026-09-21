import { describe, expect, it } from "vitest";

import {
  collectSoftwareMapConnectivityModel,
  collectSoftwareMapConnectivityWarnings,
} from "./software-map-connectivity-validation";

describe("software map connectivity validation", () => {
  it("warns about authored code elements without authored relationships", () => {
    const source = modelSource("");

    expect(collectSoftwareMapConnectivityWarnings(source)).toContain(
      'SoftwareMap connectivity: "product.web.ui" has 2 code element(s) with no relationship to any element outside themselves; they may be orphaned or under-connected.',
    );
  });

  it("accepts code elements joined by an authored relationship", () => {
    const source = modelSource(`
      relationships: [
        { from: "product.web.ui.render", to: "product.web.ui.load" },
      ],
    `);

    expect(collectSoftwareMapConnectivityWarnings(source)).toEqual([]);
  });

  it("extracts authored source ranges and coverage without decoration data", () => {
    const model = collectSoftwareMapConnectivityModel(modelSource(""));

    expect(
      model?.elements.find((element) => element.path.endsWith("render")),
    ).toMatchObject({ path: "product.web.ui.render", type: "codeElement" });
    expect(model?.coverageClaims).toEqual([
      {
        path: "product.web.ui",
        files: [{ path: "src/ui.ts", ranges: [] }],
        globs: [],
      },
    ]);
  });
});

function modelSource(extra: string): string {
  return `export const model = defineSoftwareModel({
    systems: {
      product: {
        containers: {
          web: {
            components: {
              ui: {
                coverage: { files: ["src/ui.ts"] },
                codeElements: {
                  render: {
                    sourceRanges: [
                      { file: "src/ui.ts", fromLine: 1, toLine: 8 },
                    ],
                  },
                  load: {
                    sourceRanges: [
                      { file: "src/ui.ts", fromLine: 10, toLine: 14 },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    ${extra}
  });`;
}
