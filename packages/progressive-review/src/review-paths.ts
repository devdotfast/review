import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const FLAT_REVIEW_SLUG_RE = /^[A-Za-z0-9._-]+$/;
const PR_REVIEW_FILE_RE = /^pr-(\d+)$/;
const PR_REVIEW_ROUTE_RE = /^\/pr\/(\d+)$/;

export function resolveReviewPath(
  reviewRootPath: string,
  value: string,
): string {
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(reviewRootPath, value);
}

export function toViteFsImport(filePath: string): string {
  return `/@fs/${path.resolve(filePath).split(path.sep).join("/")}`;
}

export function isInsideDirectory(
  filePath: string,
  directory: string,
): boolean {
  const relative = path.relative(directory, filePath);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function normalizeViteModuleFilePath(id: string): string {
  const withoutQuery = id.split("?")[0] ?? id;
  const fsPath = withoutQuery.startsWith("/@fs/")
    ? withoutQuery.slice("/@fs/".length)
    : withoutQuery;
  const resolved = path.resolve(fsPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    const missingSegments: string[] = [];
    let existingAncestor = resolved;
    while (
      existingAncestor !== path.dirname(existingAncestor) &&
      !existsSync(existingAncestor)
    ) {
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = path.dirname(existingAncestor);
    }
    try {
      return path.join(
        realpathSync.native(existingAncestor),
        ...missingSegments,
      );
    } catch {
      return resolved;
    }
  }
}

export function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

export function normalizeReviewRoutePath(value: string | null | undefined) {
  const pathnameOnly = String(value || "/").split(/[?#]/)[0] || "/";
  const trimmed = pathnameOnly.replace(/\/+$/, "") || "/";
  const route = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (route === "/") return "/";
  return route.endsWith(".mdx") ? route.slice(0, -".mdx".length) : route;
}

export function reviewDocumentRoutePathForFile(input: {
  reviewDocumentsDir: string;
  filePath: string;
}): string | null {
  const documentsDir = path.resolve(input.reviewDocumentsDir);
  const filePath = path.resolve(input.filePath);
  if (path.dirname(filePath) !== documentsDir) return null;
  if (path.extname(filePath) !== ".mdx") return null;

  const slug = path.basename(filePath, ".mdx");
  const prMatch = slug.match(PR_REVIEW_FILE_RE);
  if (prMatch) return `/pr/${prMatch[1]}`;
  return FLAT_REVIEW_SLUG_RE.test(slug) ? `/${slug}` : null;
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
