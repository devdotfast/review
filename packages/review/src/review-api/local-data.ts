import { execFile } from "node:child_process";
import { type FSWatcher, existsSync, watch } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  type BlobBatchReader,
  type LocalVcs,
  type LocalVcsCommitSummary,
  type LocalVcsDiffFileSummary,
  type LocalVcsKind,
  createBlobBatchReader,
  detectLocalVcs,
  diffFileSummariesTrees,
  diffFileSummariesWorkingTree,
  diffTrees,
  diffWorkingTree,
  gitCommonDir,
  listCommitRange,
  listTrackedFilesAtCommit,
  readFileAtCommit,
  splitGitPatchFiles,
} from "@dev.fast/local-vcs";
import { structuralChangeCounts } from "@dev.fast/review-protocol";
import type {
  ReviewLanguageEnvironment,
  ReviewSourceEntry,
  StructuralDiffEvent,
} from "@dev.fast/review-protocol";
import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

import { textIncludesQuote } from "../evidence.js";
import { isMissingFileError } from "../fs-utils.js";
import { reviewManagedCheckoutRoot } from "../review-checkout-paths.js";
import { ensureReviewPinnedCheckout } from "../review-head-checkout.js";
import { StructuralComparisons } from "../server/structural-comparisons.js";
import { resolveSoftwareMapDiffCounts } from "../software-map-diff-counts.js";
import {
  type NormalizedSoftwareModel,
  SoftwareModelValidationError,
  defineSoftwareMap,
} from "../software-map-model.js";
import {
  SourceRangeError,
  checkSourcePath,
  requireVisibleSource,
  sliceSourceRange,
} from "../source.js";
import {
  type ComparisonCoverage,
  type CoverageMode,
  comparisonCoverage,
} from "./comparison-coverage.js";
import { resourceReference } from "./document.js";
import {
  type Block,
  type FileLineRange,
  type Pins,
  ReviewInputError,
  type ReviewTarget,
  type SourcePins,
  anchorPins,
  elements,
  explicitPins,
  fileLineRangeSchema,
  pinsSchema,
  sourceReferences,
} from "./document.js";
import { decodeImage } from "./image-decode.js";
import { mapInputSchema } from "./map-input.js";
import { budgetPatches } from "./numbered-patch.js";
import {
  type PullRequestDeps,
  defaultPullRequestDeps,
  fetchPullRequest,
  githubRemotes,
  pullRequestAddress,
  readPullRequest,
} from "./pull-request.js";
import {
  type ResolvedPullRequest,
  ReviewStore,
  type Snapshot,
} from "./store.js";
import { traceSchema } from "./trace-schema.js";
import { ReviewWorkspaces } from "./workspaces.js";
import {
  EMPTY_SOURCE,
  inspectWorktree,
  localSourcePath,
  readWorkingFile,
  workingFiles,
} from "./worktree-source.js";

export const uploadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("image"),
    base64: z.string(),
  }),
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("trace"),
    trace: traceSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("map"),
    pins: pinsSchema,
    side: z.enum(["base", "head"]),
    model: mapInputSchema,
  }),
]);

const unavailableCheckout = () =>
  new ReviewInputError("The selected local checkout is unavailable.", 404);

/** File reads cannot name the root or a directory; tree reads can. */
function checkRelativePath(file: string) {
  inputError(() => checkSourcePath(file));

  if (file === "" || file.endsWith("/"))
    throw new ReviewInputError(
      "Source file must be a repository-relative path.",
    );
}

function sliceRange(
  file: { commit: string; text: string },
  source: FileLineRange,
) {
  return {
    ...source,
    commit: file.commit,
    text: inputError(() => sliceSourceRange(file.text, source)),
  };
}

interface RepositoryVcs {
  detection: Promise<LocalVcs | null>;
  vcs?: LocalVcs;
}

/** Local source/resource boundary, including Desktop-only local language context. */
export class LocalReviewData {
  private readonly workspaceManager?: ReviewWorkspaces;

  get workspaces(): ReviewWorkspaces {
    if (!this.workspaceManager)
      throw new ReviewInputError(
        "Open this review in Desktop to prepare language workspaces.",
        409,
      );

    return this.workspaceManager;
  }

  currentEnvironmentIssues(snapshot: Snapshot) {
    if (snapshot.target?.kind !== "commits" || !snapshot.pins) return [];
    const pins = snapshot.pins;

    return this.workspaces.list(snapshot.reviewId).flatMap((environment) => {
      const side =
        environment.commit === pins.head
          ? "head"
          : environment.commit === pins.base
            ? "base"
            : undefined;

      return side && environment.issue
        ? [{ side, message: environment.issue }]
        : [];
    });
  }

  async environmentIssues(snapshot: Snapshot, retryFailed = false) {
    const issues: { side: "base" | "head"; message: string }[] = [];

    if (!snapshot.pins) return issues;

    const sides: ("base" | "head")[] =
      snapshot.target?.kind === "commits" &&
      snapshot.pins.base !== snapshot.pins.head
        ? ["head", "base"]
        : ["head"];

    for (const side of sides) {
      const context = await this.languageEnvironment(
        snapshot,
        side,
        undefined,
        retryFailed,
      );

      if (context.issue) issues.push({ side, message: context.issue });
    }

    return issues;
  }

