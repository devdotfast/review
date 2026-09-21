import { describe, expect, it } from "vitest";

import { scopeReviewCanvasCss } from "./desktop-css-scope";

describe("scopeReviewCanvasCss", () => {
  it("maps canvas-root declarations onto the @scope root", () => {
    const output = scopeReviewCanvasCss(
      [
        ".review-canvas-root { --accent: #7cf5b0; }",
        ".review-canvas-root{ height: 100%; }",
        ".review-app { color: var(--accent); }",
      ].join("\n"),
    );

    expect(output).toContain("@scope (.review-canvas-root)");
    expect(output).toContain(":scope{ --accent: #7cf5b0; }");
    expect(output).toContain(":scope{ height: 100%; }");
    expect(output).not.toContain(".review-canvas-root { --accent: #7cf5b0; }");
    expect(output).toContain(".review-app { color: var(--accent); }");
  });

  it("lifts @font-face rules out of the scope so the whole document can use them", () => {
    const face =
      '@font-face { font-family: "Geist Mono"; src: url(./geist.woff2) format("woff2"); }';
    const output = scopeReviewCanvasCss(
      [face, '.review-app { font-family: "Geist Mono"; }'].join("\n"),
    );

    const scopeStart = output.indexOf("@scope (.review-canvas-root)");
    expect(output.indexOf(face)).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(face)).toBeLessThan(scopeStart);
    expect(output.slice(scopeStart)).not.toContain("@font-face");
    expect(output.slice(scopeStart)).toContain(".review-app");
  });
});
