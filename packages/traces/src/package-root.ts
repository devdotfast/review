import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const packageManifestSchema = z.object({ version: z.string().min(1) });

/** The version field of the package.json under `packageRoot`. */
export async function readPackageVersion(packageRoot: string): Promise<string> {
  const text = await readFile(path.join(packageRoot, "package.json"), "utf8");

  return packageManifestSchema.parse(JSON.parse(text)).version;
}
