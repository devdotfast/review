import { describe, expect, it } from "vitest";

import { hydratePublishedSoftwareMap } from "./hydrate-published-software-map";

describe("hydratePublishedSoftwareMap", () => {
  it("rebuilds the head and base elementsByPath indexes", () => {
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
        elements: [headElement],
        relationships: [],
      },
      base: {
        elements: [baseElement],
        relationships: [],
      },
    });

    expect(maps.head.elementsByPath).toBeInstanceOf(Map);
    expect(maps.base.elementsByPath).toBeInstanceOf(Map);
    expect(maps.head.elementsByPath.get("orders")).toEqual(headElement);
    expect(maps.base.elementsByPath.get("orders.api")).toEqual(baseElement);
  });
});
