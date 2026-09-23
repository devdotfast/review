import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SoftwareMapTopologyUnavailable } from "./software-map-absence";
import { SoftwareMap } from "./SoftwareMap";

describe("software map absence surfaces", () => {
  it("renders a labeled remediation card instead of an empty diagram", () => {
    const html = renderToStaticMarkup(<SoftwareMap />);

    expect(html).toContain("No software map for this repo yet");
    expect(html).toContain("review map");
    expect(html).toContain("The rest of the document works without it");
  });

  it("names the missing base ref while preserving a head-only map", () => {
    const html = renderToStaticMarkup(
      <SoftwareMapTopologyUnavailable
        repoSoftwareMap={{
          elements: [],
          elementsByPath: new Map(),
          relationships: [],
        }}
        baseSoftwareMap={null}
        baseRef="base-ref"
        headRef="head-ref"
      />,
    );

    expect(html).toContain(
      "Structural diff unavailable: no software map at base base-ref.",
    );
    expect(html).not.toContain("head head-ref");
  });

  it("renders no topology notice when both maps exist", () => {
    const map = {
      elements: [],
      elementsByPath: new Map(),
      relationships: [],
    };

    expect(
      renderToStaticMarkup(
        <SoftwareMapTopologyUnavailable
          repoSoftwareMap={map}
          baseSoftwareMap={map}
          baseRef="base-ref"
          headRef="head-ref"
        />,
      ),
    ).toBe("");
  });
});