  /** Local checkout context for live worktree targets only. */
  /** Desktop language services borrow the registered checkout, never create one. */
  async liveFile(repositoryId: string, file: string, text: string) {
    try {
      const rootPath = await realpath(this.store.repositoryPath(repositoryId));
      const localPath = await localSourcePath(rootPath, file);

      if ((await readFile(localPath, "utf8")) === text)
        return { localPath, localRoot: rootPath };
    } catch {
      /* A moved or changed file can still be displayed without native LSP. */
    }

    return undefined;
  }
  /** Source bytes and the language workspace have independent lifetimes. */
  async languageEnvironment(
    snapshot: Snapshot,
    side: "base" | "head",
    commit?: string,
    retryFailed = false,
    anchor?: SourcePins,
  ): Promise<ReviewLanguageEnvironment> {
    // A reference with its own pins borrows that repository's registered
    // checkout, as live worktree targets do; no pinned checkout is prepared.
    if (!anchor && snapshot.target?.kind === "commits" && snapshot.pins) {
      const pins = await this.comparison(snapshot.pins, commit);

      const environment = await this.workspaces.source(
        snapshot.reviewId,
        pins,
        side,
        retryFailed,
      );

      return {
        rootPath:
          environment.state === "preparing" || environment.state === "pending"
            ? null
            : environment.rootPath,
        identity: environment.generation,
        issue: environment.issue,
      };
    }

    // Validate selected commits for both target kinds, but never prepare a live checkout.
    if (commit && !anchor)
      await this.comparison(await this.documentPins(snapshot), commit);

    const repositoryId = anchor?.repositoryId ?? snapshot.pins?.repositoryId;

    if (!repositoryId)
      throw new ReviewInputError(
        "This document has no source pins of its own.",
        409,
      );

    const unavailable: ReviewLanguageEnvironment = {
      rootPath: null,
      identity: `${repositoryId}:unavailable`,
      issue:
        "Could not access the registered language checkout. Check the repository path and permissions, then retry.",
    };

    let rootPath: string;

    try {
      rootPath = await realpath(this.store.repositoryPath(repositoryId));
    } catch (error) {
      if (error instanceof ReviewInputError && error.status !== 404)
        throw error;

      return unavailable;
    }

    if (!rootPath || !(await this.vcs(repositoryId))) return unavailable;
    const info = await stat(rootPath, { bigint: true }).catch(() => null);

    return info
      ? {
          rootPath,
          identity: `${repositoryId}:${rootPath}:${info.dev}:${info.ino}:${info.birthtimeNs}`,
        }
      : unavailable;
  }

  /** Resolve source coordinates after selecting a local or imported snapshot.
   * `anchor` reads at a reference's own pins instead of the document's;
   * `commit` narrows the document comparison to one of its commits. */
  async resolveSource(
    snapshot: Snapshot,
    commit?: string,
    anchor?: SourcePins,
  ) {
    const pins = anchor
      ? await this.anchorSourcePins(anchor)
      : await this.comparison(await this.documentPins(snapshot), commit);

    return { snapshot, pins };
  }

  /** Resolve a native workspace without replacing the selected source with today's HEAD. */
  async navigatorWorkspace(
    snapshot: Snapshot,
    source: {
      side?: "base" | "head";
      file?: string;
      empty?: boolean;
      commit?: string;
      anchor?: SourcePins;
    } = {},
  ): Promise<{ workspacePath: string; filePath?: string }> {
    const { pins } = await this.resolveSource(
      snapshot,
      source.commit,
      source.anchor,
    );

    const repository = this.store.repositoryPath(pins.repositoryId);
    const side = source.side ?? "head";

    const live =
      !!pins.worktreeRevision &&
      (side === "head" || (source.empty && pins[side] === EMPTY_SOURCE));

    const ref =
      pins[side] === EMPTY_SOURCE && source.empty ? pins.head : pins[side];

    if (source.file) checkRelativePath(source.file);

    // Keep navigation separate from language preparation, which may modify
    // tracked files. Retain these checkouts across window closes and restarts.
    const rootPath = live
      ? await realpath(repository)
      : await ensureReviewPinnedCheckout({
          rootPath: repository,
          ref,
          reviewUuid: snapshot.reviewId,
          role: "navigator",
        });

    const commonDir = await gitCommonDir(repository);

    if (!rootPath || !commonDir)
      throw new ReviewInputError(
        "Could not open the selected source checkout.",
        409,
      );

    if (!live) {
      const { stdout } = await promisify(execFile)("git", [
        "-C",
        rootPath,
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]);

      if (stdout.trim())
        throw new ReviewInputError(
          "The navigator checkout has local changes. Restore those files before browsing this pinned revision.",
          409,
        );
    }

    const workspacePath = path.join(
      reviewManagedCheckoutRoot(commonDir, snapshot.reviewId),
      "navigator",
      "workspaces",
      live ? "worktree" : ref,
      `${path.basename(repository)}.code-workspace`,
    );

    // A native workspace gives VS Code stable restoration, search scope and
    // editor read-only behavior without changing files in the source checkout.
    // Leave subsequent workspace preferences to VS Code and the user.
    if (!existsSync(workspacePath))
      await writePrivateJsonAtomic(workspacePath, {
        folders: [
          {
            path: rootPath,
            name: path.basename(repository),
          },
        ],
        settings: {
          "files.readonlyInclude": { "**/*": true },
          "window.title": `${snapshot.title} — ${live ? "Live source" : side === "base" ? "Base source" : "Source"} — Review`,
        },
      });

    let filePath: string | undefined;

    if (source.file) {
      if (source.empty) {
        // Native diffs need a real empty file for an added/deleted side.
        filePath = path.join(
          path.dirname(workspacePath),
          "empty",
          path.basename(source.file),
        );
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "", { mode: 0o600 });
      } else {
        try {
          filePath = await localSourcePath(rootPath, source.file);
        } catch (error) {
          if (isMissingFileError(error))
            throw new ReviewInputError(
              "File is unavailable at the selected revision.",
              404,
            );
          throw error;
        }
      }
    }

