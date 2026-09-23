import * as fs from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * File system calls for paths inside a user's checkout. Electron's `fs`
 * treats every `*.asar` path as an archive, so a checkout that merely
 * contains one fails with "Invalid package" or shows it as a directory.
 * Electron's unpatched `original-fs` reads it as the plain file it is.
 */
export const checkoutFs: typeof fs = process.versions.electron
  ? // SAFETY: Electron's original-fs is Node's fs module without the asar patch.
    (createRequire(import.meta.url)("original-fs") as typeof import("node:fs"))
      .promises
  : fs;
