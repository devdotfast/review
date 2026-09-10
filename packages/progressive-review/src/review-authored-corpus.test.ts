import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseJsonText } from "@dev.fast/review-protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { hydrateReviewDocument } from "../app/src/review-document-hydrate";
import { reviewAuthoringPropsSchemas } from "./authoring";
import { patchChangedLines } from "./call-stack-diff";
import {
  type AuthoredReviewCase,
  authoredReviewCases,
} from "./fixtures/authored-reviews/cases";
import {
  extractLegacyReviewFixture,
  readLegacyReviewGolden,
} from "./fixtures/legacy-reviews/legacy-review-fixture";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  reviewDocumentBundleData,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  type ReviewDocumentData,
  type ReviewNode,
  reviewDocumentDataSchema,
  walkReviewNodes,
} from "./review-document-data";
import { createReviewDir } from "./review-home";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import { compileReviewDocumentBundle } from "./server/doc-bundler";

const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
const exercisedComponents = new Set<string>();
afterAll(() => {
  const missing = Object.keys(reviewAuthoringPropsSchemas).filter(
    (name) => !exercisedComponents.has(name),
  );
  if (missing.length > 0)
    throw new Error(
      `Authored MDX corpus does not exercise: ${missing.join(", ")}`,
    );
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, args: string[]) {
  return (
    await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Corpus Test",
        "-c",
        "user.email=corpus@example.test",
        ...args,
      ],
      { cwd, maxBuffer: 8 * 1024 * 1024 },
    )
  ).stdout;
}

