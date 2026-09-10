import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type HostBinding,
  type HostDocument,
  type HostDocumentState,
  HostDocumentValidationError,
  type HostMapVersion,
  type HostNode,
  type HostSourceQuote,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { patchChangedLines } from "../call-stack-diff";
import { validateHostDocumentEvidence } from "./document-evidence";
import {
  type EvidenceProvider,
  EvidenceProviderError,
  LocalEvidenceProvider,
} from "./evidence-provider";

const repositoryId = "00000000-0000-4000-8000-000000000001";
const mapVersionId = "00000000-0000-4000-8000-000000000002";
const traceId = "00000000-0000-4000-8000-000000000003";
const eventId = "00000000-0000-4000-8000-000000000004";
const assetId = "00000000-0000-4000-8000-000000000005";
const baseCommit = "a".repeat(40),
  headCommit = "b".repeat(40);
const at = "2026-09-10T00:00:00.000Z";
const binding: HostBinding = {
  id: "00000000-0000-4000-8000-000000000006",
  repositoryId,
  selector: { kind: "range", baseRef: baseCommit, headRef: headCommit },
  baseCommit,
  headCommit,
  createdAt: at,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const provider: EvidenceProvider = {
  async resolve(pins, range) {
    const text = `verified ${range.file}:${range.fromLine}-${range.toLine}`;
    return {
      span: {
        repositoryId: pins.repositoryId,
        commit: range.side === "base" ? pins.baseCommit : pins.headCommit,
        blob: "c".repeat(40),
        file: range.file,
        fromLine: range.fromLine,
        toLine: range.toLine,
      },
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  },
};
const unavailableProvider: EvidenceProvider = {
  async resolve() {
    throw new EvidenceProviderError(
      "DEPENDENCY_UNAVAILABLE",
      "Source is offline.",
    );
  },
};

describe("host document evidence", () => {
  it("keeps retained source available for unrelated edits and anchor-label changes", async () => {
    const document = sourceDocument();
    const accepted = await validateHostDocumentEvidence({
      document,
      binding,
      provider,
    });
    const previous = state(document, accepted.evidence);
    const proposed = structuredClone(document);
    proposed.definitions.Source = {
      ...proposed.definitions.Source!,
      title: "New label",
    } as HostDocument["definitions"][string];
    proposed.roots.push("Note");
    proposed.nodes.Note = {
      id: "Note",
      type: "markdown",
      markdown: "New explanation.",
    };

    const result = await validateHostDocumentEvidence({
      document: proposed,
      binding,
      previous,
      provider: unavailableProvider,
    });
    expect(result.evidence.Source).toBe(previous.evidence.Source);
    expect(result.affectedNodeIds).toEqual(["Peek", "Note"]);
    expect(document.definitions.Source).toMatchObject({ title: "Source" });
  });

  it("reresolves a changed source range instead of reusing stale evidence", async () => {
    const document = sourceDocument();
    const accepted = await validateHostDocumentEvidence({
      document,
      binding,
      provider,
    });
    const previous = state(document, accepted.evidence);
    const proposed = sourceDocument(2);
    await expect(
      validateHostDocumentEvidence({
        document: proposed,
        binding,
        previous,
        provider: unavailableProvider,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    const result = await validateHostDocumentEvidence({
      document: proposed,
      binding,
      previous,
      provider,
    });
    expect(result.evidence.Source?.span.fromLine).toBe(2);
    expect(previous.evidence.Source?.span.fromLine).toBe(1);
  });

  it.each(["base", "head", "repository"])(
    "does not reuse source across a changed %s binding",
    async (changed) => {
      const document = sourceDocument();
      const accepted = await validateHostDocumentEvidence({
        document,
        binding,
        provider,
      });
      const moved = { ...binding };
      if (changed === "base") moved.baseCommit = "d".repeat(40);
      if (changed === "head") moved.headCommit = "d".repeat(40);
      if (changed === "repository")
        moved.repositoryId = "00000000-0000-4000-8000-000000000099";
      await expect(
        validateHostDocumentEvidence({
          document,
          binding: moved,
          previous: state(document, accepted.evidence),
          provider: unavailableProvider,
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    },
  );

  it("drops evidence for deleted definitions and leaves the old version intact", async () => {
    const document = sourceDocument();
    const accepted = await validateHostDocumentEvidence({
      document,
      binding,
      provider,
    });
    const previous = state(document, accepted.evidence);
    const result = await validateHostDocumentEvidence({
      document: doc([]),
      binding,
      previous,
      provider: unavailableProvider,
    });
    expect(result.evidence).toEqual({});
    expect(previous.evidence.Source?.text).toBe("verified file.ts:1-1");
  });

  it("rejects broken JSON references before asking for source evidence", async () => {
    await expect(
      validateHostDocumentEvidence({
        document: doc([{ id: "Peek", type: "code_peek", anchorId: "Missing" }]),
        binding,
        provider: unavailableProvider,
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
  });

  it("rejects mismatched evidence returned by a provider", async () => {
    const wrongProvider: EvidenceProvider = {
      async resolve(pins, range) {
        return provider.resolve(pins, { ...range, fromLine: 2, toLine: 2 });
      },
    };
    await expect(
      validateHostDocumentEvidence({
        document: sourceDocument(),
        binding,
        provider: wrongProvider,
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
  });
});

describe("safe Markdown and GFM", () => {
  it("accepts ordinary GFM, escaped HTML, code samples and safe reference links", async () => {
    const markdown = [
      "# Heading",
      "",
      "- [x] done",
      "",
      "| A | B |",
      "| - | - |",
      "| one | two |",
      "",
      "[Read docs][docs], [mail](mailto:test@example.com), [heading](#heading).",
      "",
      "[docs]: https://example.com/docs",
      "",
      "&lt;script&gt; is text.",
      "",
      "```html",
      "<script>example only</script>",
      "```",
    ].join("\n");
    await expect(
      validateHostDocumentEvidence({
        document: doc([{ id: "Text", type: "markdown", markdown }]),
        binding,
        provider: unavailableProvider,
      }),
    ).resolves.toMatchObject({ affectedNodeIds: ["Text"], evidence: {} });
  });

  it.each([
    "<script>alert(1)</script>",
    "A <span>raw HTML</span> sentence",
    "<!-- hidden HTML -->",
    "![remote](https://example.com/image.png)",
    "![reference][image]\n\n[image]: https://example.com/image.png",
    "[unsafe](javascript:alert%281%29)",
    "[unsafe][target]\n\n[target]: javascript:alert%281%29",
    "[unused]: file:///private/source",
    "[local](../source)",
    "[custom](vscode://file/private)",
    "[encoded](javascript&#58;alert%281%29)",
  ])("rejects unsafe Markdown %j", async (markdown) => {
    await expect(
      validateHostDocumentEvidence({
        document: doc([{ id: "Text", type: "markdown", markdown }]),
        binding,
        provider: unavailableProvider,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      diagnostics: [expect.objectContaining({ path: "/nodes/Text/markdown" })],
    });
  });
});

describe("pinned call-stack evidence", () => {
  it("aligns stable frame IDs while preserving separate base/head anchors", async () => {
    const document = stackDocument("Same", "Same");
    await expect(
      validateHostDocumentEvidence({ document, binding, provider }),
    ).resolves.toMatchObject({ affectedNodeIds: ["Stack"] });
  });

  it("accepts reordered shared frames over unchanged code without a diff lookup", async () => {
    const document = stackDocument();
    document.nodes.Stack = {
      id: "Stack",
      type: "call_stack_diff",
      title: "Reordered stack",
      base: [
        { id: "Outer", anchorId: "Old" },
        { id: "Inner", anchorId: "Old" },
      ],
      head: [
        { id: "Inner", anchorId: "New" },
        { id: "Outer", anchorId: "New" },
      ],
    };
    const result = await validateHostDocumentEvidence({
      document,
      binding,
      provider,
    });
    expect(result.evidence.Old?.text).toBe(result.evidence.New?.text);
    expect(result.affectedNodeIds).toEqual(["Stack"]);
  });

  it("requires an actual diff source for added or removed frames", async () => {
    await expect(
      validateHostDocumentEvidence({
        document: stackDocument(),
        binding,
        provider,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("rejects claimed changes outside the anchored range", async () => {
    await expect(
      validateHostDocumentEvidence({
        document: stackDocument(),
        binding,
        provider,
        changedLines: () => ({ added: new Set([2]), deleted: new Set([2]) }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts honest added/deleted claims using real immutable Git evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-document-evidence-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    writeFileSync(path.join(root, "file.ts"), "header\noldCall();\n");
    const base = commit(root);
    writeFileSync(path.join(root, "file.ts"), "header\nnewCall();\n");
    const head = commit(root);
    const pins = { ...binding, baseCommit: base, headCommit: head };
    const document = stackDocument("Before", "After", 2);
    const result = await validateHostDocumentEvidence({
      document,
      binding: pins,
      provider: new LocalEvidenceProvider(() => root),
      changedLines: (observed, file) =>
        patchChangedLines(
          git(root, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            observed.baseCommit,
            observed.headCommit,
            "--",
            file,
          ]),
        ),
    });
    expect(result.evidence.Old?.text).toBe("oldCall();");
    expect(result.evidence.New?.text).toBe("newCall();");
  });

  it("revalidates unchanged stack nodes after moving the pins", async () => {
    const document = stackDocument();
    const accepted = await validateHostDocumentEvidence({
      document,
      binding,
      provider,
      changedLines: () => ({ added: new Set([1]), deleted: new Set([1]) }),
    });
    await expect(
      validateHostDocumentEvidence({
        document,
        binding: { ...binding, headCommit: "f".repeat(40) },
        previous: state(document, accepted.evidence),
        provider,
        changedLines: () => ({ added: new Set(), deleted: new Set() }),
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
  });
});

describe("retained resources", () => {
  const traceNode: HostNode = {
    id: "Quote",
    type: "trace_quote",
    traceId,
    eventId,
    text: "hello world",
  };

  it("matches quote whitespace against the exact retained event", async () => {
    await expect(
      validateHostDocumentEvidence({
        document: doc([traceNode]),
        binding,
        provider,
        resources: {
          traceEvent: () => ({
            id: eventId,
            traceId,
            text: "A hello\n  world statement.",
          }),
        },
      }),
    ).resolves.toMatchObject({ affectedNodeIds: ["Quote"] });
  });

  it.each(["unmatched", "wrong-event", "wrong-trace", "missing", "empty"])(
    "rejects %s trace evidence",
    async (kind) => {
      const node = {
        ...traceNode,
        text: kind === "empty" ? "   " : traceNode.text,
      };
      await expect(
        validateHostDocumentEvidence({
          document: doc([node]),
          binding,
          provider,
          resources: {
            traceEvent: () =>
              kind === "missing"
                ? undefined
                : {
                    id: kind === "wrong-event" ? assetId : eventId,
                    traceId: kind === "wrong-trace" ? assetId : traceId,
                    text:
                      kind === "unmatched" ? "something else" : "hello world",
                  },
          },
        }),
      ).rejects.toBeInstanceOf(HostDocumentValidationError);
    },
  );

  it("requires the scoped image asset to exist", async () => {
    const document = doc([
      { id: "Image", type: "image", assetId, alt: "An image" },
    ]);
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { asset: () => undefined },
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { asset: () => ({ id: assetId }) },
      }),
    ).resolves.toMatchObject({ affectedNodeIds: ["Image"] });
  });

  it("requires maps and actor references to identify existing elements at the exact pins", async () => {
    const document = doc([
      { id: "Map", type: "software_map", mapVersionId, focusElementId: "App" },
    ]);
    document.definitions.Actor = {
      kind: "actor",
      label: "Actor",
      mapElement: { mapVersionId, elementId: "App" },
    };
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { mapVersion: () => map() },
      }),
    ).resolves.toMatchObject({ affectedNodeIds: ["Map"] });
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { mapVersion: () => ({ ...map(), commit: "f".repeat(40) }) },
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { mapVersion: () => ({ ...map(), repositoryId: assetId }) },
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
    await expect(
      validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: { mapVersion: () => ({ ...map(), elements: {} }) },
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
  });

  it("rechecks an unchanged map reference after repin", async () => {
    const document = doc([{ id: "Map", type: "software_map", mapVersionId }]);
    await expect(
      validateHostDocumentEvidence({
        document,
        binding: { ...binding, headCommit: "f".repeat(40) },
        previous: state(document, {}),
        provider,
        resources: { mapVersion: () => map() },
      }),
    ).rejects.toBeInstanceOf(HostDocumentValidationError);
  });

  it("does not expose errors from a resource provider", async () => {
    const failure = validateHostDocumentEvidence({
      document: doc([traceNode]),
      binding,
      provider,
      resources: {
        traceEvent: () => {
          throw new Error("Private /Users/secret/transcript.jsonl");
        },
      },
    });
    await expect(failure).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "The referenced review evidence is unavailable.",
    });
    await expect(failure).rejects.not.toThrow("/Users/secret");
  });
});

function doc(nodes: HostNode[]): HostDocument {
  return {
    schemaVersion: 1,
    roots: nodes.map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    definitions: {},
  };
}

function sourceDocument(line = 1): HostDocument {
  const document = doc([{ id: "Peek", type: "code_peek", anchorId: "Source" }]);
  document.definitions.Source = {
    kind: "anchor",
    title: "Source",
    source: { side: "head", file: "file.ts", fromLine: line, toLine: line },
  };
  return document;
}

function stackDocument(
  baseId = "Before",
  headId = "After",
  line = 1,
): HostDocument {
  const document = doc([
    {
      id: "Stack",
      type: "call_stack_diff",
      title: "Stack",
      base: [{ id: baseId, anchorId: "Old" }],
      head: [{ id: headId, anchorId: "New" }],
    },
  ]);
  document.definitions.Old = {
    kind: "anchor",
    title: "Before",
    source: { side: "base", file: "file.ts", fromLine: line, toLine: line },
  };
  document.definitions.New = {
    kind: "anchor",
    title: "After",
    source: { side: "head", file: "file.ts", fromLine: line, toLine: line },
  };
  return document;
}

function state(
  document: HostDocument,
  evidence: Record<string, HostSourceQuote>,
): HostDocumentState {
  return {
    ...document,
    documentId: "00000000-0000-4000-8000-000000000007",
    reviewId: "00000000-0000-4000-8000-000000000008",
    version: 1,
    binding,
    contentHash: "e".repeat(64),
    createdAt: at,
    evidence,
  };
}

function map(): HostMapVersion {
  return {
    schemaVersion: 1,
    id: mapVersionId,
    mapId: "00000000-0000-4000-8000-000000000009",
    repositoryId,
    commit: headCommit,
    revision: 1,
    contentHash: "e".repeat(64),
    createdAt: at,
    elements: {
      App: {
        id: "App",
        parentId: null,
        label: "App",
        description: "",
        kind: "system",
        source: [],
      },
    },
    relationships: {},
  };
}

function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review-test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
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

function commit(root: string): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--no-verify", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}
