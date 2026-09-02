import type { CompileOptions } from "@mdx-js/mdx";
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
