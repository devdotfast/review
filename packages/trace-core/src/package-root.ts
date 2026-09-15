import path from "node:path";
import { fileURLToPath } from "node:url";

/** Finds the package containing a source or bundled module URL. */
export function findPackageRoot(moduleUrl: string): string {
  const currentDir = path.dirname(fileURLToPath(moduleUrl));
  let candidate = currentDir;

  while (true) {
    const directoryName = path.basename(candidate);

    if (directoryName === "src" || directoryName === "dist") {
      return path.dirname(candidate);
    }

    const parent = path.dirname(candidate);

    if (parent === candidate) return currentDir;
    candidate = parent;
  }
}
