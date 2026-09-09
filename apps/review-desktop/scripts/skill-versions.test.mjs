import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stampReviewSkills } from "./stage-review-runtime.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceSkills = path.resolve(
  appRoot,
  "../../packages/progressive-review/skills",
);

test("stamps all packaged skills with the Desktop release, preserving source hardlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-stamp-skills-"));
  try {
    const runtime = path.join(root, "runtime");
    await cp(sourceSkills, path.join(runtime, "skills"), { recursive: true });
    const source = path.join(root, "source.md");
    const generated = path.join(runtime, "skills/dev-review/SKILL.md");
    const original = await readFile(generated, "utf8");
    await writeFile(source, original);
    await rm(generated);
    await link(source, generated);
    await stampReviewSkills(runtime);
    const { version } = JSON.parse(
      await readFile(path.join(appRoot, "package.json"), "utf8"),
    );
    for (const name of ["dev-review", "dev-review-map", "trace-archaeology"]) {
      const output = await readFile(
        path.join(runtime, "skills", name, "SKILL.md"),
        "utf8",
      );
      assert.ok(output.includes(`review-version: "${version}"`));
      assert.ok(output.includes('review-managed-by: "Review Desktop"'));
      assert.ok(output.includes("Do not edit."));
    }
    assert.equal(await readFile(source, "utf8"), original);
    await stampReviewSkills(runtime, "2.0.0-preview.1");
    assert.ok(
      (await readFile(generated, "utf8")).includes(
        'review-version: "2.0.0-preview.1"',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses invalid release versions and skills without generated metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-invalid-skill-"));
  try {
    await assert.rejects(
      stampReviewSkills(root, "not-a-version"),
      /release version/,
    );
    const skill = path.join(root, "skills/dev-review");
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: dev-review\ndescription: test\n---\n",
    );
    await assert.rejects(
      stampReviewSkills(root, "1.0.0"),
      /Missing generated skill metadata/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
