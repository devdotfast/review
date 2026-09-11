import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  HostBinding,
  HostDocumentState,
  HostSourceRange,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { proposeDocumentRepin } from "./document-repin";
import { LocalRepositorySource, resolveBinding } from "./local-repository";

const repositoryId = "00000000-0000-4000-8000-000000000001";
const temporary: string[] = [];
const lines = Array.from({ length: 20 }, (_, index) => `line${index + 1}();`);
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("conservative document repin proposals", () => {
  it("relocates a surviving range across a rename and insertion above it", async () => {
    const { root, binding, source } = await fixture();
    const original = document(binding, { head: range("head", 4, 5) });
    const retained = structuredClone(original);
    renameSync(path.join(root, "file.ts"), path.join(root, "renamed.ts"));
    writeFileSync(
      path.join(root, "renamed.ts"),
      ["intro();", ...lines].join("\n"),
    );
    commit(root);
    const nextBinding = await snapshot(root);
    const proposal = await proposeDocumentRepin({
      document: original,
      binding: nextBinding,
      source,
    });
    expect(proposal).toMatchObject({
      basedOnDocumentVersion: 7,
      binding: nextBinding,
      anchorChanges: [
        {
          id: "head",
          before: range("head", 4, 5),
          proposed: { ...range("head", 5, 6), file: "renamed.ts" },
          status: "relocated",
        },
      ],
      diagnostics: [],
      proposedDefinitions: {
        head: {
          kind: "anchor",
          title: "head",
          source: { ...range("head", 5, 6), file: "renamed.ts" },
        },
      },
    });
    expect(original).toEqual(retained);
    proposal.anchorChanges[0]!.before.file = "other.ts";
    proposal.binding.headCommit = "f".repeat(40);
    expect(original).toEqual(retained);
    expect(nextBinding.headCommit).not.toBe("f".repeat(40));
  });

  it("maps old base and head to their corresponding new pins independently", async () => {
    const { root, binding, source } = await fixture();
    const original = document(binding, {
      base: range("base", 4, 5),
      head: range("head", 4, 5),
    });
    writeFileSync(
      path.join(root, "file.ts"),
      ["first();", ...lines].join("\n"),
    );
    const nextBase = commit(root);
    writeFileSync(
      path.join(root, "file.ts"),
      ["second();", "first();", ...lines].join("\n"),
    );
    const nextHead = commit(root);
    const proposal = await proposeDocumentRepin({
      document: original,
      binding: await resolveBinding(repositoryId, root, {
        kind: "range",
        baseRef: nextBase,
        headRef: nextHead,
      }),
      source,
    });
    expect(proposal.anchorChanges).toEqual([
      {
        id: "base",
        before: range("base", 4, 5),
        proposed: range("base", 5, 6),
        status: "relocated",
      },
      {
        id: "head",
        before: range("head", 4, 5),
        proposed: range("head", 6, 7),
        status: "relocated",
      },
    ]);
  });

  it("keeps unchanged ranges exact, including a side whose pin did not move", async () => {
    const { root, binding, source } = await fixture();
    const original = document(binding, {
      base: range("base", 4, 5),
      head: range("head", 4, 5),
    });
    writeFileSync(path.join(root, "other.ts"), "new file\n");
    const nextHead = commit(root);
    const proposal = await proposeDocumentRepin({
      document: original,
      binding: await resolveBinding(repositoryId, root, {
        kind: "range",
        baseRef: binding.baseCommit,
        headRef: nextHead,
      }),
      source,
    });
    expect(proposal.anchorChanges.map(({ status }) => status)).toEqual([
      "exact",
      "exact",
    ]);
    expect(proposal.diagnostics).toEqual([]);
    expect(proposal.proposedDefinitions).toEqual(original.definitions);
  });

  it.each([
    ["edited", [...lines.slice(0, 3), "replacement();", ...lines.slice(4)]],
    ["deleted", [...lines.slice(0, 3), ...lines.slice(4)]],
    [
      "split by new content",
      [...lines.slice(0, 4), "inserted();", ...lines.slice(4)],
    ],
    [
      "moved elsewhere",
      [...lines.slice(0, 3), ...lines.slice(5), ...lines.slice(3, 5)],
    ],
  ])(
    "does not guess a replacement for a range that was %s",
    async (_label, nextLines) => {
      const { root, binding, source } = await fixture();
      const original = document(binding, { target: range("head", 4, 5) });
      const retained = structuredClone(original);
      writeFileSync(path.join(root, "file.ts"), nextLines.join("\n"));
      commit(root);
      const proposal = await proposeDocumentRepin({
        document: original,
        binding: await snapshot(root),
        source,
      });
      expect(proposal.anchorChanges).toEqual([
        {
          id: "target",
          before: range("head", 4, 5),
          proposed: null,
          status: "missing",
        },
      ]);
      expect(proposal.proposedDefinitions).toEqual({});
      expect(proposal.diagnostics).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "ANCHOR_REPIN_REQUIRED",
          definitionId: "target",
        }),
      ]);
      expect(original).toEqual(retained);
    },
  );

  it("reports a deleted source file without erasing its original target", async () => {
    const { root, binding, source } = await fixture();
    const original = document(binding, { target: range("head", 4, 5) });
    rmSync(path.join(root, "file.ts"));
    commit(root);
    const proposal = await proposeDocumentRepin({
      document: original,
      binding: await snapshot(root),
      source,
    });
    expect(proposal.anchorChanges).toEqual([
      {
        id: "target",
        before: range("head", 4, 5),
        proposed: null,
        status: "missing",
      },
    ]);
    expect(original.definitions.target).toEqual({
      kind: "anchor",
      title: "target",
      source: range("head", 4, 5),
    });
  });

  it("refuses to map a review into a different repository", async () => {
    const { binding, source } = await fixture();
    await expect(
      proposeDocumentRepin({
        document: document(binding, { target: range("head", 4, 5) }),
        binding: {
          ...binding,
          repositoryId: "00000000-0000-4000-8000-000000000002",
        },
        source,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

function range(
  side: "base" | "head",
  fromLine: number,
  toLine: number,
): HostSourceRange {
  return { side, file: "file.ts", fromLine, toLine };
}

function document(
  binding: HostBinding,
  anchors: Record<string, HostSourceRange>,
): HostDocumentState {
  return {
    schemaVersion: 1,
    reviewId: "00000000-0000-4000-8000-000000000020",
    reviewVersion: 7,
    binding,
    contentHash: "0".repeat(64),
    createdAt: binding.createdAt,
    roots: [],
    nodes: {},
    evidence: {},
    definitions: Object.fromEntries(
      Object.entries(anchors).map(([id, source]) => [
        id,
        { kind: "anchor", title: id, source },
      ]),
    ),
  };
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "review-host-repin-"));
  temporary.push(root);
  git(root, ["init", "--quiet"]);
  writeFileSync(path.join(root, "file.ts"), lines.join("\n"));
  commit(root);
  return {
    root,
    binding: await snapshot(root),
    source: new LocalRepositorySource(() => root),
  };
}

function snapshot(root: string): Promise<HostBinding> {
  return resolveBinding(repositoryId, root, { kind: "snapshot", ref: "HEAD" });
}

function commit(root: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}
