import { existsSync } from "node:fs";
import path from "node:path";

const FLAT_REVIEW_SLUG_RE = /^[A-Za-z0-9._-]+$/;

const PR_REVIEW_ROUTE_RE = /^\/pr\/(\d+)$/;

export function normalizeReviewRoutePath(value: string | null | undefined) {
  const pathnameOnly = String(value || "/").split(/[?#]/)[0] || "/";
  const trimmed = pathnameOnly.replace(/\/+$/, "") || "/";
  const route = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

  if (route === "/") return "/";

  return route.endsWith(".mdx") ? route.slice(0, -".mdx".length) : route;
}

export function resolveReviewDocumentFilePath(input: {
  routePath: string | null | undefined;
  reviewPath: string;
  reviewDocumentsDir: string;
  mustExist?: boolean;
}): string | null {
  const routePath = normalizeReviewRoutePath(input.routePath);

  if (routePath === "/") return path.resolve(input.reviewPath);

  const documentsDir = path.resolve(input.reviewDocumentsDir);
  const fileName = reviewDocumentFileNameForRoutePath(routePath);

  if (!fileName) return null;

  const candidate = path.resolve(documentsDir, fileName);

  if (path.dirname(candidate) !== documentsDir) return null;

  if (input.mustExist !== false && !existsSync(candidate)) return null;

  return candidate;
}

function reviewDocumentFileNameForRoutePath(routePath: string): string | null {
  const prMatch = routePath.match(PR_REVIEW_ROUTE_RE);

  if (prMatch) return `pr-${prMatch[1]}.mdx`;

  const slug = routePath.slice(1);

  if (!FLAT_REVIEW_SLUG_RE.test(slug)) return null;

  return `${slug}.mdx`;
}
