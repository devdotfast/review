import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it } from "vitest";

import { reviewTestAliases } from "../../test-config.js";

// Desktop hosts the review server in Electron, whose `fs` differs from Node's.
// CI builds this binary before the package tests run.
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const electronRoot = path.join(
  packageRoot,
  "../../apps/review-desktop/code-oss/.build/electron",
);

const electron =
  process.env.REVIEW_TEST_ELECTRON ||
  [
    path.join(electronRoot, "Whiteboard.app/Contents/MacOS/Whiteboard"),
    path.join(electronRoot, "review"),
  ].find((candidate) => existsSync(candidate));

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-electron-worktree-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it.skipIf(!electron && !process.env.CI)(
  "creates a worktree review in Electron for a checkout that contains a .asar file",
  async () => {
    expect(
      electron,
      "build Review Desktop or set REVIEW_TEST_ELECTRON",
    ).toBeTruthy();

    const repository = path.join(directory, "repository");
    mkdirSync(repository);

    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository });

    git("init", "-q");
    // Not an archive: a fixture of the kind language-server test suites carry.
    writeFileSync(path.join(repository, "fixture.asar"), "plain bytes\n");
    writeFileSync(path.join(repository, "index.ts"), "export {};\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Base",
    );
    writeFileSync(path.join(repository, "index.ts"), "export const x = 1;\n");

    const tsconfig = path.join(directory, "tsconfig.json");

    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          paths: Object.fromEntries(
            Object.entries(reviewTestAliases).map(([name, file]) => [
              name,
              [file],
            ]),
          ),
        },
      }),
    );

    const script = path.join(directory, "create.mts");

    writeFileSync(
      script,
      `
import { randomUUID } from "node:crypto";
import { openLocalReviewStore } from ${JSON.stringify(path.join(packageRoot, "src/review-api/local-data.ts"))};

const local = openLocalReviewStore(${JSON.stringify(path.join(directory, "reviews.db"))});

try {
  const { id } = await local.data.register(${JSON.stringify(repository)});
  const { reviewId } = await local.store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Working copy",
      target: { kind: "worktree", repositoryId: id },
    },
  });
  const pins = local.store.read(reviewId).pins;

  console.log(JSON.stringify({
    fixture: (await local.data.file(pins, "head", "fixture.asar")).text,
    tree: await local.data.tree(pins, "head", ""),
  }));
} finally {
  await local.store.close();
  await local.data.close();
}
`,
    );

    const { stdout } = await promisify(execFile)(
      electron!,
      ["--import", "tsx", script],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DEV_REVIEW_HOME: directory,
          TSX_TSCONFIG_PATH: tsconfig,
        },
      },
    );

    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);

    expect(result.fixture).toBe("plain bytes\n");
    expect(result.tree).toContainEqual({ path: "fixture.asar", kind: "file" });
  },
  60_000,
);
