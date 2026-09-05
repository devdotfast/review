import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { remoteNotesRef, writeNote } from "@dev.fast/local-vcs";
import { afterEach, describe, expect, it } from "vitest";

import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  createReviewDir,
  materializeReviewRevision,
  sealReviewCandidate,
} from "./review-home";
import { runReviewRepair } from "./review-repair";
import { prepareReviewRepair } from "./review-repair-preparation";
import { fingerprintReviewRepairInputs } from "./review-repair-state";
import { SOFTWARE_MAP_NOTES_REF } from "./review-storage";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(legacy = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-repair-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.com"],
    ["commit", "--allow-empty", "-m", "Initial"],
  ])
    execFileSync("git", args, { cwd: source, stdio: "ignore" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  const stored = await createReviewDir({
    reviewsHomePath: path.join(root, "home"),
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  if (legacy) {
    const bundle = path.join(stored.dir, ".bundle/document");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      path.join(bundle, "manifest.json"),
      JSON.stringify({ version: 1 }),
    );
    await writeFile(
      path.join(bundle, "review-document.js"),
      'import {createActiveReviewDocument,jsx} from "review-doc-runtime"; export default createActiveReviewDocument({title:"Sealed",routePath:"/",filePath:"review.mdx",models:{},modelNames:[],Component:()=>jsx("h1",{children:"Sealed"}),isDefault:true});',
    );
  } else
    await writeReviewDocumentBundle(
      stored.dir,
      bundleReviewDocument({
        format: "review-document/1",
        title: "Ready",
        routePath: "/",
        sourcePath: "review.mdx",
        body: [],
        anchors: {},
        anchorContents: {},
        softwareModels: [],
      }),
    );
  const revision = await sealReviewCandidate(stored.dir, "Presented");
  const record = {
    ...stored.review,
    schemaVersion: legacy ? 4 : 5,
    status: "accepted",
    presentedDocumentRevision: revision,
    dismissedAt: "2026-09-01T00:00:00.000Z",
  };
  await writeFile(path.join(stored.dir, "review.json"), JSON.stringify(record));
  return { ...stored, record, revision };
}

describe("prepareReviewRepair", () => {
  it.skipIf(process.platform === "win32")(
    "rejects internal special files before copying or reading them",
    async () => {
      const stored = await fixture(true);
      const recordBefore = await readFile(path.join(stored.dir, "review.json"));
      const refsBefore = execFileSync("git", ["show-ref"], {
        cwd: stored.dir,
        encoding: "utf8",
      });
      execFileSync("mkfifo", [path.join(stored.dir, ".bundle", "pipe")]);
      await expect(
        prepareReviewRepair({ reviewDir: stored.dir }),
      ).rejects.toThrow(/Repair internal.*special file/);
      expect(await readFile(path.join(stored.dir, "review.json"))).toEqual(
        recordBefore,
      );
      expect(
        execFileSync("git", ["show-ref"], {
          cwd: stored.dir,
          encoding: "utf8",
        }),
      ).toBe(refsBefore);
    },
  );
  it("allows legitimate authoring symlinks outside writable internal trees", async () => {
    const stored = await fixture();
    const source = path.join(path.dirname(stored.dir), "shared-data.ts");
    await writeFile(source, "export const shared = true;\n");
    await rm(path.join(stored.dir, "data.ts"));
    await symlink(source, path.join(stored.dir, "data.ts"));
    expect((await prepareReviewRepair({ reviewDir: stored.dir })).kind).toBe(
      "noop",
    );
    expect(await readFile(source, "utf8")).toBe(
      "export const shared = true;\n",
    );
  });
  it.each([".bundle/document", ".git/index"])(
    "rejects internal %s symlinks before touching their external targets",
    async (relative) => {
      const stored = await fixture(true);
      const external = await mkdtemp(
        path.join(os.tmpdir(), "review-repair-external-"),
      );
      roots.push(external);
      const target =
        relative === ".git/index" ? path.join(external, "index") : external;
      const marker =
        relative === ".git/index" ? target : path.join(target, "manifest.json");
      const originalBytes =
        relative === ".git/index"
          ? await readFile(path.join(stored.dir, relative))
          : Buffer.from("External bytes must not change");
      await writeFile(marker, originalBytes);
      await rm(path.join(stored.dir, relative), {
        recursive: true,
        force: true,
      });
      await symlink(target, path.join(stored.dir, relative));
      const before = await fingerprintReviewRepairInputs(stored.dir);
      await expect(
        prepareReviewRepair({ reviewDir: stored.dir }).then(async (result) => {
          if (result.kind === "prepared") await result.cleanup();
          return result;
        }),
      ).rejects.toThrow(/Repair internal.*symbolic link/);
      expect(await readFile(marker)).toEqual(originalBytes);
      expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
    },
  );
  it("repairs from validated remote saved map notes without backfilling source refs", async () => {
    const stored = await fixture();
    await writeNote({
      rootPath: stored.review.worktreePath,
      ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
      commit: stored.review.sourceCommit!,
      content:
        'import {defineSoftwareMap} from "@dev.fast/progressive-review/software-map-model"; export default defineSoftwareMap({systems:{app:{label:"App"}}});',
    });
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: "e".repeat(40),
      }),
    );
    const refs = () =>
      execFileSync("git", ["show-ref"], {
        cwd: stored.review.worktreePath,
        encoding: "utf8",
      });
    const before = refs();
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    if (result.kind !== "prepared")
      throw new Error("Expected map notes repair");
    try {
      expect(result.request.newDocumentRevision).toBe(stored.revision);
      expect(result.request.sourceFallback).toEqual({
        document: false,
        map: true,
      });
      expect(refs()).toBe(before);
    } finally {
      await result.cleanup();
    }
  });
  it("rejects contradictory sealed map pins instead of selecting one", async () => {
    const stored = await fixture();
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    await writeReviewSoftwareMapBundle(
      stored.dir,
      bundleReviewSoftwareMap({
        base: model,
        head: model,
        baseCommit: stored.review.baseCommit,
        headCommit: "d".repeat(40),
      }),
    );
    const mapRevision = await sealReviewCandidate(
      stored.dir,
      "Contradictory map pins",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/contradict/);
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });
  it("returns a healthy no-op without changing a terminal review", async () => {
    const stored = await fixture();
    const before = await readFile(path.join(stored.dir, "review.json"), "utf8");
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    expect(result.kind).toBe("noop");
    expect(await readFile(path.join(stored.dir, "review.json"), "utf8")).toBe(
      before,
    );
  });
  it("converts a sealed terminal document in isolation without editable inputs", async () => {
    const stored = await fixture(true);
    await rm(path.join(stored.dir, "review.mdx"));
    await rm(path.join(stored.dir, "data.ts"));
    const before = await readFile(path.join(stored.dir, "review.json"), "utf8");
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("Expected repair");
    try {
      expect(result.request.newDocumentRevision).not.toBe(stored.revision);
      expect(result.request.sourceFallback).toEqual({
        document: false,
        map: false,
      });
      const staged = JSON.parse(
        await readFile(
          path.join(result.request.stagingDir, "review.json"),
          "utf8",
        ),
      );
      expect(staged).toMatchObject({
        status: "accepted",
        dismissedAt: stored.record.dismissedAt,
        schemaVersion: 5,
      });
      expect(await readFile(path.join(stored.dir, "review.json"), "utf8")).toBe(
        before,
      );
    } finally {
      await result.cleanup();
    }
  });
  it("directs an unpresented draft to publish", async () => {
    const stored = await fixture();
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        status: "draft",
        presentedDocumentRevision: null,
      }),
    );
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/publish/);
  });
  it("uses editable sources only after sealed conversion fails and preserves the real candidate", async () => {
    const stored = await fixture(true);
    await writeFile(
      path.join(stored.dir, ".bundle/document/review-document.js"),
      "broken javascript",
    );
    const revision = await sealReviewCandidate(
      stored.dir,
      "Broken current artifact",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({ ...stored.record, presentedDocumentRevision: revision }),
    );
    await writeFile(
      path.join(stored.dir, "review.mdx"),
      "# Repaired presentation\n",
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    const warnings: string[] = [];
    const result = await prepareReviewRepair({
      reviewDir: stored.dir,
      warning: (message) => warnings.push(message),
    });
    if (result.kind !== "prepared") throw new Error("Expected repair");
    try {
      expect(result.request.sourceFallback.document).toBe(true);
      expect(warnings.join(" ")).toContain("semantic equivalence");
      expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
    } finally {
      await result.cleanup();
    }
  });
  it("reports missing sealed and editable inputs without changing private state", async () => {
    const stored = await fixture(true);
    await rm(path.join(stored.dir, "review.mdx"));
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedDocumentRevision: "f".repeat(40),
      }),
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(
      `Missing editable Review input: ${path.join(stored.dir, "review.mdx")}`,
    );
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });
  it("keeps an independent valid map pointer during document conversion", async () => {
    const stored = await fixture(true);
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    await writeReviewSoftwareMapBundle(
      stored.dir,
      bundleReviewSoftwareMap({
        head: model,
        base: model,
        headCommit: stored.review.sourceCommit!,
        baseCommit: stored.review.baseCommit,
      }),
    );
    const mapRevision = await sealReviewCandidate(
      stored.dir,
      "Independent JSON map",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    if (result.kind !== "prepared") throw new Error("Expected repair");
    try {
      expect(result.request.newMapRevision).toBe(mapRevision);
    } finally {
      await result.cleanup();
    }
  });
  it("requires an explicit UUID before looking up a review", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    expect(await runReviewRepair({ stdout, stderr: stdout, json: true })).toBe(
      1,
    );
    expect(output).toContain("explicit UUID");
  });
  it("repairs only a legacy map while preserving the healthy document pointer", async () => {
    const stored = await fixture();
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const mapDir = path.join(stored.dir, ".bundle/software-map");
    await mkdir(mapDir, { recursive: true });
    await writeFile(
      path.join(mapDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        headCommit: "c".repeat(40),
        baseCommit: stored.review.baseCommit,
      }),
    );
    const code = `const elements = ${JSON.stringify(model.elements)}; const relationships = ${JSON.stringify(model.relationships)}; const elementsByPath = new Map(elements.map(element => [element.path, element])); export default {elements,relationships,elementsByPath};`;
    await writeFile(path.join(mapDir, "head-map.js"), code);
    await writeFile(path.join(mapDir, "base-map.js"), code);
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({ ...stored.record, sourceCommit: "c".repeat(40) }),
    );
    const mapRevision = await sealReviewCandidate(
      stored.dir,
      "Legacy map only",
    );
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: mapRevision,
      }),
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    if (result.kind !== "prepared") throw new Error("Expected repair");
    try {
      expect(result.request.newDocumentRevision).toBe(stored.revision);
      expect(result.request.newMapRevision).not.toBe(mapRevision);
      const sealedMap = path.join(
        result.request.stagingDir,
        ".build/map-verification",
      );
      await materializeReviewRevision(
        result.request.stagingDir,
        result.request.newMapRevision!,
        sealedMap,
      );
      expect(
        JSON.parse(await readFile(path.join(sealedMap, "review.json"), "utf8"))
          .sourceCommit,
      ).toBe("c".repeat(40));
      expect(result.request.sourceFallback).toEqual({
        document: false,
        map: false,
      });
      expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
    } finally {
      await result.cleanup();
    }
  });
  it("does not promote a prepared document when a broken map has no saved notes", async () => {
    const stored = await fixture(true);
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({
        ...stored.record,
        presentedSoftwareMapRevision: "e".repeat(40),
      }),
    );
    const before = await fingerprintReviewRepairInputs(stored.dir);
    await expect(
      prepareReviewRepair({ reviewDir: stored.dir }),
    ).rejects.toThrow(/Software map repair failed/);
    expect(await fingerprintReviewRepairInputs(stored.dir)).toBe(before);
  });
  it("prepares a metadata-only legacy upgrade without changing healthy JSON pointers", async () => {
    const stored = await fixture();
    await writeFile(
      path.join(stored.dir, "review.json"),
      JSON.stringify({ ...stored.record, schemaVersion: 4 }),
    );
    const result = await prepareReviewRepair({ reviewDir: stored.dir });
    if (result.kind !== "prepared") throw new Error("Expected metadata repair");
    try {
      expect(result.request.newDocumentRevision).toBe(stored.revision);
      expect(result.request.newMapRevision).toBeNull();
      expect(
        JSON.parse(
          await readFile(
            path.join(result.request.stagingDir, "review.json"),
            "utf8",
          ),
        ).schemaVersion,
      ).toBe(5);
    } finally {
      await result.cleanup();
    }
  });
});