    return { workspacePath, filePath };
  }

  /** A document read that needs default pins; 409 when the document has none. */
  async documentPins(snapshot: Snapshot): Promise<Pins> {
    const pins = await this.sourcePins(snapshot);

    if (!pins)
      throw new ReviewInputError(
        "This document has no source pins of its own.",
        409,
      );

    return pins;
  }

  /** Pins a reference names itself, checked against the registered checkout. */
  async anchorSourcePins(anchor: SourcePins): Promise<Pins> {
    if (!existsSync(this.store.repositoryPath(anchor.repositoryId)))
      throw unavailableCheckout();

    return anchorPins({ pins: anchor }, undefined);
  }

  /** References whose own repository is unregistered or gone from disk. */
  async unavailableAnchors(snapshot: Snapshot): Promise<string[]> {
    const missing = new Set<string>();

    for (const pins of explicitPins(
      sourceReferences(snapshot.document, { tolerant: true }),
    ))
      try {
        await this.anchorSourcePins(pins);
      } catch (error) {
        if (!(error instanceof ReviewInputError)) throw error;
        missing.add(pins.repositoryId);
      }

    if (!missing.size) return [];

    return sourceReferences(snapshot.document, { tolerant: true })
      .filter(
        (ref) => ref.source.pins && missing.has(ref.source.pins.repositoryId),
      )
      .map((ref) => ref.id);
  }

  // A commit's tree never changes, so one listing serves every folder expansion.
  private readonly trackedFiles = new Map<string, Promise<string[]>>();

  private readonly repositories = new Map<string, RepositoryVcs>();

  private readonly readers = new Map<string, BlobBatchReader>();

  private readonly commitRanges = new Map<
    string,
    Promise<LocalVcsCommitSummary[]>
  >();

  constructor(
    private readonly store: ReviewStore,
    private readonly options: {
      blobReaderIdleTimeoutMs?: number;
      workspaceDatabase?: string;
      manageWorkspaces?: boolean;
      watch?: typeof watch;
      /** gh, git and GitHub API access for pull request targets. */
      pullRequests?: PullRequestDeps;
    } = {},
  ) {
    if (options.manageWorkspaces !== false)
      this.workspaceManager = new ReviewWorkspaces(
        options.workspaceDatabase ?? ":memory:",
        store,
      );
  }

  async *structuralChanges({
    reviewId,
    pins,
    signal,
    file,
  }: {
    reviewId: string;
    pins: Pins;
    signal: AbortSignal;
    file?: string;
  }): AsyncGenerator<StructuralDiffEvent> {
    if (file !== undefined) checkRelativePath(file);

    const rootPath = await ensureReviewPinnedCheckout({
      rootPath: this.store.repositoryPath(pins.repositoryId),
      ref: pins.head,
      reviewUuid: reviewId,
    });

    if (!rootPath)
      throw new ReviewInputError(
        "Cannot prepare the pinned repository for structural diffing.",
      );
    yield* this.structuralComparisons.stream({
      repositoryPath: rootPath,
      comparison: { kind: "trees", base: pins.base, head: pins.head },
      paths: file === undefined ? undefined : [file],
      signal,
    });
  }

  private readonly structuralComparisons = new StructuralComparisons();
  private closed = false;
  private readonly worktrees = new Map<
    string,
    {
      epoch: number;
      inspectedEpoch: number;
      watchers: FSWatcher[];
      healthy: boolean;
      inspection?: Awaited<ReturnType<typeof inspectWorktree>>;
    }
  >();

  private forgetWorktree(repositoryId: string) {
    const entry = this.worktrees.get(repositoryId);

    if (entry) for (const watcher of entry.watchers) watcher.close();
    this.worktrees.delete(repositoryId);
  }

  private async worktreeState(repositoryId: string, vcs: LocalVcs) {
    let entry = this.worktrees.get(repositoryId);

    if (!entry) {
      entry = { epoch: 0, inspectedEpoch: -1, watchers: [], healthy: true };
      this.worktrees.set(repositoryId, entry);
      const state = entry;
      const roots = new Set([vcs.rootPath]);
      const common = await gitCommonDir(vcs.rootPath);

      if (common) roots.add(common);

      for (const root of roots) {
        try {
          const watcher = (this.options.watch ?? watch)(
            root,
            { recursive: true },
            () => {
              state.epoch++;
            },
          );

          watcher.on("error", () => {
            state.epoch++;
            state.inspectedEpoch = -1;
            state.healthy = false;
            watcher.close();
          });
          watcher.unref();
          state.watchers.push(watcher);
        } catch {
          state.healthy = false;
        }
      }
    }

    if (
      entry.inspection &&
      entry.inspectedEpoch === entry.epoch &&
      entry.healthy &&
      entry.watchers.length
    )
      return entry.inspection;

    const epoch = entry.epoch;
    const inspected = await inspectWorktree(repositoryId, vcs);
    entry.inspection = inspected;
    entry.inspectedEpoch = epoch;

    return inspected;
  }

  async close(): Promise<void> {
    this.coverageAbort.abort();
    clearTimeout(this.coverageNotification);
    this.coverageListeners.clear();
    this.coverageCache.clear();
    this.structuralComparisons.close();
    this.closed = true;
    await this.workspaceManager?.close();

    for (const entry of this.worktrees.values())
      for (const watcher of entry.watchers) watcher.close();
    this.worktrees.clear();
    const readers = [...this.readers.values()];

    this.readers.clear();

    await Promise.all(readers.map((reader) => reader.close()));
  }

  /** Detected once; dropped when the root vanishes or detection found nothing. */
  private vcs(repositoryId: string): Promise<LocalVcs | null> {
    const cached = this.repositories.get(repositoryId);

    if (cached && (!cached.vcs || existsSync(cached.vcs.rootPath)))
      return cached.detection;

    this.closeReader(repositoryId);
    this.forgetWorktree(repositoryId);
    const rootPath = this.store.repositoryPath(repositoryId);

    const forget = () => {
      this.repositories.delete(repositoryId);
      this.closeReader(repositoryId);
    };

    const entry: RepositoryVcs = {
      detection: detectLocalVcs(rootPath).then(
        (vcs) => {
          if (vcs) entry.vcs = vcs;
          else forget();

          return vcs;
        },
        (cause: unknown) => {
          forget();

          throw cause;
        },
      ),
    };

    this.repositories.set(repositoryId, entry);

    return entry.detection;
  }

  /** None once closed: a read suspended across close() gets its own process. */
  private reader(
    repositoryId: string,
    vcs: LocalVcs,
  ): BlobBatchReader | undefined {
    if (this.closed) return undefined;
    const existing = this.readers.get(repositoryId);

    if (existing) return existing;

    const reader = createBlobBatchReader({
      rootPath: vcs.rootPath,
      kind: vcs.kind,
      idleTimeoutMs: this.options.blobReaderIdleTimeoutMs,
    });

    this.readers.set(repositoryId, reader);

    return reader;
  }

  private closeReader(repositoryId: string): Promise<void> | undefined {
    const reader = this.readers.get(repositoryId);

    if (!reader) return;
    this.readers.delete(repositoryId);

    return reader.close();
  }

  async forgetRepository(repositoryId: string) {
    await this.closeReader(repositoryId);
    this.repositories.delete(repositoryId);

    for (const key of this.trackedFiles.keys())
      if (key.startsWith(repositoryId + "\0")) this.trackedFiles.delete(key);

    for (const key of this.commitRanges.keys())
      if (key.startsWith(repositoryId + ":")) this.commitRanges.delete(key);
  }

  private async vcsTarget(
    repositoryId: string,
  ): Promise<{ rootPath: string; kind?: LocalVcsKind }> {
    const vcs = await this.vcs(repositoryId);

    if (vcs) return { rootPath: vcs.rootPath, kind: vcs.kind };
    const rootPath = this.store.repositoryPath(repositoryId);

    // local-vcs would report a missing root as a path-bearing 500.
    if (!existsSync(rootPath)) throw unavailableCheckout();

    return { rootPath };
  }

  async register(root: string) {
    const resolved = await realpath(root).catch(() => {
      throw new ReviewInputError(
        "Repository path does not exist or is not readable.",
      );
    });

    const vcs = await detectLocalVcs(resolved);

    if (!vcs) throw new ReviewInputError("Choose a Git or jj repository.");

    const repository = this.store.registerRepository(
      await realpath(vcs.rootPath),
    );

    // Registration may follow replacement of a managed repository at the same
    // path (for example resetting the tutorial). Reopen its Git reader too.
    await this.closeReader(repository.id);
    this.repositories.delete(repository.id);

    return repository;
  }
  async projectSource(snapshot: Snapshot, pins: Pins): Promise<Snapshot> {
    const projected: Snapshot = { ...snapshot, pins, staleSources: [] };
    delete projected.sourceUnavailable;

    // Live references retain their authored coordinates. Only diagnose ranges
    // that no longer exist; the author decides how to update changed source.
    for (const reference of sourceReferences(snapshot.document, {
      tolerant: true,
    })) {
      try {
        await this.quote(anchorPins(reference.source, pins), reference.source);
      } catch (error) {
        if (!(error instanceof ReviewInputError)) throw error;
        projected.staleSources!.push(reference.id);
      }
    }

    return projected;
  }
  /** Throws 404 when the checkout behind the snapshot is gone. Undefined
   * for a document without default pins. */
  async sourcePins(snapshot: Snapshot): Promise<Pins | undefined> {
    if (snapshot.target?.kind === "worktree")
      return (await this.resolveTarget(snapshot.target)).pins;

    if (!snapshot.pins) return undefined;

    if (!existsSync(this.store.repositoryPath(snapshot.pins.repositoryId)))
      throw unavailableCheckout();

    return snapshot.pins;
  }
  /** Capture a label only when its ref still resolves to these exact pins. */
  async headBranch(pins: Pins, headRef?: string): Promise<string | undefined> {
    const vcs = await this.vcs(pins.repositoryId);

    if (!vcs || vcs.kind !== "git") return undefined;

    try {
      const run = promisify(execFile);

      const { stdout } = await run("git", [
        "-C",
        vcs.rootPath,
        "rev-parse",
        "--symbolic-full-name",
        "--verify",
        "--end-of-options",
        !headRef || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headRef)
          ? "HEAD"
          : headRef,
      ]);

      const ref = stdout.trim();

      if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/"))
        return undefined;

      const resolved = await vcs.resolveRevision(ref);

      if (resolved?.commit !== pins.head) return undefined;

      return ref.replace(/^refs\/(heads|remotes)\//, "");
    } catch {
      // Optional provenance must not block authoring in a detached checkout.
      return undefined;
    }
  }

  async resolveTarget(
    target: ReviewTarget,
  ): Promise<{ target: ReviewTarget; pins: Pins }> {
    const vcs = await this.vcs(target.repositoryId);

    if (!vcs) throw unavailableCheckout();

    if (target.kind === "commits") {
      const head = await vcs.resolveRevision(target.head);

      if (!head) throw new ReviewInputError("Head revision does not exist.");

      const base =
        target.base === undefined
          ? head
          : await vcs.resolveRevision(target.base);

      if (!base) throw new ReviewInputError("Base revision does not exist.");

      const resolved = { ...target, head: head.commit };

      if (target.base !== undefined) resolved.base = base.commit;

      return {
        target: resolved,
        pins: {
          repositoryId: target.repositoryId,
          base: base.commit,
          head: head.commit,
        },
      };
    }

    const base =
      target.base === undefined
        ? undefined
        : await vcs.resolveRevision(target.base);

    if (target.base !== undefined && !base)
      throw new ReviewInputError("Base revision does not exist.");

    const { revision, commit } = await this.worktreeState(
      target.repositoryId,
      vcs,
    );

    const resolved = { ...target };

    if (base) resolved.base = base.commit;

    return {
      target: resolved,
      pins: {
        repositoryId: target.repositoryId,
        base: base?.commit ?? commit,
        head: commit,
        worktreeRevision: revision,
      },
    };
  }
  /** The PR's current comparison, fetched into a registered checkout of its repository. */
  async resolvePullRequest(
    url: string,
    repository: { id?: string; preferred?: string },
  ): Promise<ResolvedPullRequest> {
    const deps = this.options.pullRequests ?? defaultPullRequestDeps;
    const { slug, number } = pullRequestAddress(url);
    const record = readPullRequest(url, deps);

    record.catch(() => {});

    const checkout = await this.pullRequestCheckout(slug, repository, deps);
    const pullRequest = await record;

    const { head, base } = await fetchPullRequest(
      { ...checkout, pullRequest },
      deps,
    );

    const repositoryId = checkout.repositoryId;

    return {
      target: { kind: "commits", repositoryId, head, base },
      pins: { repositoryId, base, head },
      title: pullRequest.title.trim() || `PR #${number}`,
    };
  }
  /** A registered checkout with a remote for owner/repo, and that remote. */
  private async pullRequestCheckout(
    slug: string,
    repository: { id?: string; preferred?: string },
    deps: PullRequestDeps,
  ) {
    const registered = this.store.repositories();

    const candidates = repository.id
      ? registered.filter((entry) => entry.id === repository.id)
      : [
          ...registered.filter((entry) => entry.id === repository.preferred),
          ...registered.filter((entry) => entry.id !== repository.preferred),
        ];

    if (repository.id && candidates.length === 0)
      throw new ReviewInputError("Repository is not registered.", 404);

    for (const { id } of candidates) {
      if (!existsSync(this.store.repositoryPath(id))) continue;
      const vcs = await this.vcs(id);
      const gitDir = vcs && (await gitCommonDir(vcs.rootPath));

      if (!vcs || !gitDir) continue;

      const remote = (await githubRemotes(gitDir, deps)).find(
        (entry) => entry.slug.toLowerCase() === slug.toLowerCase(),
      );

      if (remote)
        return {
          repositoryId: id,
          rootPath: vcs.rootPath,
          gitDir,
          kind: vcs.kind,
          remote: remote.name,
        };
    }

    throw new ReviewInputError(
      repository.id
        ? `That checkout has no GitHub remote for ${slug}. Add one, or omit repositoryId.`
        : `No registered checkout has a GitHub remote for ${slug}. Register a checkout of ${slug} with review_register_repository first, or pass a target.`,
      404,
    );
  }
  async resolvePins(
    repositoryId: string,
    base: string,
    head: string,
  ): Promise<Pins> {
    const vcs = await this.vcs(repositoryId);

    const [left, right] = vcs
      ? await Promise.all([
          vcs.resolveRevision(base),
          vcs.resolveRevision(head),
        ])
      : [null, null];

    if (!left || !right)
      throw new ReviewInputError(
        `Base or head revision does not exist in the local checkout (${!left ? `base: ${base}` : `head: ${head}`}). Fetch the requested commits before authoring; in CI, configure checkout depth to include both revisions.`,
      );

    return { repositoryId, base: left.commit, head: right.commit };
  }
  async validatePins(pins: Pins) {
    if (pins.worktreeRevision) {
      if (!(await this.vcs(pins.repositoryId))) throw unavailableCheckout();

      return;
    }

    const resolved = await this.resolvePins(
      pins.repositoryId,
      pins.base,
      pins.head,
    );

    if (resolved.base !== pins.base || resolved.head !== pins.head)
      throw new ReviewInputError(
        "Use resolved commit IDs, not moving branch names.",
      );
  }
  async file(
    pins: Pins,
    side: "base" | "head",
    file: string,
    allowBinary = false,
  ) {
    checkRelativePath(file);
    const commit = pins[side];
    const vcs = await this.vcs(pins.repositoryId);

    const text =
      pins.worktreeRevision && side === "head"
        ? vcs
          ? await readWorkingFile(vcs.rootPath, file)
          : null
        : commit === EMPTY_SOURCE
          ? null
          : vcs
            ? await readFileAtCommit({
                rootPath: vcs.rootPath,
                kind: vcs.kind,
                commit,
                relativePath: file,
                reader: this.reader(pins.repositoryId, vcs),
              })
            : null;

    if (text === null)
      throw new ReviewInputError(
        "File is unavailable at the pinned commit.",
        404,
      );

    if (!allowBinary && text.includes("\0"))
      throw new ReviewInputError(
        "Binary files cannot be used as code references.",
      );

    return { file, side, commit, text };
  }

  async tree(
    pins: Pins,
    side: "base" | "head",
    directory: string,
  ): Promise<ReviewSourceEntry[]> {
    inputError(() => checkSourcePath(directory));
    const prefix = directory ? directory.replace(/\/$/, "") + "/" : "";
    const entries = new Map<string, ReviewSourceEntry>();

    const vcs = pins.worktreeRevision
      ? await this.vcs(pins.repositoryId)
      : undefined;

    if (pins.worktreeRevision && !vcs) throw unavailableCheckout();

    const files =
      vcs && side === "head"
        ? await workingFiles(vcs)
        : pins[side] === EMPTY_SOURCE
          ? []
          : await this.trackedFilesAt(pins.repositoryId, pins[side]);

    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      const name = relative.split("/", 1)[0]!;
      entries.set(name, {
        path: prefix + name,
        kind: relative.includes("/") ? "directory" : "file",
      });
    }

    if (directory && entries.size === 0)
      throw new ReviewInputError(
        "Directory is unavailable at the pinned commit.",
        404,
      );

    return [...entries.values()];
  }
  private trackedFilesAt(repositoryId: string, ref: string) {
    const key = `${repositoryId}\0${ref}`;
    let files = this.trackedFiles.get(key);

    if (!files) {
      files = this.vcs(repositoryId).then((vcs) => {
        // Do not keep the empty listing of a missing repository.
        if (!vcs) {
          this.trackedFiles.delete(key);

          return [];
        }

        return listTrackedFilesAtCommit({
          rootPath: vcs.rootPath,
          kind: vcs.kind,
          commit: ref,
        });
      });
      this.trackedFiles.set(key, files);
      files.catch(() => this.trackedFiles.delete(key));
    }

    return files;
  }
  async validateSources(pins: Pins, sources: FileLineRange[]) {
    const files = new Map<string, FileLineRange[]>();

    for (const input of sources) {
      const source = fileLineRangeSchema.parse(input);

      const key = JSON.stringify([
        pins[source.side],
        pins.worktreeRevision ? source.side : null,
        source.file,
      ]);

      const ranges = files.get(key);

      if (ranges) ranges.push(source);
      else files.set(key, [source]);
    }

    for (const ranges of files.values()) {
      const first = ranges[0]!;
      const file = await this.file(pins, first.side, first.file);

      for (const source of ranges) sliceRange(file, source);
    }
  }
  async quote(pins: Pins, source: FileLineRange) {
    source = fileLineRangeSchema.parse(source);

    return sliceRange(await this.file(pins, source.side, source.file), source);
  }
  /** Every source reference must exist at the pins; only code peeks must also
   * show something. */
  async validateSource(
    pins: Pins,
    source: FileLineRange,
    options: { peek: boolean },
  ) {
    const quote = await this.quote(pins, source);

    if (options.peek)
      inputError(() => requireVisibleSource(quote.text, source));
  }
  /** Legacy import keeps a document whose source ranges no longer resolve;
   * the problem becomes a warning instead of a rejection. */
  async validateSourceTolerant(
    pins: Pins,
    source: FileLineRange,
    options: { peek: boolean },
  ): Promise<string | null> {
    try {
      await this.validateSource(pins, source, options);

      return null;
    } catch (error) {
      if (error instanceof ReviewInputError)
        return `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: ${error.message}`;
      throw error;
    }
  }
  private readonly coverageCache = new Map<
    string,
    {
      promise: ReturnType<typeof comparisonCoverage>;
      state: "pending" | "ready" | "error";
      error?: unknown;
      partial?: ComparisonCoverage;
    }
  >();
  private readonly coverageAbort = new AbortController();
  private readonly coverageListeners = new Set<() => void>();
  coverageRevision = 0;

  subscribeCoverage(listener: () => void) {
    this.coverageListeners.add(listener);

    return () => {
      this.coverageListeners.delete(listener);
    };
  }

  /** Start shared coverage work without occupying an HTTP request until it completes. */
  coveragePending(reviewId: string, pins: Pins, mode: CoverageMode): boolean {
    const key = JSON.stringify([pins, mode]);
    const existing = this.coverageCache.get(key);

    if (existing?.state === "error") {
      this.coverageCache.delete(key);
      throw existing.error;
    }

    void this.coverage(reviewId, pins, mode).catch(() => {});

    return this.coverageCache.get(key)!.state === "pending";
  }

  coverageSnapshot(reviewId: string, pins: Pins, mode: CoverageMode) {
    const pending = this.coveragePending(reviewId, pins, mode);
    const entry = this.coverageCache.get(JSON.stringify([pins, mode]))!;

    return {
      pending,
      comparison: entry.partial ?? {
        files: [],
        fileSources: new Map(),
        alignments: new Map(),
      },
    };
  }

  private coverageNotification: ReturnType<typeof setTimeout> | undefined;
  private notifyCoverage() {
    if (this.closed || this.coverageNotification) return;
    this.coverageNotification = setTimeout(() => {
      this.coverageNotification = undefined;
      this.coverageRevision++;

      for (const listener of this.coverageListeners) listener();
    }, 50);
  }

  coverage(reviewId: string, pins: Pins, mode: CoverageMode) {
    const key = JSON.stringify([pins, mode]);
    let entry = this.coverageCache.get(key);

    if (!entry || entry.state === "error") {
      const promise = comparisonCoverage(
        this,
        reviewId,
        pins,
        mode,
        this.coverageAbort.signal,
        (partial) => {
          const current = this.coverageCache.get(key);

          if (current) current.partial = partial;
          this.notifyCoverage();
        },
      );

      entry = { promise, state: "pending" };
      this.coverageCache.set(key, entry);
      const current = entry;

      const settled = (state: "ready" | "error", error?: Error) => {
        current.state = state;
        current.error = error;
        this.notifyCoverage();

        // Never evict shared in-flight work. Trim only settled comparisons.
        for (const [cachedKey, cached] of this.coverageCache) {
          if (this.coverageCache.size <= 32) break;

          if (cached.state !== "pending" && cachedKey !== key)
            this.coverageCache.delete(cachedKey);
        }
      };

      void promise.then(
        (value) => {
          current.partial = value;

          if (!this.closed)
            this.store.setDiffStats(
              pins,
              {
                fileCount: value.files.length,
                additions: value.files.reduce(
                  (sum, file) =>
                    sum + structuralChangeCounts(file.changed).added,
                  0,
                ),
                deletions: value.files.reduce(
                  (sum, file) =>
                    sum + structuralChangeCounts(file.changed).removed,
                  0,
                ),
              },
              mode,
            );
          settled("ready");
        },
        (error) => settled("error", error),
      );
    }

    return entry.promise;
  }

  changes(pins: Pins): Promise<LocalVcsDiffFileSummary[]>;
  changes(pins: Pins, file: string): Promise<string>;
  changes(
    pins: Pins,
    file?: string,
  ): Promise<LocalVcsDiffFileSummary[] | string>;
  async changes(pins: Pins, file?: string) {
    if (file === undefined) return this.summaries(pins);
    checkRelativePath(file);

    return this.rawPatch(pins, { paths: [file] });
  }
  /** Changed files matching a pathspec: exact files or directories, either side of a rename. */
  async changedFiles(pins: Pins, paths?: string[]) {
    const files = await this.summaries(pins);

    if (!paths?.length) return files;

    for (const spec of paths) checkRelativePath(spec.replace(/\/+$/, ""));

    return files.filter((file) =>
      paths.some((spec) => pathspecMatches(spec, file)),
    );
  }
  /** Numbered plain-text patches for the pathspec, within maxBytes. */
  async patches(
    pins: Pins,
    options: { paths?: string[]; contextLines?: number; maxBytes: number },
  ) {
    const files = await this.changedFiles(pins, options.paths);

    const unmatched = (options.paths ?? []).filter(
      (spec) => !files.some((file) => pathspecMatches(spec, file)),
    );

    const note = unmatched.length
      ? `[No changes match paths:${JSON.stringify(unmatched)}.]\n`
      : "";

    if (files.length === 0) return note || "[No changes.]\n";

    const patch = await this.rawPatch(pins, {
      // Both sides of a rename, so Git pairs them instead of adding a file.
      paths: options.paths?.length
        ? [
            ...new Set(
              files.flatMap((file) =>
                file.previousPath
                  ? [file.previousPath, file.path]
                  : [file.path],
              ),
            ),
          ]
        : undefined,
      contextLines: options.contextLines,
    });

    return (
      budgetPatches(
        splitGitPatchFiles(patch).map(({ file, patch }) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          patch,
        })),
        options.maxBytes,
      ) + note
    );
  }
  private async summaries(pins: Pins) {
    if (pins.worktreeRevision) {
      return diffFileSummariesWorkingTree(await this.worktreeInput(pins));
    }

    return diffFileSummariesTrees({
      ...(await this.vcsTarget(pins.repositoryId)),
      baseRef: pins.base,
      headRef: pins.head,
    });
  }
  /** Raw Git patch text for exact filenames, or every change. */
  private async rawPatch(
    pins: Pins,
    options: { paths?: string[]; contextLines?: number },
  ) {
    if (pins.worktreeRevision)
      return diffWorkingTree({
        ...(await this.worktreeInput(pins)),
        ...options,
      });

    return diffTrees({
      ...(await this.vcsTarget(pins.repositoryId)),
      baseRef: pins.base,
      headRef: pins.head,
      ...options,
      literalPaths: options.paths !== undefined,
    });
  }
  private async worktreeInput(pins: Pins) {
    const vcs = await this.vcs(pins.repositoryId);

    if (!vcs) throw unavailableCheckout();

    return {
      rootPath: vcs.rootPath,
      kind: vcs.kind,
      baseRef: pins.base === EMPTY_SOURCE ? undefined : pins.base,
      headRef: pins.head === EMPTY_SOURCE ? undefined : pins.head,
    };
  }
  commits(pins: Pins) {
    if (
      pins.base === pins.head ||
      pins.base === EMPTY_SOURCE ||
      pins.head === EMPTY_SOURCE
    )
      return Promise.resolve([]);
    const key = `${pins.repositoryId}:${pins.base}:${pins.head}`;
    const cached = this.commitRanges.get(key);

    if (cached) return cached;

    // Immutable pins: one list per key; a rejection is evicted.
    const pending = this.readCommitRange(pins).catch((cause: unknown) => {
      this.commitRanges.delete(key);

      throw cause;
    });

    this.commitRanges.set(key, pending);

    return pending;
  }
  private async readCommitRange(pins: Pins) {
    return listCommitRange({
      ...(await this.vcsTarget(pins.repositoryId)),
      baseRef: pins.base,
      headRef: pins.head,
    });
  }
  async comparison(pins: Pins, commit?: string): Promise<Pins> {
    if (!commit) return pins;

    const selected = (await this.commits(pins)).find(
      (item) => item.commit === commit,
    );

    if (!selected)
      throw new ReviewInputError(
        "The selected commit is not part of this review version.",
        404,
      );

    return {
      repositoryId: pins.repositoryId,
      base: selected.parentCommit,
      head: selected.commit,
    };
  }
  async map(documentPins: Pins | undefined, resourceId: string) {
    await this.validateResource(documentPins, {
      type: "software_map",
      mapVersionId: resourceId,
    });

    const resource = this.store.resource(resourceId);

    // SAFETY: map resources are normalized and validated by upload before storage.
    const saved = JSON.parse(Buffer.from(resource.data).toString()) as Pick<
      NormalizedSoftwareModel,
      "elements" | "relationships"
    > & {
      side: "base" | "head";
      commit: string;
    };

    // Without document pins the map is read at the commit it was built from.
    const pins: Pins = documentPins ?? {
      repositoryId: resource.repositoryId,
      base: saved.commit,
      head: saved.commit,
    };

    const target = await this.vcsTarget(pins.repositoryId);

    const patch = pins.worktreeRevision
      ? await diffWorkingTree({
          ...target,
          kind: target.kind ?? "git",
          baseRef: pins.base === EMPTY_SOURCE ? undefined : pins.base,
          headRef: pins.head === EMPTY_SOURCE ? undefined : pins.head,
        })
      : undefined;

    const resolved = await resolveSoftwareMapDiffCounts({
      patch,
      sourceRootPath: target.rootPath,
      sourceVcsKind: target.kind,
      baseRef: pins.base,
      headRef: pins.head,
      side: saved.side,
      codeElements: saved.elements.filter(
        (element) => element.type === "codeElement",
      ),
      coverageClaims: saved.elements.flatMap((element) =>
        element.coverage ? [{ path: element.path, ...element.coverage }] : [],
      ),
    });

    return {
      ...saved,
      countsByElementPath: resolved.countsByElementPath,
      unmappedByElementPath: resolved.unmappedByElementPath,
    };
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Upload boundary: uploadSchema.parse below validates incoming JSON.
  async upload(value: unknown) {
    const input = uploadSchema.parse(value);
    this.store.repositoryPath(input.repositoryId);

    let mimeType = "application/json",
      data: Uint8Array;

    switch (input.kind) {
      case "image":
        data = await decodeImage(Buffer.from(input.base64, "base64"));
        mimeType = "image/png";
        break;

      case "trace":
        if (
          new Set(input.trace.events.map((event) => event.id)).size !==
          input.trace.events.length
        )
          throw new ReviewInputError("Trace event IDs must be unique.");
        data = Buffer.from(
          JSON.stringify({ ...input.trace, provenance: "client_supplied" }),
        );
        break;
      case "map": {
        if (input.pins.repositoryId !== input.repositoryId)
          throw new ReviewInputError("Map belongs to a different repository.");
        await this.validatePins(input.pins);
        let model;

        try {
          model = defineSoftwareMap(input.model);
        } catch (error) {
          if (error instanceof SoftwareModelValidationError)
            throw new ReviewInputError(error.message);
          throw error;
        }

        // Read each pinned file once, then check every range against it concurrently.
        const files = new Map<string, ReturnType<LocalReviewData["file"]>>();

        await Promise.all(
          model.elements.flatMap((element) =>
            (element.sourceRanges ?? []).map(async (source) => {
              const range = fileLineRangeSchema.parse({
                ...source,
                side: input.side,
              });

              let read = files.get(range.file);

              if (!read)
                files.set(
                  range.file,
                  (read = this.file(input.pins, range.side, range.file)),
                );
              sliceRange(await read, range);
            }),
          ),
        );
        data = Buffer.from(
          JSON.stringify({
            commit: input.pins[input.side],
            side: input.side,
            elements: model.elements,
            relationships: model.relationships,
          }),
        );
        break;
      }
    }

    return this.store.putResource(
      input.id,
      input.repositoryId,
      input.kind,
      mimeType,
      data,
    );
  }
  /** A resource must belong to the document's repository when it has one;
   * a document without pins may use any registered repository's resources. */
  async validateResource(pins: Pins | undefined, block: Block) {
    const reference = resourceReference(block);

    if (!reference) return;
    const { id, kind } = reference;
    const resource = this.store.resource(id);

    if (
      (pins && resource.repositoryId !== pins.repositoryId) ||
      resource.kind !== kind
    )
      throw new ReviewInputError(
        "Resource belongs to a different repository or component type.",
      );

    if (!pins) this.store.repositoryPath(resource.repositoryId);

    if (block.type === "trace_quote") {
      const trace = traceSchema.parse(
        JSON.parse(Buffer.from(resource.data).toString()),
      );

      const event = trace.events.find((event) => event.id === block.eventId);

      if (!event || !textIncludesQuote(event.text, block.text))
        throw new ReviewInputError(
          "Quote does not match the retained trace event.",
        );
    }

    if (block.type === "software_map") {
      // SAFETY: map resources are normalized and validated by upload before storage.
      const map = JSON.parse(Buffer.from(resource.data).toString()) as {
        commit: string;
        side: "base" | "head";
        elements: { id: string; path: string }[];
      };

      if (pins && map.commit !== pins[map.side])
        throw new ReviewInputError(
          "Map does not match this review's source pins.",
        );

      if (
        block.focusElementId &&
        !map.elements.some(
          (element) =>
            element.id === block.focusElementId ||
            element.path === block.focusElementId,
        )
      )
        throw new ReviewInputError("Map focus element does not exist.");
    }
  }
}

