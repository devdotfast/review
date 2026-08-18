import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeNoteSync } from "@dev.fast/local-vcs";
import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { reviewDocumentsDir as defaultReviewDocumentsDir } from "../review-file";
import { SOFTWARE_MAP_NOTES_REF } from "../review-storage";
import { CANONICAL_SOFTWARE_MAP_MODEL_IMPORT } from "../software-map-artifact";
import {
  generateActiveReviewDocumentModule,
  generateReviewAuthoringModule,
  reviewDocumentTitle,
} from "./review-documents-module";

const currentHeadSync = vi.hoisted(() =>
  vi.fn<(rootPath: string) => { commit: string } | null>(),
);
const defaultBaseSync = vi.hoisted(() =>
  vi.fn<(input: unknown) => { commit: string } | null>(),
);
const currentHeadAsync = vi.hoisted(() =>
  vi.fn<(rootPath: string) => Promise<{ commit: string } | null>>(),
);
const resolveRevisionAsync = vi.hoisted(() =>
  vi.fn<
    (rootPath: string, ref: string) => Promise<{ commit: string } | null>
  >(),
);
const defaultBaseAsync = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ commit: string } | null>>(),
);
const materializeSoftwareMapAtRefSync = vi.hoisted(() =>
  vi.fn<(input: unknown) => string | null>(() => null),
);
const materializeSoftwareMapAtRef = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<string | null>>(async () => null),
);
const ensureRepoSoftwareMapArtifacts = vi.hoisted(() =>
  vi.fn<(repoRootPath: string) => void>(),
);

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const HEAD_REF = "refs/dev-fast/reviews/pr-353/head";
const BASE_REF = "origin/main";
const LOCAL_VCS_SOURCE_MODULE_ID = fileURLToPath(
  new URL("../../../local-vcs/src/index.ts", import.meta.url),
);

