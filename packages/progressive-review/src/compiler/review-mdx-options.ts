import { type CompileOptions, compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import { rehypeReviewTargets } from "./rehype-review-targets";
import { remarkReviewAnchorLinks } from "./remark-review-anchor-links";
import { remarkReviewSections } from "./remark-review-sections";

// Duplicate diagram labels are rejected at render time by the live-diagram
// registry (thread-target-model.tsx), which sees resolved label values — a
// compile-time MDX check could only see string literals.
export const reviewMdxOptions = {
  rehypePlugins: [rehypeReviewTargets],
  remarkPlugins: [
    remarkFrontmatter,
    remarkGfm,
    remarkReviewAnchorLinks,
    remarkReviewSections,
  ],
} satisfies CompileOptions;

const TABLE_SENTINEL = [
  "| State | Meaning |",
  "| --- | --- |",
  "| ready | renders as a table |",
].join("\n");

export async function compileReviewMdx(source: string): Promise<string> {
  return String(await compile(source, { ...reviewMdxOptions, jsx: true }));
}

export async function checkReviewMdxTableSupport(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    const compiled = await compileReviewMdx(TABLE_SENTINEL);
    if (
      !compiled.includes("table") ||
      !compiled.includes("thead") ||
      !compiled.includes("td")
    ) {
      return {
        ok: false,
        message:
          "GFM table sentinel did not compile to table output. Check reviewMdxOptions remarkPlugins.",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `GFM table sentinel failed to compile: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
