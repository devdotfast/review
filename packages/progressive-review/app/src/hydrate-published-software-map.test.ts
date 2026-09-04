import { describe, expect, it } from "vitest";

import { hydratePublishedSoftwareMap } from "./hydrate-published-software-map";

describe("hydratePublishedSoftwareMap", () => {
  it("rebuilds the head and base elementsByPath indexes", () => {
    const maps = hydratePublishedSoftwareMap({
      head: {
        elements: [{ path: "orders" }],
        relationships: [],
      },
      base: {
        elements: [{ path: "orders.api" }],
        relationships: [],
      },
    });

    expect(maps.head.elementsByPath).toBeInstanceOf(Map);
    expect(maps.base.elementsByPath).toBeInstanceOf(Map);
    expect(maps.head.elementsByPath.get("orders")).toEqual({ path: "orders" });
    expect(maps.base.elementsByPath.get("orders.api")).toEqual({
      path: "orders.api",
    });
  });
});