/** The pure source checks throw their own error; API clients see it as input. */
function inputError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SourceRangeError)
      throw new ReviewInputError(error.message);
    throw error;
  }
}

export function openLocalReviewStore(
  databasePath: string,
  options: {
    blobReaderIdleTimeoutMs?: number;
    manageWorkspaces?: boolean;
    watch?: typeof watch;
    pullRequests?: PullRequestDeps;
  } = {},
) {
  const store: ReviewStore = new ReviewStore(databasePath, {
    projectSource: (snapshot, pins) => data.projectSource(snapshot, pins),
    resolveTarget: (target) => data.resolveTarget(target),
    resolvePullRequest: (url, repository) =>
      data.resolvePullRequest(url, repository),
    headBranch: (pins, headRef) => data.headBranch(pins, headRef),
    sourcePins: (snapshot) => data.sourcePins(snapshot),
    unavailableAnchors: (snapshot) => data.unavailableAnchors(snapshot),
    validatePins: (pins) => data.validatePins(pins),
    validateSource: (pins, source, options) =>
      data.validateSource(pins, source, options),
    validateResource: (pins, block) => data.validateResource(pins, block),
    validateSourceTolerant: (pins, source, options) =>
      data.validateSourceTolerant(pins, source, options),
  });

  let data: LocalReviewData;

  try {
    data = new LocalReviewData(store, {
      ...options,
      workspaceDatabase: `${databasePath}.workspaces`,
    });
  } catch (error) {
    void store.close();
    throw error;
  }

  return { store, data };
}

/** A pathspec entry names a changed file or a directory above it, on either side of a rename. */
function pathspecMatches(
  spec: string,
  file: { path: string; previousPath?: string },
) {
  const prefix = spec.replace(/\/+$/, "");

  return [file.path, file.previousPath].some(
    (path) =>
      path !== undefined && (path === prefix || path.startsWith(prefix + "/")),
  );
}