describe("review document module", () => {
  it("uses the first markdown H1 as the review document title", () => {
    const filePath = writeTempMdx(`
export const comments = {};
export const questions = {};

# Graph Prewarm And Incremental Refresh

## Summary
`);

    expect(reviewDocumentTitle(filePath, "fallback")).toBe(
      "Graph Prewarm And Incremental Refresh",
    );
  });

  it("ignores fenced markdown headings when deriving the title", () => {
    const filePath = writeTempMdx(`
\`\`\`md
# Example Only
\`\`\`

# Real Review Title
`);

    expect(reviewDocumentTitle(filePath, "fallback")).toBe("Real Review Title");
  });

  it("falls back when no top-level heading exists", () => {
    const filePath = writeTempMdx(`
export const comments = {};
export const questions = {};

## Summary
`);

    expect(reviewDocumentTitle(filePath, "codex-review")).toBe("codex-review");
  });

  it("statically imports only the active review document", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-module-"));
    writeReviewStore(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const defaultReviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const prReviewPath = path.join(reviewDocumentsDir, "pr-123.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(defaultReviewPath, "# Current Review\n");
    writeFileSync(archivedReviewPath, "# Archived Review\n");
    writeFileSync(prReviewPath, "# PR Review\n");

    const source = await generateActiveReviewDocumentModule({
      reviewPath: defaultReviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
      activeRoutePath: "/",
    });

    expect(source).toContain(toVitePath(defaultReviewPath));
    expect(source).not.toContain(toVitePath(archivedReviewPath));
    expect(source).not.toContain(toVitePath(prReviewPath));
    expect(source).not.toContain("import(");
    expect(source).not.toContain("candidate");
    expect(source).not.toContain("validated-revision");
    expect(source).toContain(
      'import { __reviewDefinitionsReady } from "virtual:progressive-review-authoring";',
    );
    expect(source.indexOf("await __reviewDefinitionsReady();")).toBeLessThan(
      source.indexOf("createActiveReviewDocument({"),
    );
  });

  it("does not import omitted software map refs from notes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-module-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = defaultReviewDocumentsDir(dir);
    const currentDir = path.join(reviewDocumentsDir, "current");
    const defaultReviewPath = path.join(currentDir, "review.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      defaultReviewPath,
      ["export const comments = {};", "", "# Current Review"].join("\n"),
    );
    git(dir, ["init"]);
    git(dir, ["config", "user.name", "Review Test"]);
    git(dir, ["config", "user.email", "review@example.com"]);
    git(dir, ["checkout", "-b", "main"]);
    writeFileSync(path.join(dir, "README.md"), "repo\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "initial"]);
    // A stored note alone does not opt the document into a software map.
    const headCommit = gitOutput(dir, ["rev-parse", "HEAD"]);
    writeReviewStore(dir, { baseCommit: headCommit, sourceCommit: headCommit });
    writeNoteSync({
      rootPath: dir,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit: headCommit,
      content: [
        `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
        'export default defineSoftwareMap({ systems: { app: { label: "App" } } });',
      ].join("\n"),
    });

    const source = await generateActiveReviewDocumentModule({
      reviewPath: defaultReviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
      activeRoutePath: "/",
    });

    // Head materialization lands in the repo's git dir, keyed by HEAD.
    const materializedPath = path.join(
      gitOutput(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      "dev-fast",
      "materialized",
      headCommit,
      "software-map.ts",
    );
    expect(source).not.toContain("software-map.ts");
    expect(existsSync(materializedPath)).toBe(true);
  });

  it("renders no head map when the unpinned head commit has no note", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-module-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = defaultReviewDocumentsDir(dir);
    const currentDir = path.join(reviewDocumentsDir, "current");
    const defaultReviewPath = path.join(currentDir, "review.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      defaultReviewPath,
      [
        "export const comments = {};",
        "",
        "# Current Review",
        "",
        "<SoftwareMap />",
      ].join("\n"),
    );
    git(dir, ["init"]);
    git(dir, ["config", "user.name", "Review Test"]);
    git(dir, ["config", "user.email", "review@example.com"]);
    git(dir, ["checkout", "-b", "main"]);
    writeFileSync(path.join(dir, "README.md"), "repo\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "review without map"]);
    const headCommit = gitOutput(dir, ["rev-parse", "HEAD"]);
    writeReviewStore(dir, { baseCommit: headCommit, sourceCommit: headCommit });

    const source = await generateActiveReviewDocumentModule({
      reviewPath: defaultReviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
      activeRoutePath: "/",
    });
    const authoringSource = await generateReviewAuthoringModule({
      reviewPath: defaultReviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
      activeRoutePath: "/",
    });

    expect(source).not.toContain("repoSoftwareMapModule");
    expect(source).not.toContain("baseSoftwareMapModule");
    expect(source).not.toContain("materialized");
    expect(authoringSource).toContain("softwareMap: null");
    expect(authoringSource).toContain(
      "export const __reviewDefinitionDiagnostics = session.diagnostics;",
    );
  });

  it("keeps the authoring module independent from a stored map", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-module-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = defaultReviewDocumentsDir(dir);
    const currentDir = path.join(reviewDocumentsDir, "current");
    const defaultReviewPath = path.join(currentDir, "review.mdx");
    const explicitMapPath = path.join(
      process.env.DEV_REVIEW_HOME!,
      "explicit-maps",
      "abc123",
      "head-software-map.ts",
    );
    mkdirSync(path.dirname(explicitMapPath), { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      explicitMapPath,
      [
        `import { defineSoftwareMap } from "${modelImportPath(dir, explicitMapPath, "tolerant-software-map-model.ts")}";`,
        'export default defineSoftwareMap({ systems: { explicit: { label: "Explicit" } } });',
      ].join("\n"),
    );
    writeFileSync(
      defaultReviewPath,
      [
        "---",
        "softwareMap:",
        `  mapPath: ${JSON.stringify(explicitMapPath)}`,
        "---",
        "",
        "export const comments = {};",
        "",
        "# Current Review",
      ].join("\n"),
    );
    git(dir, ["init"]);
    git(dir, ["config", "user.name", "Review Test"]);
    git(dir, ["config", "user.email", "review@example.com"]);
    git(dir, ["checkout", "-b", "main"]);
    writeFileSync(path.join(dir, "README.md"), "repo\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "initial"]);
    const headCommit = gitOutput(dir, ["rev-parse", "HEAD"]);
    writeReviewStore(dir, { baseCommit: headCommit, sourceCommit: headCommit });
    writeNoteSync({
      rootPath: dir,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit: headCommit,
      content: [
        `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
        'export default defineSoftwareMap({ systems: { noted: { label: "Noted" } } });',
      ].join("\n"),
    });

    const source = await generateReviewAuthoringModule({
      reviewPath: defaultReviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
      activeRoutePath: "/",
    });

    expect(source).not.toContain("repoSoftwareMapModule");
    expect(source).not.toContain("materialized");
    expect(source).not.toContain(toVitePath(explicitMapPath));
  });

  it("uses cached non-active manifests during startup and scans only the active document", async () => {
    const {
      resolveRevisionAsync,
      materializeSoftwareMapAtRef,
      collectReviewDocumentModule,
    } = await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-startup-cache-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const mapRoot = path.join(dir, "maps");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));
    writeFileSync(
      archivedReviewPath,
      reviewDocSourceWithPinnedRefs("Archived Review"),
    );

    materializeSoftwareMapAtRef.mockImplementation(async ({ ref }) =>
      path.join(mapRoot, `${ref}-software-map.ts`),
    );

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };

    const warmUpScan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    await warmUpScan.ensureReviewDocumentFresh("/codex-archived");

    currentHeadAsync.mockClear();
    resolveRevisionAsync.mockClear();
    defaultBaseAsync.mockClear();
    materializeSoftwareMapAtRef.mockClear();

    const startupScan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    expect(startupScan.manifests).toHaveLength(2);
    expect(resolveRevisionAsync).not.toHaveBeenCalled();
    expect(materializeSoftwareMapAtRef).toHaveBeenCalledTimes(2);
  });

  it("does not rescan a cached route while artifacts still exist", async () => {
    const {
      resolveRevisionAsync,
      materializeSoftwareMapAtRef,
      collectReviewDocumentModule,
    } = await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-cache-paths-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const mapRoot = path.join(dir, "maps");

    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));
    writeFileSync(
      archivedReviewPath,
      reviewDocSourceWithPinnedRefs("Archived Review"),
    );
    resolveRevisionAsync.mockImplementation(async (_repoRoot, revision) => ({
      commit:
        revision === HEAD_REF
          ? COMMIT_A
          : revision === BASE_REF
            ? COMMIT_B
            : revision,
    }));
    materializeSoftwareMapAtRef.mockImplementation(async ({ ref }) => {
      const mapPath = path.join(mapRoot, `${ref}-software-map.ts`);
      await mkdir(mapRoot, { recursive: true });
      await writeFileSync(mapPath, "export {};\n");
      return mapPath;
    });

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };

    const scan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    await scan.ensureReviewDocumentFresh("/codex-archived");

    materializeSoftwareMapAtRef.mockClear();

    const warmRun =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    await warmRun.ensureReviewDocumentFresh("/codex-archived");
    expect(materializeSoftwareMapAtRef).not.toHaveBeenCalled();
  });

  it("rescans a pinned route whose cached manifest has no materialized maps", async () => {
    const {
      resolveRevisionAsync,
      materializeSoftwareMapAtRef,
      collectReviewDocumentModule,
    } = await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-null-maps-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const mapRoot = path.join(dir, "maps");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));
    resolveRevisionAsync.mockImplementation(async (_repoRoot, revision) => ({
      commit:
        revision === HEAD_REF
          ? COMMIT_A
          : revision === BASE_REF
            ? COMMIT_B
            : revision,
    }));
    materializeSoftwareMapAtRef.mockResolvedValue(null);

    const input = { reviewPath, reviewDocumentsDir, reviewRootPath: dir };
    const first =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    expect(first.activeEntry?.headSoftwareMapPath).toBeNull();
    expect(first.activeEntry?.baseSoftwareMapPath).toBeNull();

    materializeSoftwareMapAtRef.mockImplementation(async ({ ref, role }) => {
      const mapPath = path.join(mapRoot, `${ref}-${role}-software-map.ts`);
      await mkdir(mapRoot, { recursive: true });
      await writeFile(mapPath, "export {};\n");
      return mapPath;
    });
    materializeSoftwareMapAtRef.mockClear();

    const second =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    expect(materializeSoftwareMapAtRef).toHaveBeenCalledTimes(2);
    expect(second.activeEntry?.headSoftwareMapPath).toContain(
      `${COMMIT_A}-head-software-map.ts`,
    );
    expect(second.activeEntry?.baseSoftwareMapPath).toContain(
      `${COMMIT_B}-base-software-map.ts`,
    );
  });

  it("rescans a cached route when artifacts are missing", async () => {
    const {
      resolveRevisionAsync,
      materializeSoftwareMapAtRef,
      collectReviewDocumentModule,
    } = await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(
      path.join(tmpdir(), "review-doc-missing-artifacts-"),
    );
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const mapRoot = path.join(dir, "maps");

    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));
    writeFileSync(
      archivedReviewPath,
      reviewDocSourceWithPinnedRefs("Archived Review"),
    );
    resolveRevisionAsync.mockImplementation(async (_repoRoot, revision) => ({
      commit:
        revision === HEAD_REF
          ? COMMIT_A
          : revision === BASE_REF
            ? COMMIT_B
            : revision,
    }));
    materializeSoftwareMapAtRef.mockImplementation(async ({ ref }) => {
      const mapPath = path.join(mapRoot, `${ref}-software-map.ts`);
      await mkdir(mapRoot, { recursive: true });
      await writeFileSync(mapPath, "export {};\n");
      return mapPath;
    });

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };

    const scan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );
    const ensureResult =
      await scan.ensureReviewDocumentFresh("/codex-archived");
    expect(ensureResult.shouldInvalidateModule).toBe(true);

    const stalePaths = ensureResult.softwareMapPaths;
    for (const mapPath of stalePaths) {
      if (mapPath) {
        await rm(mapPath, { force: true });
      }
    }

    resolveRevisionAsync.mockClear();
    materializeSoftwareMapAtRef.mockClear();

    const rerunResult = await scan.ensureReviewDocumentFresh("/codex-archived");
    expect(rerunResult.shouldInvalidateModule).toBe(true);
    expect(materializeSoftwareMapAtRef).toHaveBeenCalled();
  });

  it("falls back to file metadata when the active scan rejects", async () => {
    const { materializeSoftwareMapAtRef, collectReviewDocumentModule } =
      await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-active-reject-"));
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));

    materializeSoftwareMapAtRef.mockRejectedValue(
      new Error("active scan failure"),
    );

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };
    const scan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );

    expect(scan.activeEntry?.headSoftwareMapPath).toBeNull();
  });

  it("coalesces concurrent ensure calls for the same cached route", async () => {
    vi.stubEnv("DEV_FAST_REVIEW_DOCUMENT_SCAN_CONCURRENCY", "1");

    const {
      collectReviewDocumentModule,
      resolveRevisionAsync,
      materializeSoftwareMapAtRef,
    } = await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(
      path.join(tmpdir(), "review-doc-concurrent-ensure-"),
    );
    stubDevReviewHome(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const mapRoot = path.join(dir, "maps");

    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, reviewDocSourceWithPinnedRefs("Current Review"));
    writeFileSync(
      archivedReviewPath,
      reviewDocSourceWithPinnedRefs("Archived Review"),
    );

    materializeSoftwareMapAtRef.mockImplementation(async ({ ref }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return path.join(mapRoot, `${ref}-software-map.ts`);
    });

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };
    const scan =
      await collectReviewDocumentModule.collectReviewDocumentScanForRuntime(
        input,
      );

    materializeSoftwareMapAtRef.mockClear();
    resolveRevisionAsync.mockClear();

    await Promise.all([
      scan.ensureReviewDocumentFresh("/codex-archived"),
      scan.ensureReviewDocumentFresh("/codex-archived"),
      scan.ensureReviewDocumentFresh("/codex-archived"),
    ]);

    expect(resolveRevisionAsync).not.toHaveBeenCalled();
    expect(materializeSoftwareMapAtRef).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });
  it("reuses one full document scan across module consumers", async () => {
    const { collectReviewDocumentModule } =
      await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-scan-cache-"));
    writeReviewStore(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const archivedReviewPath = path.join(
      reviewDocumentsDir,
      "codex-archived.mdx",
    );
    const prReviewPath = path.join(reviewDocumentsDir, "pr-123.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, ["# Current Review"].join("\n"));
    writeFileSync(archivedReviewPath, ["# Archived Review"].join("\n"));
    writeFileSync(prReviewPath, ["# PR Review"].join("\n"));

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };

    collectReviewDocumentModule.collectReviewDocumentSourceRoots(input);
    collectReviewDocumentModule.collectReviewDocumentSoftwareMapPaths(input);

    expect(currentHeadSync).not.toHaveBeenCalled();
    expect(defaultBaseSync).not.toHaveBeenCalled();

    collectReviewDocumentModule.collectReviewDocumentSourceRoots(input);
    collectReviewDocumentModule.collectReviewDocumentSoftwareMapPaths(input);

    expect(currentHeadSync).not.toHaveBeenCalled();
    expect(defaultBaseSync).not.toHaveBeenCalled();
  });

  it("keeps the active module pinned when an inactive document is added", async () => {
    const { collectReviewDocumentModule } =
      await loadReviewDocumentModuleWithMockedVcs();

    const dir = mkdtempSync(path.join(tmpdir(), "review-doc-scan-invalidate-"));
    writeReviewStore(dir);
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const currentDir = path.join(reviewDocumentsDir, "current");
    const reviewPath = path.join(currentDir, "review.mdx");
    const reviewFixture = path.join(reviewDocumentsDir, "codex-archived.mdx");
    const reviewDocPath = path.join(reviewDocumentsDir, "pr-123.mdx");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(reviewPath, ["# Current Review"].join("\n"));
    writeFileSync(reviewFixture, ["# Archived Review"].join("\n"));

    const input = {
      reviewPath,
      reviewDocumentsDir,
      reviewRootPath: dir,
    };

    const initialSource =
      await collectReviewDocumentModule.generateActiveReviewDocumentModule({
        ...input,
        activeRoutePath: "/",
      });
    expect(initialSource).toContain(toVitePath(reviewPath));
    expect(initialSource).not.toContain(toVitePath(reviewFixture));
    expect(initialSource).toContain("reviews/current/review.mdx");

    writeFileSync(reviewDocPath, ["# New PR Review"].join("\n"));

    const changedSource =
      await collectReviewDocumentModule.generateActiveReviewDocumentModule({
        ...input,
        activeRoutePath: "/",
      });
    expect(changedSource).toContain(toVitePath(reviewPath));
    expect(changedSource).not.toContain(toVitePath(reviewDocPath));
  });
});

