import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  statSync,
} from "node:fs";
import * as path from "node:path";

import {
  parse,
  parseTree,
  findNodeAtLocation,
  createScanner,
  SyntaxKind,
  type ParseError,
} from "../../base/common/json.js";
import { applyEdits, setProperty } from "../../base/common/jsonEdit.js";

// Historical names are accepted only while upgrading saved user configuration.
const renamed: Record<string, string> = {
  "review.toggleFileTree": "whiteboard.toggleFileTree",
  "review.openSettings": "whiteboard.openSettings",
  "review.openSharedReview": "whiteboard.openSharedSession",
  "review.update.instructions": "whiteboard.update.instructions",
  "review.update.restart": "whiteboard.update.restart",
  "review.update.skip": "whiteboard.update.skip",
  "review.checkForUpdates": "whiteboard.checkForUpdates",
  "review.openWelcome": "whiteboard.openWelcome",
  "review.openTutorial": "whiteboard.openTutorial",
  "review.installCliInPath": "whiteboard.installCliInPath",
  "review.uninstallApp": "whiteboard.uninstallApp",
  "review.selectTheme": "whiteboard.selectTheme",
  "review.about": "whiteboard.about",
  "review.setKeymap": "whiteboard.setKeymap",
  "review.manageExtensions": "whiteboard.manageExtensions",
  "review.importUserConfig": "whiteboard.importUserConfig",
  "review.action.find": "whiteboard.action.find",
  "review.keymap": "whiteboard.keymap",
  "review.telemetry.enabled": "whiteboard.telemetry.enabled",
  "review.experimental.structuralDiff.enabled":
    "whiteboard.experimental.structuralDiff.enabled",
  "review.experimental.softwareMap.enabled":
    "whiteboard.experimental.softwareMap.enabled",
};
const formatting = { insertSpaces: false, tabSize: 4, eol: "\n" };

function migrateFile(filename: string, bindings: boolean): void {
  if (!existsSync(filename)) return;
  const original = readFileSync(filename, "utf8");
  const errors: ParseError[] = [];
  const value = parse(original, errors);
  if (errors.length || !value || typeof value !== "object")
    throw new Error(`Cannot migrate invalid configuration: ${filename}`);
  let text = original;
  const edit = (location: (string | number)[], next: unknown) => {
    text = applyEdits(text, setProperty(text, location, next, formatting));
  };
  if (bindings) {
    if (!Array.isArray(value))
      throw new Error(`Expected keybinding list: ${filename}`);
    value.forEach((binding, index) => {
      if (typeof binding?.command !== "string") return;
      const negative = binding.command.startsWith("-");
      const command = negative ? binding.command.slice(1) : binding.command;
      if (renamed[command])
        edit([index, "command"], `${negative ? "-" : ""}${renamed[command]}`);
    });
  } else {
    if (Array.isArray(value))
      throw new Error(`Expected settings object: ${filename}`);
    for (const [before, after] of Object.entries(renamed)) {
      if (!Object.hasOwn(value, before)) continue;
      const property = findNodeAtLocation(parseTree(text), [before])!.parent!;
      const key = property.children![0];
      if (!Object.hasOwn(value, after)) {
        text =
          text.slice(0, key.offset) +
          JSON.stringify(after) +
          text.slice(key.offset + key.length);
      } else {
        // Delete only syntax tokens, retaining comments and whitespace around them.
        const scanner = createScanner(text);
        const removals: { offset: number; length: number }[] = [];
        let previousComma: { offset: number; length: number } | undefined;
        for (
          let token = scanner.scan();
          token !== SyntaxKind.EOF;
          token = scanner.scan()
        ) {
          const offset = scanner.getTokenOffset();
          const length = scanner.getTokenLength();
          if (offset < property.offset) {
            if (token === SyntaxKind.CommaToken)
              previousComma = { offset, length };
            continue;
          }
          if (offset >= property.offset + property.length) {
            if (
              token === SyntaxKind.Trivia ||
              token === SyntaxKind.LineBreakTrivia ||
              token === SyntaxKind.LineCommentTrivia ||
              token === SyntaxKind.BlockCommentTrivia
            )
              continue;
            if (token === SyntaxKind.CommaToken)
              removals.push({ offset, length });
            else if (previousComma) removals.push(previousComma);
            break;
          }
          if (token < SyntaxKind.LineCommentTrivia)
            removals.push({ offset, length });
        }
        for (const removal of removals.sort((a, b) => b.offset - a.offset))
          text =
            text.slice(0, removal.offset) +
            text.slice(removal.offset + removal.length);
      }
    }
    for (const key of [
      "workbench.colorTheme",
      "workbench.preferredDarkColorTheme",
      "workbench.preferredLightColorTheme",
    ]) {
      if (value[key] === "Review Dark") edit([key], "Whiteboard Dark");
      if (value[key] === "Review Light") edit([key], "Whiteboard Light");
    }
  }
  if (text === original) return;
  const temporary = `${filename}.whiteboard-${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: statSync(filename).mode });
  renameSync(temporary, filename);
}

/** Run before configuration/keybinding services load, including named profiles. */
export function migrateWhiteboardUserConfig(userDataPath: string): void {
  const user = path.join(userDataPath, "User");
  const profiles = path.join(user, "profiles");
  const directories = [user];
  if (existsSync(profiles))
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory())
        directories.push(path.join(profiles, entry.name));
    }
  for (const directory of directories) {
    migrateFile(path.join(directory, "settings.json"), false);
    migrateFile(path.join(directory, "keybindings.json"), true);
  }
}
