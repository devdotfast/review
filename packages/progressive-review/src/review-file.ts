import path from "node:path";

import { reviewRepoStorageRoot } from "./review-storage";

export function reviewDir(rootPath: string): string {
  return path.join(reviewDocumentsDir(rootPath), "current");
}

export function reviewDocumentsDir(rootPath: string): string {
  return path.join(reviewRepoStorageRoot(rootPath), "reviews");
}

export function reviewMdxPath(rootPath: string): string {
  return path.join(reviewDir(rootPath), "review.mdx");
}
