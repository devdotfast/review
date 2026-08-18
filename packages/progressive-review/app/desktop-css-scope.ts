const REVIEW_CANVAS_SCOPE = ".review-canvas-root";
const REVIEW_CANVAS_ROOT_RULE = /\.review-canvas-root\s*\{/g;

export function scopeReviewCanvasCss(source: string): string {
  const scopedSource = source.replace(REVIEW_CANVAS_ROOT_RULE, ":scope{");
  return `@scope (${REVIEW_CANVAS_SCOPE}) {\n${scopedSource}\n}\n`;
}
