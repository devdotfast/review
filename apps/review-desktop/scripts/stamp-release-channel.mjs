import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  assertReleaseChannel,
  releaseIdentityFor,
} from "./release-channel.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");

function replaceRequired(source, pattern, replacement, marker, file) {
  if (!pattern.test(source)) {
    throw new Error(`${marker} not found in ${file}`);
  }
  return source.replace(pattern, replacement);
}

export function stampReleaseChannel({
  version,
  quality = "stable",
  packagePath = path.join(APP_DIR, "package.json"),
  productPath = path.join(APP_DIR, "code-oss", "product.json"),
}) {
  if (!version) {
    throw new Error("version is required");
  }
  assertReleaseChannel(quality);

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.version = version;

  const product = readFileSync(productPath, "utf8");
  const fields = {
    reviewVersion: version,
    quality,
    ...releaseIdentityFor(quality),
  };
  let stampedProduct = product;
  for (const [field, value] of Object.entries(fields)) {
    stampedProduct = replaceRequired(
      stampedProduct,
      new RegExp(`("${field}":\\s*")[^"]*(")`),
      `$1${value}$2`,
      field,
      productPath,
    );
  }

  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(productPath, stampedProduct);
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      quality: { type: "string", default: "stable" },
    },
  });

  if (!values.version) {
    console.error(
      "usage: stamp-release-channel.mjs --version <semver> [--quality stable|preview]",
    );
    process.exit(2);
  }

  stampReleaseChannel({
    version: values.version,
    quality: values.quality,
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
