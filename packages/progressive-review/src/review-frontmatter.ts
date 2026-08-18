export interface ReviewFrontmatterParts {
  open: string;
  block: string;
  close: string;
  body: string;
}

export function splitReviewFrontmatter(
  source: string,
): ReviewFrontmatterParts | null {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return null;
  }
  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  const open = `---${newline}`;
  const closeStart = source.indexOf(`${newline}---${newline}`, open.length);
  if (closeStart === -1) return null;
  const close = `${newline}---${newline}`;
  return {
    open,
    block: source.slice(open.length, closeStart),
    close,
    body: source.slice(closeStart + close.length),
  };
}

export function stripReviewFrontmatter(source: string): string {
  const end = reviewFrontmatterEnd(source);
  return end === null ? source : source.slice(end);
}

/** Remove frontmatter content without shifting any authored source location. */
export function maskReviewFrontmatter(source: string): string {
  const end = reviewFrontmatterEnd(source);
  return end === null
    ? source
    : source.slice(0, end).replace(/[^\r\n]/g, " ") + source.slice(end);
}

function reviewFrontmatterEnd(source: string): number | null {
  const frontmatter = splitReviewFrontmatter(source);
  return frontmatter === null ? null : source.length - frontmatter.body.length;
}
