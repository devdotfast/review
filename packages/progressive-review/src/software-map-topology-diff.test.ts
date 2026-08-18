import { describe, expect, it } from "vitest";

import { defineSoftwareMap } from "./software-map-model";
import { diffSoftwareMaps } from "./software-map-topology-diff";

describe("diffSoftwareMaps", () => {
  it("reports added, removed, and modified elements and relationships", () => {
    const base = defineSoftwareMap({
      people: {
        developer: { label: "Developer" },
      },
      systems: {
        app: {
          label: "App",
          containers: {
            web: {
              label: "Web",
              components: {
                shell: {
                  label: "Shell",
                  coverage: { globs: ["apps/web/src/shell.ts"] },
                },
                oldPanel: { label: "Old panel" },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "developer",
          to: "app.web.shell",
          label: "uses",
        },
        {
          kind: "semantic",
          from: "app.web.shell",
          to: "app.web.oldPanel",
          label: "renders",
        },
      ],
    });

    const head = defineSoftwareMap({
      people: {
        developer: { label: "Developer" },
      },
      systems: {
        app: {
          label: "App",
          containers: {
            web: {
              label: "Web",
              components: {
                shell: {
                  label: "Shell",
                  coverage: { globs: ["apps/web/src/shell.tsx"] },
                },
                newPanel: { label: "New panel" },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "developer",
          to: "app.web.shell",
          label: "opens",
        },
        {
          kind: "semantic",
          from: "app.web.shell",
          to: "app.web.newPanel",
          label: "renders",
        },
      ],
    });

    const diff = diffSoftwareMaps(base, head);

    expect(diff?.counts).toEqual({
      addedElements: 1,
      removedElements: 1,
      modifiedElements: 1,
      addedRelationships: 1,
      removedRelationships: 1,
      modifiedRelationships: 1,
    });
    expect(
      diff?.elementChanges.map((change) => [change.status, change.path]),
    ).toEqual([
      ["added", "app.web.newPanel"],
      ["modified", "app.web.shell"],
      ["removed", "app.web.oldPanel"],
    ]);
    expect(diff?.relationshipChanges.map((change) => change.status)).toEqual([
      "added",
      "modified",
      "removed",
    ]);
    expect(diff?.elementStatusByPath).toEqual({
      "app.web.newPanel": "added",
      "app.web.shell": "modified",
    });
  });
});
