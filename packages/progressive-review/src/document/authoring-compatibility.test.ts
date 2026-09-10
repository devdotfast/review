import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { runReviewInternalTest } from "../review-internal-test";
import { authoringSpecifiers } from "./authoring-environment";
import { buildReviewDocument } from "./build";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string, helpers: Record<string, string> = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "review-authoring-compatibility-"),
  );
  roots.push(root);
  for (const [name, contents] of Object.entries({
    "review.mdx": source,
    ...helpers,
  })) {
    const filename = path.join(root, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  return {
    root,
    reviewPath: path.join(root, "review.mdx"),
    ranges: "skip" as const,
  };
}

it("erases ordinary type imports in MDX and transitive helpers while retaining value imports", async () => {
  const input = await fixture(
    [
      'import { Label, type Extra } from "./types.ts";',
      'import { content, Box } from "./data.js";',
      "export const label: Label = { value: content };",
      'export const extra: Extra = "extra";',
      "",
      "# Types and values",
      "",
      "{label.value} {new Box().value} {extra}",
    ].join("\n"),
    {
      "types.ts":
        'throw new Error("type-only module was executed"); export interface Label { value: string }; export type Extra = string;',
      "data.ts":
        'import { Label } from "./types.ts"; export { Box } from "./values.ts"; const label: Label = { value: "typed helper" }; export const content = label.value;',
      "values.ts": 'export class Box { value = "runtime class"; }',
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("typed helper");
  expect(JSON.stringify(built.document)).toContain("runtime class");
});

it("elides a direct MDX type reexport without executing its source module", async () => {
  const input = await fixture(
    'export { Label as PublicLabel } from "./types.ts";\n\n# Type exports\n',
    {
      "types.ts":
        'throw new Error("type module executed"); export interface Label { value: string; }',
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(built.document?.title).toBe("Type exports");
});

it("elides a local renamed type export and its now-unused import", async () => {
  const input = await fixture(
    'import { content } from "./data.ts";\n\n# Local type export\n\n{content}\n',
    {
      "types.ts":
        'throw new Error("type module executed"); export interface Label { value: string; }',
      "data.ts":
        'import { Label as LocalLabel } from "./types.ts"; export { LocalLabel as PublicLabel }; export const content = "local export preserved";',
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("local export preserved");
});

it("retains mixed transitive value exports, side effects and unused anchors through a symlink", async () => {
  const input = await fixture(
    'import { content, anchors } from "./data.js";\n\n# Transitive type exports\n\n{content}\n',
    {
      "effect.ts": 'throw new Error("mixed export side effect ran");',
      "values.ts": [
        'import "./effect.ts";',
        'import { defineAnchors } from "@dev.fast/review/authoring";',
        "export interface Label { value: string; }",
        'export const content = "transitive value preserved";',
        'export const anchors = defineAnchors({unused: { title: "Unused reexported anchor" }});',
      ].join("\n"),
      "barrel.ts":
        'export { Label as Renamed, content as label, anchors } from "./values.ts";',
      "data.ts":
        'export { Renamed as PublicLabel, label as content, anchors } from "./barrel.ts";',
    },
  );
  const aliasRoot = await mkdtemp(
    path.join(os.tmpdir(), "review-reexport-symlink-"),
  );
  roots.push(aliasRoot);
  await symlink(input.root, path.join(aliasRoot, "linked"));
  const linked = {
    ...input,
    reviewPath: path.join(aliasRoot, "linked", "review.mdx"),
  };
  expect((await buildReviewDocument(linked)).errors.join("\n")).toContain(
    "mixed export side effect ran",
  );
  await writeFile(path.join(input.root, "effect.ts"), "export {};\n");
  const built = await buildReviewDocument(linked);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain(
    "transitive value preserved",
  );
  expect(built.document?.anchors.unused.title).toBe("Unused reexported anchor");
});

it("keeps a class exported through a type-only alias out of runtime captures", async () => {
  const input = await fixture(
    'import { Box, content } from "./data.ts";\nexport const value: Box | null = null;\n\n# Type alias chain\n\n{content}\n',
    {
      "values.ts":
        'throw new Error("type-only class executed"); export class Box { value = 1; }',
      "types.ts": 'export type { Box as HiddenBox } from "./values.ts";',
      "data.ts":
        'export { HiddenBox as Box } from "./types.ts"; export const content = "type alias chain preserved";',
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain(
    "type alias chain preserved",
  );
});

it("keeps syntax diagnostics after a type reexport at their authored columns", async () => {
  const helper = 'export { Label } from "./types.ts"; export const value = ;';
  const input = await fixture(
    'import { value } from "./data.ts";\n\n# Invalid helper\n\n{value}\n',
    {
      "types.ts": "export interface Label { value: string; }",
      "data.ts": helper,
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.document).toBeNull();
  expect(built.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "TS1109",
      filePath: path.join(input.root, "data.ts"),
      line: 1,
      column: helper.lastIndexOf(";") + 1,
    }),
  );
});

it("executes explicit side-effect imports and keeps unused imported anchors", async () => {
  const input = await fixture(
    'import "./effect.ts";\nimport { anchors } from "./data.ts";\n\n# Retained values\n',
    {
      "effect.ts": 'throw new Error("explicit side effect ran");',
      "data.ts":
        'import { defineAnchors } from "@dev.fast/review/authoring"; export const anchors = defineAnchors({unused: { title: "Unused anchor" }});',
    },
  );
  expect((await buildReviewDocument(input)).errors.join("\n")).toContain(
    "explicit side effect ran",
  );
  await writeFile(path.join(input.root, "effect.ts"), "export {};\n");
  const built = await buildReviewDocument(input);
  expect(built.errors).toEqual([]);
  expect(built.document?.anchors.unused.title).toBe("Unused anchor");
});

it.each([
  ["js", "ts", 'export const content: string = "source helper";'],
  ["js", "tsx", "export const content = <strong>source helper</strong>;"],
  ["jsx", "tsx", "export const content = <strong>source helper</strong>;"],
  ["mjs", "mts", 'export const content: string = "source helper";'],
  ["cjs", "cts", 'export const content: string = "source helper";'],
])(
  "resolves .%s imports to .%s authored sources",
  async (specifier, extension, source) => {
    const input = await fixture(
      `import { content } from "./helper.${specifier}";\n\n# Extension substitution\n\n{content}\n`,
      {
        [`helper.${extension}`]: source,
      },
    );
    const built = await buildReviewDocument(input);
    expect(built.diagnostics).toEqual([]);
    expect(built.errors).toEqual([]);
    expect(JSON.stringify(built.document)).toContain("source helper");
  },
);

it("prefers an existing JavaScript file over a TypeScript replacement", async () => {
  const input = await fixture(
    'import { content } from "./helper.js";\n\n# File precedence\n\n{content}\n',
    {
      "helper.js": 'export const content = "existing javascript";',
      "helper.ts": 'export const content = "typescript fallback";',
    },
  );
  const built = await buildReviewDocument(input);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("existing javascript");
  expect(JSON.stringify(built.document)).not.toContain("typescript fallback");
});

it.each([false, true])(
  "internal-test checks helper semantics even when imported=%s",
  async (imported) => {
    const input = await fixture(
      imported
        ? 'import { value } from "./helper.ts";\n\n# Helper checks\n\n{value}\n'
        : "# Helper checks\n",
      {
        "helper.ts":
          'export const unused: number = "invalid"; export const value = "valid content";',
      },
    );
    const published = await buildReviewDocument(input);
    expect(published.errors).toEqual([]);
    expect(published.diagnostics).toEqual([]);
    expect(published.document).not.toBeNull();
    await expect(runReviewInternalTest(input.root)).rejects.toThrow(
      /helper\.ts:1:\d+ TS2322/,
    );
    await writeFile(
      path.join(input.root, "helper.ts"),
      'export const unused: number = 1; export const value = "valid content";',
    );
    await expect(runReviewInternalTest(input.root)).resolves.toBeUndefined();
  },
);

it.each([false, true])(
  "internal-test checks nested helpers with relative path=%s",
  async (relative) => {
    const input = await fixture("# Nested helpers\n", {
      "data.ts": 'export { value } from "./nested/helper.ts";',
      "nested/helper.ts": 'export const value: number = "wrong";',
    });
    await expect(
      runReviewInternalTest(
        relative ? path.relative(process.cwd(), input.root) : input.root,
      ),
    ).rejects.toThrow(/nested\/helper\.ts:1:\d+ TS2322/);
  },
);

it.each(authoringSpecifiers)(
  "explains built-in component imports from %s",
  async (specifier) => {
    const input = await fixture(
      `import { CodePeek } from ${JSON.stringify(specifier)};\n\n# Component import\n`,
    );
    const built = await buildReviewDocument(input);
    expect(built.document).toBeNull();
    expect(built.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MDX_COMPONENT_IMPORT", line: 1 }),
    );
  },
);

it("preserves custom route paths in the published document", async () => {
  const built = await buildReviewDocument({
    ...(await fixture("# Routed\n")),
    routePath: "/details",
  });
  expect(built.document?.routePath).toBe("/details");
});
