import assert from "node:assert/strict";
import test from "node:test";

import { findForeignSpecifiers } from "./check-bundle.mjs";

test("reports a package the bundler left external", () => {
  assert.deepEqual(findForeignSpecifiers('import x from "zod";'), ["zod"]);
});

test("reports a package a rewritten require call reaches", () => {
  assert.deepEqual(findForeignSpecifiers('var chalk = __require("chalk");'), [
    "chalk",
  ]);
});

test("allows builtins and relative chunks", () => {
  const source = [
    'var fs = __require("fs");',
    'import "node:path";',
    'import { chunk } from "./chunk.js";',
  ].join("\n");

  assert.deepEqual(findForeignSpecifiers(source), []);
});

test("ignores a type-only import that a template string holds", () => {
  const source =
    'var src = `import type { ExtensionAPI } from "@earendil-works/pi";`;';

  assert.deepEqual(findForeignSpecifiers(source), []);
});

test("ignores a package name a line comment holds", () => {
  const source = [
    '// The bundler inlines this, so nothing imports "chalk" at runtime.',
    'var value = 1; // require("lodash")',
    'import { chunk } from "./chunk.js";',
  ].join("\n");

  assert.deepEqual(findForeignSpecifiers(source), []);
});

test("keeps a specifier that follows a URL in the same line", () => {
  const source = 'var u = "https://example.com/x"; import "zod";';

  assert.deepEqual(findForeignSpecifiers(source), ["zod"]);
});
