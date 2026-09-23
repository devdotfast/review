import { describe, expect, it } from "vitest";

import { scopeWhiteboardCanvasCss } from "./desktop-css-scope";

describe("scopeWhiteboardCanvasCss", () => {
  it("maps canvas-root declarations onto the @scope root", () => {
    const output = scopeWhiteboardCanvasCss(
      [
        ".whiteboard-canvas-root { --accent: #7cf5b0; }",
        ".whiteboard-canvas-root{ height: 100%; }",
        ".whiteboard-app { color: var(--accent); }",
      ].join("\n"),
    );

    expect(output).toContain("@scope (.whiteboard-canvas-root)");
    expect(output).toContain(":scope{ --accent: #7cf5b0; }");
    expect(output).toContain(":scope{ height: 100%; }");
    expect(output).not.toContain(
      ".whiteboard-canvas-root { --accent: #7cf5b0; }",
    );
    expect(output).toContain(".whiteboard-app { color: var(--accent); }");
  });

  it("lifts @font-face rules out of the scope so the whole document can use them", () => {
    const face =
      '@font-face { font-family: "Geist Mono"; src: url(./geist.woff2) format("woff2"); }';

    const output = scopeWhiteboardCanvasCss(
      [face, '.whiteboard-app { font-family: "Geist Mono"; }'].join("\n"),
    );

    const scopeStart = output.indexOf("@scope (.whiteboard-canvas-root)");
    expect(output.indexOf(face)).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(face)).toBeLessThan(scopeStart);
    expect(output.slice(scopeStart)).not.toContain("@font-face");
    expect(output.slice(scopeStart)).toContain(".whiteboard-app");
  });
});
