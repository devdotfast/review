import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalMark = await readFile(
  new URL(
    "../../../packages/whiteboard/app/icons/dev-fast.icon/Assets/review-slashes-1024.svg",
    import.meta.url,
  ),
  "utf8",
);

const themedAssets = await Promise.all(
  ["light", "dark", "hc-light", "hc-dark"].map(async (theme) => ({
    theme,
    source: await readFile(
      new URL(
        `../code-oss/src/vs/whiteboard/browser/media/whiteboard-letterpress-${theme}.svg`,
        import.meta.url,
      ),
      "utf8",
    ),
  })),
);

const extractPathData = (source) =>
  [...source.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);

test("uses the canonical two-slash geometry for every watermark theme", () => {
  const canonicalPaths = extractPathData(canonicalMark);
  assert.equal(canonicalPaths.length, 2);

  for (const { theme, source } of themedAssets) {
    assert.deepEqual(extractPathData(source), canonicalPaths, theme);
    assert.match(source, /viewBox="0 0 1024 1024"/, theme);
    assert.doesNotMatch(source, /<rect\b/i, theme);
    assert.doesNotMatch(source, /#2b4fe0/i, theme);
  }
});
