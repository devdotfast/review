import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalMark = await readFile(
  new URL(
    "../../../packages/progressive-review/app/icons/dev-fast.icon/Assets/review-slashes-1024.svg",
    import.meta.url,
  ),
  "utf8",
);
const reviewStyles = await readFile(
  new URL(
    "../code-oss/src/vs/review/browser/media/review.css",
    import.meta.url,
  ),
  "utf8",
);
const themedAssets = await Promise.all(
  ["light", "dark", "hc-light", "hc-dark"].map(async (theme) => ({
    theme,
    source: await readFile(
      new URL(
        `../code-oss/src/vs/review/browser/media/review-letterpress-${theme}.svg`,
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

test("routes each Code OSS theme to a Review-owned watermark", () => {
  for (const { theme } of themedAssets) {
    assert.match(
      reviewStyles,
      new RegExp(
        `background-image:\\s*url\\("\\./review-letterpress-${theme}\\.svg"\\)`,
      ),
      theme,
    );
  }
  assert.match(reviewStyles, /\.monaco-workbench\.vs-dark/);
  assert.match(reviewStyles, /\.monaco-workbench\.hc-light/);
  assert.match(reviewStyles, /\.monaco-workbench\.hc-black/);
});

test("keeps the watermark visible when Review hides the empty editor part", () => {
  const noMainEditorSelectors = [
    [".monaco-workbench.review-workbench.nomaineditorarea", "light"],
    [".monaco-workbench.review-workbench.nomaineditorarea.vs-dark", "dark"],
    [
      ".monaco-workbench.review-workbench.nomaineditorarea.hc-light",
      "hc-light",
    ],
    [".monaco-workbench.review-workbench.nomaineditorarea.hc-black", "hc-dark"],
  ];

  for (const [selector, theme] of noMainEditorSelectors) {
    assert.match(
      reviewStyles,
      new RegExp(
        `${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*background-image:\\s*url\\("\\./review-letterpress-${theme}\\.svg"\\)`,
        "s",
      ),
      theme,
    );
  }

  assert.match(reviewStyles, /background-position:\s*center/);
  assert.match(reviewStyles, /background-repeat:\s*no-repeat/);
  assert.match(reviewStyles, /background-size:\s*260px 260px/);
});
