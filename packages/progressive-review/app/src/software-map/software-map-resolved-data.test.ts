import { describe, expect, it } from "vitest";

import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  shouldApplySoftwareMapModifiedOnly,
  softwareMapResolvedDataInputForModel,
} from "./software-map-resolved-data";
import { parseSoftwareMapResolvedDataResponse } from "./software-map-snapshot";

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

  it.each([
    { headRef: "a".repeat(40), visibleNodes: 1 },
    { headRef: "b".repeat(40), visibleNodes: 0 },
  ])(
    "preserves snapshot maps without disabling comparison filtering ($visibleNodes visible nodes)",
    ({ headRef, visibleNodes }) => {
      const model = defineSoftwareModel({ systems: { app: { label: "App" } } });
      const data = parseSoftwareMapResolvedDataResponse({
        ok: true,
        baseRef: "a".repeat(40),
        headRef,
        countsByElementPath: { app: { additions: 0, deletions: 0 } },
      });
      const projection = projectInlineC4({
        model,
        expandedNodeIds: new Set(),
        changedNodeIds: new Set(),
        modifiedOnly: shouldApplySoftwareMapModifiedOnly({
          showModifiedOnly: true,
          resolvedDataReady: true,
          resolvedDataInput: {
            savedMap: { id: "saved-map", commit: headRef },
            codeElements: [],
            coverageClaims: [],
          },
          hasSourceComparison: data.hasSourceComparison,
        }),
      });
      expect(projection.nodes).toHaveLength(visibleNodes);
    },
  );
});
