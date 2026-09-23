---
name: dev-file-lenses
description: Write Diff-view file lenses for an existing review.
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit. Review automatically replaces this skill directory on updates."
  review-version: "development"
---

you are grouping a code review's changed files into file lenses for the Diff view.

**input:** a review id.

**flow**
- begin `review_activity` with `scope: "lenses"` before writing, end it when done.
- run `review_diff` with `format: "files"`to get an overview of the files involved
- categorize all the changes into buckets - leaving nothing in uncategorized changes by the end
    - first, categorize away non-implementation code:  tests, docs, generated files and lockfiles, config and build, fixtures and snapshots, pure renames and moves, formatting-only changes, imports — all might be reasonable.
    - then, when left with only implementation code, split it by the part of the design each file serves (e.g. the data model, an API, a UI surface), in the order a reader should take them. keep each lens small enough to read in one sitting, and don't split a file across lenses unless it holds two unrelated changes.

**guidelines**
- you can call `review_diff` with `format: "patch"`with `paths` to view any diffs of files whose contents matter for bucketing. otherwise, rely on the initial file listing.
