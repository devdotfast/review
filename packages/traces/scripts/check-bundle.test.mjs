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
