const WHITEBOARD_CANVAS_SCOPE = ".whiteboard-canvas-root";

const WHITEBOARD_CANVAS_ROOT_RULE = /\.whiteboard-canvas-root\s*\{/g;

// `@font-face` is not valid inside `@scope`, and the faces must be visible to
// the whole document anyway: the workbench chrome (tab pills, the changed-files
// tree) sets the same families as the canvas. Lift every face out of the
// scoped block and emit it first.
const FONT_FACE_RULE = /@font-face\s*\{[^}]*\}/g;

export function scopeWhiteboardCanvasCss(source: string): string {
  const fontFaces = source.match(FONT_FACE_RULE) ?? [];
  const withoutFontFaces = source.replace(FONT_FACE_RULE, "");

  const scopedSource = withoutFontFaces.replace(
    WHITEBOARD_CANVAS_ROOT_RULE,
    ":scope{",
  );

  const fontFaceBlock = fontFaces.length ? `${fontFaces.join("\n")}\n` : "";

  return `${fontFaceBlock}@scope (${WHITEBOARD_CANVAS_SCOPE}) {\n${scopedSource}\n}\n`;
}
