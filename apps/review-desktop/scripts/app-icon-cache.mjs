import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Include both inputs and installed outputs: a changed channel, restored bundle,
// missing asset, or changed plist/signature must invalidate the previous success.
export function iconCacheKey({ appPath, iconName, channel, inputs }) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({ iconName, channel, appPath: path.resolve(appPath) }),
  );

  function visit(file, metadataOnly = false) {
    hash.update(JSON.stringify(file));
    let stat;

    try {
      stat = statSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing");

      return;
    }

    if (metadataOnly) {
      hash.update(
        JSON.stringify([
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
        ]),
      );
    }

    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort())
        visit(path.join(file, name), metadataOnly);
    } else if (!metadataOnly) {
      hash.update(readFileSync(file));
    }
  }

  for (const input of inputs) visit(input);
  const contents = path.join(appPath, "Contents");
  // Executables can be large; identity and modification metadata detect replacement
  // without reading the Electron binary on every launch.
  visit(path.join(contents, "MacOS"), true);
  visit(path.join(contents, "Info.plist"));
  visit(path.join(contents, "_CodeSignature", "CodeResources"));
  const resources = path.join(contents, "Resources");
  visit(path.join(resources, "Assets.car"));

  for (const name of readdirSync(resources).sort()) {
    if (name.endsWith(".icns")) visit(path.join(resources, name));
  }

  return hash.digest("hex");
}

export function readIconCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).key;
  } catch {
    return undefined;
  }
}

export function writeIconCache(file, key) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ key }) + "\n");
  renameSync(temporary, file);
}
