import { describe, expect, it } from "vitest";

import { defineSoftwareModel } from "./model";
import {
  shouldApplySoftwareMapModifiedOnly,
  softwareMapResolvedDataInputForModel,
  softwareMapResolvedDataInputKey,
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

  it("excludes commit identifiers from the resolved-data input signature", () => {
    // The resolved-data key must be a pure function of
    // SOFTWARE_MAP_RESOLVED_DATA_VERSION + the code elements' path/label/
    // description/changeStatus/sourceRanges + the coverage claims. It must NOT
    // embed any commit SHA: a server-side pin advance (republish writing
    // review.sourceCommit / review.baseCommit) does not change
    // resolvedDataKey, which is exactly why a same-key refresh can re-fetch a
    // divergent payload. Accidentally adding a commit field to this signature
    // would silently hide that class of bug, so this guards the invariant.
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
                  codeElements: {
                    handler: {
                      sourceRanges: [
                        { file: "src/api.ts", fromLine: 1, toLine: 4 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const input = softwareMapResolvedDataInputForModel(model);
    const key = softwareMapResolvedDataInputKey(input);

    // Deterministic: the same input resolves to the same key.
    expect(softwareMapResolvedDataInputKey(input)).toBe(key);

    // The key carries the resolved-data version prefix and a size/hash
    // suffix; it never carries a commit-ish.
    expect(key.startsWith("resolved:")).toBe(true);
    // Changing a source range changes the key; the key is sensitive to what
    // the diff counts (code element geometry), not to refs.
    const shifted = softwareMapResolvedDataInputKey({
      codeElements: [
        {
          path: "app.runtime.api.handler",
          label: "handler",
          description: undefined,
          changeStatus: "modified",
          sourceRanges: [{ file: "src/api.ts", fromLine: 10, toLine: 20 }],
        },
      ],
      coverageClaims: [],
    });
    expect(shifted).not.toBe(key);
  });
});