async function prepare(input: AuthoredReviewCase) {
  const home = await mkdtemp(path.join(os.tmpdir(), "authored-review-corpus-"));
  roots.push(home);
  const evidence = {
    base: { sourceRootPath: path.join(home, "base") },
    head: { sourceRootPath: path.join(home, "head") },
  };
  let expected: ReviewDocumentData | undefined;
  let authoringDirectory: string;
  let files: Array<[source: string, destination: string]>;
  let baseCommit: string;
  let headCommit: string;
  let repository: string;

  if ("legacyFixture" in input.source) {
    const extracted = await extractLegacyReviewFixture(
      input.source.legacyFixture,
    );
    roots.push(extracted.home);
    const { metadata } = extracted;
    authoringDirectory = extracted.dir;
    expected = reviewDocumentDataSchema.parse(
      await readLegacyReviewGolden(metadata.name, "document"),
    );
    baseCommit = metadata.baseCommit;
    headCommit = metadata.sourceCommit;
    repository = packageRoot;
    files = [
      ["review.mdx", "review.mdx"],
      ["data.ts", "data.ts"],
    ];
    if (metadata.sourceRepository === "tutorial-sample")
      files.push([
        "authoring-conversation.json",
        "authoring-conversation.json",
      ]);
    for (const [graph, commit] of [
      ["base", baseCommit],
      ["head", headCommit],
    ] as const) {
      const sourceRoot = evidence[graph].sourceRootPath;
      await mkdir(sourceRoot, { recursive: true });
      if (metadata.sourceRepository === "tutorial-sample") {
        // The public archive contains authored files, not its source repo.
        // Validate its unchanged anchors against the shipped sample service.
        await cp(
          path.join(packageRoot, "tutorial/sample-service"),
          sourceRoot,
          { recursive: true },
        );
      } else {
        const referenced = new Set(
          Object.values(expected.anchors).flatMap((anchor) =>
            anchor.peek && (anchor.peek.props.graph ?? "head") === graph
              ? [anchor.peek.props.file]
              : [],
          ),
        );
        for (const file of referenced) {
          const content = await git(repository, ["show", `${commit}:${file}`]);
          const target = path.join(sourceRoot, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
      }
    }
  } else {
    authoringDirectory = path.join(packageRoot, input.source.directory);
    files = [
      [input.source.document ?? "review.mdx", "review.mdx"],
      ...Object.entries(input.source.helpers ?? {}),
    ];
    await cp(
      path.join(packageRoot, input.source.baseDirectory),
      evidence.base.sourceRootPath,
      { recursive: true },
    );
    await cp(evidence.base.sourceRootPath, evidence.head.sourceRootPath, {
      recursive: true,
    });
    repository = evidence.head.sourceRootPath;
    await git(repository, ["init", "-q", "-b", "main"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "Base", "--allow-empty"]);
    baseCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
    // Head directories are complete snapshots, including deleted base files.
    for (const name of (await git(repository, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean))
      await rm(path.join(repository, name));
    await cp(path.join(packageRoot, input.source.headDirectory), repository, {
      recursive: true,
    });
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-qm", "Head", "--allow-empty"]);
    headCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
  }
  const fresh = await createReviewDir({
    reviewsHomePath: path.join(home, "reviews"),
    worktreePath: evidence.head.sourceRootPath,
    baseRef: baseCommit,
    baseCommit,
    sourceCommit: headCommit,
    sourceIdentity: { kind: "git-branch", name: "corpus" },
  });
  for (const [source, destination] of files) {
    const target = path.join(fresh.dir, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(authoringDirectory, source), target, {
      recursive: true,
    });
  }
  return {
    dir: fresh.dir,
    evidence,
    expected,
    repository,
    baseCommit,
    headCommit,
  };
}

// All cases run the same real compiler/evaluator/storage/hydration pipeline.
// Archived Reviews additionally compare against independently committed
// migration goldens; reference documents declare their expected features.
describe.each(authoredReviewCases)("authored corpus $name", (input) => {
  it("preserves the document through compilation, storage, hydration and repeated evaluation", async () => {
    const fixture = await prepare(input);
    async function evaluate() {
      const compiled = await compileReviewDocumentBundle({
        reviewPath: path.join(fixture.dir, "review.mdx"),
        reviewDocumentsDir: path.join(fixture.dir, ".review-documents"),
        reviewRootPath: fixture.dir,
        routePath: "/",
      });
      expect(compiled.diagnostics).toEqual([]);
      if (!compiled.bundle) throw new Error("Corpus MDX did not compile");
      const evaluated = await evaluateReviewDocumentBundleForPublish({
        bundleCode: compiled.bundle.code,
        reviewDir: fixture.dir,
        prepareEvidence: async () => fixture.evidence,
        resolveChangedLines: async (file) =>
          patchChangedLines(
            await git(fixture.repository, [
              "diff",
              fixture.baseCommit,
              fixture.headCommit,
              "--",
              file,
            ]),
          ),
      });
      expect(evaluated.errors).toEqual([]);
      if (!evaluated.document)
        throw new Error("Corpus MDX did not materialize");
      return evaluated.document;
    }
    const document = await evaluate();
    expect(fixture.expected ? document : undefined).toEqual(fixture.expected);
    const nodes: ReviewNode[] = [];
    walkReviewNodes(document.body, (node) => {
      nodes.push(node);
      if (node.type === "component") exercisedComponents.add(node.name);
    });
    expect(
      [
        ...new Set(
          nodes
            .filter((node) => node.type === "component")
            .map((node) => node.name),
        ),
      ].sort(),
    ).toEqual([...input.components].sort());
    expect(
      [
        ...new Set(
          nodes
            .filter((node) => node.type === "element")
            .map((node) => node.tag),
        ),
      ].sort(),
    ).toEqual(expect.arrayContaining([...(input.proseTags ?? [])]));
    const text = nodes
      .filter((node) => node.type === "text")
      .map((node) => node.value)
      .join("");
    for (const fragment of input.text ?? []) expect(text).toContain(fragment);
    const bundle = bundleReviewDocument(document);
    await writeReviewDocumentBundle(fixture.dir, bundle);
    const stored = await readReviewDocumentBundle(fixture.dir, "/");
    expect(stored).toEqual(bundle);
    if (!stored) throw new Error("Corpus JSON was not stored");
    const hydrated = hydrateReviewDocument({
      state: "ready",
      contentHash: stored.contentHash,
      data: parseJsonText(JSON.stringify(reviewDocumentBundleData(stored))),
    });
    expect(hydrated.body).toHaveLength(document.body.length);
    expect(bundleReviewDocument(await evaluate()).contentHash).toBe(
      bundle.contentHash,
    );
  }, 60_000);
});
