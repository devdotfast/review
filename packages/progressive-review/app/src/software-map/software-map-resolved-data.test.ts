import { describe, expect, it } from "vitest";

import { defineSoftwareModel } from "./model";
import {
  shouldApplySoftwareMapModifiedOnly,
  softwareMapResolvedDataInputForModel,
} from "./software-map-resolved-data";

describe("SoftwareMap resolved-data inputs", () => {
  it("keeps resolved inputs independent of expanded components", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          label: "App",
          containers: {
            runtime: {
              label: "Runtime",
              components: {
                api: {
                  label: "API",
                  coverage: { globs: ["src/api/**"] },
                },
                ui: {
                  label: "UI",
                  coverage: { globs: ["src/ui/**"] },
                },
              },
            },
          },
        },
      },
    });

    const collapsed = softwareMapResolvedDataInputForModel(model);
    expect(collapsed.codeElements).toEqual([]);
    expect(collapsed.coverageClaims).toHaveLength(2);

    const expanded = softwareMapResolvedDataInputForModel(model, {
      expandedElementPaths: new Set(["app.runtime.api"]),
    });
    expect(expanded.codeElements).toEqual([]);
    expect(expanded.coverageClaims).toHaveLength(2);
  });

  it("keeps authored-only maps visible when modified-only debug filtering is enabled", () => {
    expect(
      shouldApplySoftwareMapModifiedOnly({
        showModifiedOnly: true,
        resolvedDataReady: true,
        resolvedDataInput: {
          codeElements: [],
          coverageClaims: [],
        },
      }),
    ).toBe(false);
  });
});
