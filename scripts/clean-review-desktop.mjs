import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function cleanTargets({
  root = monorepoRoot,
  reviewHome = process.env.DEV_REVIEW_HOME ?? resolve(process.env.HOME, ".dev"),
} = {}) {
  const checkout = resolve(root, "apps/review-desktop/code-oss");
  return [
    resolve(checkout, ".build"),
    resolve(checkout, "out"),
    resolve(checkout, "node_modules"),
    resolve(checkout, "extensions/node_modules"),
    resolve(checkout, "src/vs/review/common/reviewProtocol.ts"),
    resolve(reviewHome, "review-desktop/state"),
  ];
}

export async function cleanReviewDesktop(options) {
  const targets = cleanTargets(options);
  for (const target of targets) {
    if (!existsSync(target)) {
      console.log(`Already clean: ${target}`);
      continue;
    }
    await rm(target, { recursive: true, force: true });
    console.log(`Removed: ${target}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await cleanReviewDesktop();
}
