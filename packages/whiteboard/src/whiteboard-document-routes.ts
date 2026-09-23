import { existsSync } from "node:fs";
import path from "node:path";

const FLAT_WHITEBOARD_SLUG_RE = /^[A-Za-z0-9._-]+$/;

const PR_WHITEBOARD_ROUTE_RE = /^\/pr\/(\d+)$/;

export function normalizeWhiteboardRoutePath(value: string | null | undefined) {
  const pathnameOnly = String(value || "/").split(/[?#]/)[0] || "/";
  const trimmed = pathnameOnly.replace(/\/+$/, "") || "/";
  const route = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

  if (route === "/") return "/";

  return route.endsWith(".mdx") ? route.slice(0, -".mdx".length) : route;
}

export function resolveWhiteboardDocumentFilePath(input: {
  routePath: string | null | undefined;
  whiteboardPath: string;
  whiteboardDocumentsDir: string;
  mustExist?: boolean;
}): string | null {
  const routePath = normalizeWhiteboardRoutePath(input.routePath);

  if (routePath === "/") return path.resolve(input.whiteboardPath);

  const documentsDir = path.resolve(input.whiteboardDocumentsDir);
  const fileName = whiteboardDocumentFileNameForRoutePath(routePath);

  if (!fileName) return null;

  const candidate = path.resolve(documentsDir, fileName);

  if (path.dirname(candidate) !== documentsDir) return null;

  if (input.mustExist !== false && !existsSync(candidate)) return null;

  return candidate;
}

function whiteboardDocumentFileNameForRoutePath(
  routePath: string,
): string | null {
  const prMatch = routePath.match(PR_WHITEBOARD_ROUTE_RE);

  if (prMatch) return `pr-${prMatch[1]}.mdx`;

  const slug = routePath.slice(1);

  if (!FLAT_WHITEBOARD_SLUG_RE.test(slug)) return null;

  return `${slug}.mdx`;
}
