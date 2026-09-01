import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../../.github/workflows/review-desktop-preview.yml",
  ),
  "utf8",
);

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = nextName
    ? workflow.indexOf(`  ${nextName}:`, start + 1)
    : workflow.length;
  assert.notEqual(start, -1, `${name} job is missing`);
  assert.notEqual(end, -1, `${nextName} job is missing`);
  return workflow.slice(start, end);
}

test("preview downstream jobs pin the commit resolved by versioning", () => {
  const version = job("version", "compile");
  const compile = job("compile", "build");
  const build = job("build");

  assert.match(version, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(version, /commit=\$COMMIT/);

  for (const downstream of [compile, build]) {
    assert.match(
      downstream,
      /ref: \$\{\{ needs\.version\.outputs\.commit \}\}/,
    );
    assert.doesNotMatch(downstream, /ref: \$\{\{ inputs\.ref \}\}/);
  }
});

test("preview publishing preserves a distinct installer identity", () => {
  const build = job("build");

  assert.match(
    build,
    /DMG_DISPOSITION="attachment; filename=\\"df-review-preview-\$\{RELEASE_VERSION\}\.dmg\\""/,
  );
  assert.match(build, /https:\/\/install\.dev\.fast\/preview/);
  assert.match(
    build,
    /https:\/\/install\.dev\.fast\/releases\/preview-latest\/darwin-arm64\/Review\.dmg/,
  );
  assert.match(
    build,
    /name: review-desktop-preview-\$\{\{ env\.RELEASE_VERSION \}\}-dmg/,
  );
  assert.doesNotMatch(build, /curl[^\n]*https:\/\/install\.dev\.fast\/$/m);
});
