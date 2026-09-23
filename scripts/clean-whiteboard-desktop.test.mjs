import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanTargets, cleanWhiteboardDesktop } from "./clean-whiteboard-desktop.mjs";

test("cleans generated Desktop artifacts but preserves authored Whiteboards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-desktop-clean-"));
  const whiteboardHome = path.join(root, "whiteboard-home");
  const targets = cleanTargets({ root, whiteboardHome });

  const authoredWhiteboard = path.join(
    whiteboardHome,
    "reviews",
    "example",
    "review.mdx",
  );

  for (const target of targets) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "generated"), "generated");
  }

  await mkdir(path.dirname(authoredWhiteboard), { recursive: true });
  await writeFile(authoredWhiteboard, "# Review");

  await cleanWhiteboardDesktop({ root, whiteboardHome });

  for (const target of targets) {
    assert.equal(await exists(target), false, `${target} should be removed`);
  }

  assert.equal(await exists(authoredWhiteboard), true);
});

test("cleanTargets removes the generated protocol overlay", () => {
  const targets = cleanTargets({ root: "/repo", whiteboardHome: "/home/x/.dev" });
  assert.ok(
    targets.includes(
      "/repo/apps/whiteboard-desktop/code-oss/src/vs/whiteboard/common/whiteboardProtocol.ts",
    ),
  );
});

async function exists(target) {
  try {
    await import("node:fs/promises").then(({ access }) => access(target));

    return true;
  } catch {
    return false;
  }
}
