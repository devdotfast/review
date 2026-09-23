import fs from "node:fs";
import path from "node:path";

import { currentHead, resolveRevision } from "@dev.fast/local-vcs";
import { parseJsonText } from "@dev.fast/whiteboard-protocol";

import { type WhiteboardCheckoutRole } from "./whiteboard-checkout-paths";
import { ensureWhiteboardPinnedCheckout } from "./whiteboard-head-checkout";
import {
  type StoredWhiteboardRecord,
  safeParseStoredWhiteboardRecord,
} from "./whiteboard-home";

export interface PreparedWhiteboardSourceTarget {
  ref: string;
  sourceRootPath: string;
}

export interface WhiteboardSourceTarget {
  repoRoot: string;
  headRef?: string;
  baseRef?: string;
  sourceRootPath: string;
  diffRootPath: string;
  preparedBase?: PreparedWhiteboardSourceTarget;
}

export async function resolveWhiteboardSourceTarget(input: {
  whiteboardRootPath: string;
}): Promise<WhiteboardSourceTarget> {
  const review = readWhiteboardStoreRecord(input.whiteboardRootPath);

  const repoRoot = resolveWhiteboardRepoRootFromStore(
    input.whiteboardRootPath,
    review,
  );

  const headRef = review.sourceCommit
    ? await resolveRevisionCommit(repoRoot, review.sourceCommit)
    : await resolveDefaultWhiteboardHeadRef(repoRoot);

  const baseRef = review.baseCommit;

  if (!headRef) {
    return {
      repoRoot,
      sourceRootPath: repoRoot,
      diffRootPath: repoRoot,
      baseRef,
    };
  }

  const sourceRootPath = await ensurePinnedWhiteboardWorktreeAtCommit({
    repoRoot,
    commit: headRef,
    sessionId: review.uuid,
    role: "head",
  });

  const preparedBase =
    baseRef && baseRef !== headRef
      ? await preparedBaseTarget(repoRoot, review.uuid, baseRef)
      : baseRef === headRef
        ? { ref: headRef, sourceRootPath }
        : undefined;

  return {
    repoRoot,
    headRef,
    baseRef,
    sourceRootPath,
    diffRootPath: repoRoot,
    preparedBase,
  };
}

async function preparedBaseTarget(
  repoRoot: string,
  sessionId: string,
  baseRef: string,
): Promise<PreparedWhiteboardSourceTarget> {
  const ref = await resolveRevisionCommit(repoRoot, baseRef);

  return {
    ref,
    sourceRootPath: await ensurePinnedWhiteboardWorktreeAtCommit({
      repoRoot,
      commit: ref,
      sessionId,
      role: "base",
    }),
  };
}

async function ensurePinnedWhiteboardWorktreeAtCommit(input: {
  repoRoot: string;
  commit: string;
  sessionId: string;
  role: WhiteboardCheckoutRole;
}): Promise<string> {
  const sourceRootPath = await ensureWhiteboardPinnedCheckout({
    rootPath: input.repoRoot,
    ref: input.commit,
    sessionId: input.sessionId,
    role: input.role,
  });

  if (!sourceRootPath) {
    throw new Error(
      `Cannot materialize a pinned worktree for ${input.commit} in ${input.repoRoot}.`,
    );
  }

  return sourceRootPath;
}

async function resolveDefaultWhiteboardHeadRef(
  repoRoot: string,
): Promise<string | undefined> {
  return currentHead(repoRoot).then((head) => head?.commit);
}

export async function resolveWhiteboardSessionBaseCommit(input: {
  whiteboardRootPath: string;
}): Promise<string | null> {
  const review = readWhiteboardStoreRecord(input.whiteboardRootPath);

  const repoRoot = resolveWhiteboardRepoRootFromStore(
    input.whiteboardRootPath,
    review,
  );

  return resolveRevisionCommit(repoRoot, review.baseCommit);
}

export function resolveWhiteboardRepoRootFromStore(
  whiteboardRootPath: string,
  review = readWhiteboardStoreRecord(whiteboardRootPath),
): string {
  const worktreePath = review.worktreePath;
  const resolvedWorktreePath = path.resolve(worktreePath);

  if (!fs.existsSync(resolvedWorktreePath)) {
    throw new Error(
      `Review worktree ${resolvedWorktreePath} no longer exists.`,
    );
  }

  return resolvedWorktreePath;
}

export function readWhiteboardStoreRecord(
  whiteboardRootPath: string,
): StoredWhiteboardRecord {
  const storePath = path.resolve(whiteboardRootPath);

  try {
    const value = parseJsonText(
      fs.readFileSync(path.join(storePath, "review.json"), "utf8"),
    );

    const parsed = safeParseStoredWhiteboardRecord(value);

    if (!parsed.success) throw parsed.error;

    return parsed.data;
  } catch {
    throw new Error(`Review store ${storePath} has no readable review.json.`);
  }
}

async function resolveRevisionCommit(
  repoRoot: string,
  commit: string,
): Promise<string> {
  const resolved = await resolveRevision(repoRoot, commit);

  if (!resolved) throw new Error(`Revision does not exist: ${commit}`);

  return resolved.commit;
}
