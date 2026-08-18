function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function hasRenderedInlineEditors(
  snapshot,
  { expectedCount, expectedText },
) {
  return (
    snapshot?.count === expectedCount &&
    snapshot.lineCount > 0 &&
    snapshot.durationCount === expectedCount &&
    snapshot.nativeMultiDiffCount === expectedCount &&
    snapshot.nativeDiffCount === expectedCount &&
    Array.isArray(snapshot.renderedText) &&
    snapshot.renderedText.length === expectedCount &&
    snapshot.renderedText.every((text) =>
      text.replace(/\s+/g, " ").includes(expectedText),
    ) &&
    Array.isArray(snapshot.sizing) &&
    snapshot.sizing.length === expectedCount &&
    snapshot.sizing.every(
      ({ bodyHeight, entryHeight }) =>
        bodyHeight > 0 &&
        entryHeight > 0 &&
        Math.abs(bodyHeight - entryHeight) <= 2,
    )
  );
}

export async function waitForInlineEditorRendering({
  readSnapshot,
  expectedCount,
  expectedText,
  timeoutMs,
  intervalMs = 100,
}) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;

  do {
    snapshot = await readSnapshot();
    if (hasRenderedInlineEditors(snapshot, { expectedCount, expectedText })) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      return snapshot;
    }
    await delay(intervalMs);
  } while (Date.now() < deadline);

  return snapshot;
}
