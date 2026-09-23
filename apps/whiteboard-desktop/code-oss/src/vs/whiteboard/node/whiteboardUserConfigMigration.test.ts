import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { parse } from "../../base/common/json.js";
import { migrateWhiteboardUserConfig } from "./whiteboardUserConfigMigration.js";

test("upgrades default and named profiles without losing disabled flags, user bindings or comments", () => {
  const root = mkdtempSync(path.join(tmpdir(), "whiteboard-settings-"));
  try {
    for (const profile of ["User", "User/profiles/custom"]) {
      const dir = path.join(root, profile);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "settings.json"),
        '{\n // keep my note\n "review.experimental.structuralDiff.enabled": false, "review.keymap": "vim", "whiteboard.keymap": "emacs", "workbench.colorTheme": "Review Dark", "editor.fontSize": 17\n}',
      );
      writeFileSync(
        path.join(dir, "keybindings.json"),
        '[{"key":"ctrl+k","command":"review.openSettings"},{"key":"ctrl+x","command":"-review.openSharedReview"},{"key":"ctrl+j","command":"other.command"}]',
      );
    }
    migrateWhiteboardUserConfig(root);
    const first = readFileSync(path.join(root, "User/settings.json"), "utf8");
    migrateWhiteboardUserConfig(root);
    assert.equal(
      readFileSync(path.join(root, "User/settings.json"), "utf8"),
      first,
    );
    for (const profile of ["User", "User/profiles/custom"]) {
      const dir = path.join(root, profile);
      const text = readFileSync(path.join(dir, "settings.json"), "utf8");
      assert.match(text, /keep my note/);
      assert.deepEqual(parse(text), {
        "whiteboard.experimental.structuralDiff.enabled": false,
        "whiteboard.keymap": "emacs",
        "workbench.colorTheme": "Whiteboard Dark",
        "editor.fontSize": 17,
      });
      assert.deepEqual(
        parse(readFileSync(path.join(dir, "keybindings.json"), "utf8")).map(
          (v: { command: string }) => v.command,
        ),
        [
          "whiteboard.openSettings",
          "-whiteboard.openSharedSession",
          "other.command",
        ],
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
