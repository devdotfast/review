import { describe, expect, it } from "vitest";

import { hydratePublishedSoftwareMap } from "./hydrate-published-software-map";

describe("hydratePublishedSoftwareMap", () => {
  it.each([undefined, "software-map/1"])(
    "rebuilds indexes from model data with format %s",
    (format) => {
      const headElement = {
        type: "softwareSystem",
        id: "orders",
        path: "orders",
        label: "Orders",
        children: [],
      };
      const baseElement = {
        type: "container",
        id: "api",
        path: "orders.api",
        parentPath: "orders",
        label: "API",
        children: [],
      };
      const maps = hydratePublishedSoftwareMap({
        head: {
          format,
          elements: [headElement],
          relationships: [],
        },
        base: {
          format,
          elements: [baseElement],
          relationships: [],
        },
      });

      expect(maps.head.elementsByPath).toBeInstanceOf(Map);
      expect(maps.base.elementsByPath).toBeInstanceOf(Map);
      expect(maps.head.elementsByPath.get("orders")).toEqual(headElement);
      expect(maps.base.elementsByPath.get("orders.api")).toEqual(baseElement);
    },
  );

  it("rejects an unsupported published map format", () => {
    const data = { format: "software-map/2", elements: [], relationships: [] };
    expect(() =>
      hydratePublishedSoftwareMap({ head: data, base: data }),
    ).toThrow(/software-map\/1/);
  });
});