function writeTempMdx(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-doc-title-"));
  const filePath = path.join(dir, "review.mdx");
  writeFileSync(filePath, source);
  return filePath;
}

function reviewDocSourceWithPinnedRefs(title: string): string {
  return ["export const comments = {};", "", `# ${title}`].join("\n");
}

type ReviewDocumentModuleExports = typeof import("./review-documents-module");

async function loadReviewDocumentModuleWithMockedVcs(): Promise<{
  collectReviewDocumentModule: ReviewDocumentModuleExports;
  currentHeadSync: ReturnType<typeof vi.fn>;
  defaultBaseSync: ReturnType<typeof vi.fn>;
  currentHeadAsync: ReturnType<typeof vi.fn>;
  resolveRevisionAsync: ReturnType<typeof vi.fn>;
  defaultBaseAsync: ReturnType<typeof vi.fn>;
  materializeSoftwareMapAtRef: ReturnType<typeof vi.fn>;
}> {
  currentHeadSync.mockReturnValue({ commit: "abcdef" });
  defaultBaseSync.mockReturnValue({ commit: "base" });
  currentHeadSync.mockClear();
  defaultBaseSync.mockClear();
  currentHeadAsync.mockResolvedValue({ commit: "abcdef" });
  resolveRevisionAsync.mockResolvedValue({ commit: "rev" });
  defaultBaseAsync.mockResolvedValue({ commit: "base" });
  currentHeadAsync.mockClear();
  resolveRevisionAsync.mockClear();
  defaultBaseAsync.mockClear();
  materializeSoftwareMapAtRef.mockClear();
  materializeSoftwareMapAtRefSync.mockClear();
  ensureRepoSoftwareMapArtifacts.mockClear();

  vi.resetModules();
  const localVcsMockFactory = async () => {
    const actual = await vi.importActual<typeof import("@dev.fast/local-vcs")>(
      "@dev.fast/local-vcs",
    );
    return {
      ...actual,
      currentHeadSync,
      defaultBaseSync,
      currentHead: currentHeadAsync,
      resolveRevision: resolveRevisionAsync,
      defaultBase: defaultBaseAsync,
    };
  };
  // The Review Vitest config resolves local-vcs from source so another
  // package's build cannot briefly remove its dist entrypoint. Register both
  // IDs because hosted Vite can normalize the alias before applying doMock.
  vi.doMock("@dev.fast/local-vcs", localVcsMockFactory);
  vi.doMock(LOCAL_VCS_SOURCE_MODULE_ID, localVcsMockFactory);
  vi.doMock("../software-map-artifact", async () => {
    const actual = await vi.importActual<
      typeof import("../software-map-artifact")
    >("../software-map-artifact");
    return {
      ...actual,
      ensureRepoSoftwareMapArtifacts,
      materializeSoftwareMapAtRefSync,
      materializeSoftwareMapAtRef,
    };
  });
  const collectReviewDocumentModule = await import("./review-documents-module");

  return {
    collectReviewDocumentModule,
    currentHeadSync,
    defaultBaseSync,
    currentHeadAsync,
    resolveRevisionAsync,
    defaultBaseAsync,
    materializeSoftwareMapAtRef,
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function stubDevReviewHome(rootPath: string): void {
  vi.stubEnv("DEV_REVIEW_HOME", path.join(rootPath, ".dev-home"));
  writeReviewStore(rootPath);
}

function writeReviewStore(
  rootPath: string,
  options: { baseCommit?: string; sourceCommit?: string | null } = {},
): void {
  writeFileSync(
    path.join(rootPath, "review.json"),
    JSON.stringify({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "test-repo",
      worktreePath: rootPath,
      baseRef: "main",
      baseCommit: options.baseCommit ?? COMMIT_B,
      sourceCommit: options.sourceCommit ?? COMMIT_A,
      sourceIdentity: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "Test Review",
      sourceSession: "disabled:review",
      status: "awaiting-review",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
    }),
    "utf8",
  );
}

function modelImportPath(
  rootPath: string,
  fromPath: string,
  modelFileName: string,
) {
  const relative = path.relative(
    path.dirname(fromPath),
    path.join(rootPath, "packages", "progressive-review", "src", modelFileName),
  );
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function toVitePath(filePath: string) {
  return `/@fs/${filePath.split(path.sep).join("/")}`;
}
