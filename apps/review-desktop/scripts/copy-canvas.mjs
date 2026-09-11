import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const monorepoRoot = path.resolve(appDirectory, "../..");
const sourceRoot = path.join(
  monorepoRoot,
  "packages/progressive-review/app/dist/desktop",
);

export function canvasTargets(args, appRoot = appDirectory) {
  const targets = [path.join(appRoot, "code-oss/out/vs/review/canvas")];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--packaged-root" || !args[index + 1]) {
      throw new Error(
        "usage: copy-canvas.mjs [--packaged-root <packaged-app-root>]",
      );
    }
    const packagedRoot = path.resolve(args[++index]);
    if (packagedRoot === path.parse(packagedRoot).root) {
      throw new Error("The packaged Review root cannot be a filesystem root.");
    }
    // A macOS bundle nests its resources under Contents/; every other platform
    // puts them at the package root.
    const packagedAppRoot = packagedRoot.endsWith(".app")
      ? path.join(packagedRoot, "Contents/Resources/app")
      : path.join(packagedRoot, "resources/app");
    targets.push(path.join(packagedAppRoot, "out/vs/review/canvas"));
  }
  return [...new Set(targets)];
}

export async function copyCanvas(targets = canvasTargets([])) {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, ".vite/manifest.json"), "utf8"),
  );
  const canvas = requiredEntry(manifest, "canvas");
  const stylesheets = canvas.css ?? [];
  const wasm = (canvas.assets ?? []).find((file) => file.endsWith(".wasm"));
  if (!wasm)
    throw new Error("Review canvas manifest has no libavoid WASM asset.");

  for (const targetRoot of targets) {
    const outputRoot = path.resolve(targetRoot, "../../..");
    const relativeTarget = path.relative(outputRoot, targetRoot);
    const isDevelopmentOutput =
      outputRoot === path.join(appDirectory, "code-oss/out");
    if (
      relativeTarget !== path.join("vs", "review", "canvas") ||
      (!(await isDirectory(outputRoot)) && !isDevelopmentOutput)
    ) {
      throw new Error(
        `Refusing to replace canvas outside an existing output root: ${targetRoot}`,
      );
    }
    if (isDevelopmentOutput) await mkdir(outputRoot, { recursive: true });
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    await cp(path.join(sourceRoot, "assets"), path.join(targetRoot, "assets"), {
      recursive: true,
    });
    await writeFile(
      path.join(targetRoot, "canvas-loader.js"),
      canvasLoaderSource({
        canvasFile: canvas.file,
        wasmFile: wasm,
        stylesheets,
      }),
    );
  }
}

export function canvasLoaderSource({ canvasFile, wasmFile, stylesheets }) {
  return [
    `export { clearReviewViewState, mountReviewCanvas } from ${JSON.stringify(`./${canvasFile}`)};`,
    `export const reviewWasmUrl = new URL(${JSON.stringify(`./${wasmFile}`)}, import.meta.url).href;`,
    `export const reviewStylesheetUrls = ${JSON.stringify(stylesheets.map((file) => `./${file}`))}.map(file => new URL(file, import.meta.url).href);`,
    "",
  ].join("\n");
}

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function requiredEntry(entries, name) {
  const entry = Object.values(entries).find(
    (candidate) => candidate.isEntry && candidate.name === name,
  );
  if (!entry) throw new Error(`Review canvas manifest has no ${name} entry.`);
  return entry;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await copyCanvas(canvasTargets(process.argv.slice(2)));
}
