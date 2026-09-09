import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { installDirectory } from "./install-directory";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["existing", "interrupted"])(
  "restores the complete %s skill when the staged replacement cannot be renamed",
  async (state) => {
    root = await mkdtemp(path.join(tmpdir(), "review-skill-rollback-"));
    const source = path.join(root, "runtime", "dev-review");
    const old = path.join(root, "skills", "dev-review");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "new content");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "SKILL.md"), "old content");
    await writeFile(path.join(old, "reference.txt"), "old reference");
    if (state === "interrupted")
      await rename(
        old,
        path.join(path.dirname(old), ".dev-review.review-previous"),
      );
    const failPromotion: typeof rename = async (from, to) => {
      if (to === old && String(from).endsWith(".review-staging"))
        throw new Error("Injected replacement failure");
      await rename(from, to);
    };
    await expect(installDirectory(source, old, failPromotion)).rejects.toThrow(
      "Injected replacement failure",
    );
    expect(await readFile(path.join(old, "SKILL.md"), "utf8")).toBe(
      "old content",
    );
    expect(await readFile(path.join(old, "reference.txt"), "utf8")).toBe(
      "old reference",
    );
    expect(await readdir(path.dirname(old))).toEqual(["dev-review"]);
    await installDirectory(source, old);
    expect(await readFile(path.join(old, "SKILL.md"), "utf8")).toBe(
      "new content",
    );
  },
);
