import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);
const approvedFixtures = [
  {
    name: "schema4-opencode-agentserver",
    uuid: "87d4fa3d-0b20-44ee-9fc3-736cd7c72cbf",
    repository: "devdotfast/review",
    baseCommit: "9243adcfcdeba20c247ed3930a0f1a4f0676976e",
    sourceCommit: "7feca67370cdb24cd8e58d09afc1d3c11ffef261",
  },
  {
    name: "schema4-bug-report-dialog",
    uuid: "7fa9af80-0f16-4652-b4ac-fe2fde5e4b9b",
    repository: "devdotfast/review",
    baseCommit: "c87b5f3a0bee20d6d40370167baf0267d86d43e9",
    sourceCommit: "0c0d7943dcb451eda89621ef2c9965269dfeb040",
  },
  {
    name: "schema4-three-minute-tour",
    uuid: "cbf0bb69-9413-418b-8afe-c641bb6eecd6",
    repository: "tutorial-sample",
    baseCommit: "0f226b82647a7f6819c341527c304c2f63e81616",
    sourceCommit: "1f872164ec94ca87d99ca3ccbd2b452d487a0db0",
  },
];
const [reviewDir, name, sourceRepository] = process.argv.slice(2);
const approved = approvedFixtures.find(
  (fixture) => fixture.name === name && fixture.repository === sourceRepository,
);
if (!reviewDir || !approved) {
  throw new Error(
    "usage: capture-legacy-review-fixture <approved reviewDir> <approved name> <devdotfast/review|tutorial-sample>",
  );
}
const sourceDir = await realpath(reviewDir);
const record = JSON.parse(
  await readFile(path.join(sourceDir, "review.json"), "utf8"),
);
if (
  record.uuid !== approved.uuid ||
  record.schemaVersion !== 4 ||
  record.baseCommit !== approved.baseCommit ||
  record.sourceCommit !== approved.sourceCommit
) {
  throw new Error(
    "Review does not match the approved legacy fixture provenance.",
  );
}
if (sourceRepository === "devdotfast/review") {
  const { stdout } = await execFilePromise("git", [
    "-C",
    record.worktreePath,
    "remote",
    "get-url",
    "origin",
  ]);
  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/)devdotfast\/review(?:\.git)?$/.test(
      stdout.trim(),
    )
  ) {
    throw new Error("Fixture source repository is not devdotfast/review.");
  }
} else if (
  (await realpath(record.worktreePath)) !==
  (await realpath(path.join(os.homedir(), ".dev/tutorial/sample-service")))
) {
  throw new Error("Fixture source is not the approved tutorial sample.");
}
const fixturesRoot = path.resolve(
  import.meta.dirname,
  "../src/fixtures/legacy-reviews",
);
const excluded = new Set([
  ".build",
  ".native-agent",
  ".mutation-lock",
  "review.db-shm",
]);
const staging = await mkdtemp(path.join(os.tmpdir(), "legacy-fixture-"));
try {
  const copy = path.join(staging, "review");
  await cp(sourceDir, copy, {
    recursive: true,
    filter: async (source) => {
      const relative = path.relative(sourceDir, source);
      if (
        relative
          .split(path.sep)
          .some((part) => excluded.has(part) || part.endsWith(".lock"))
      )
        return false;
      if ((await lstat(source)).isSymbolicLink())
        throw new Error("Fixture capture does not accept symlinks.");
      return true;
    },
  });
  await writeFile(
    path.join(copy, "review.json"),
    `${JSON.stringify({ ...record, worktreePath: "<worktree>" }, null, 2)}\n`,
  );
  const archive = path.join(staging, `${name}.tgz`);
  await execFilePromise("tar", ["-czf", archive, "-C", copy, "."]);
  const size = (await stat(archive)).size;
  if (size >= 1_000_000)
    throw new Error(`Fixture exceeds the 1 MB limit (${size} bytes).`);
  await mkdir(fixturesRoot, { recursive: true });
  await cp(archive, path.join(fixturesRoot, `${name}.tgz`));
  await writeFile(
    path.join(fixturesRoot, `${name}.json`),
    `${JSON.stringify({ name, sourceUuid: record.uuid, schemaVersion: record.schemaVersion, hasMap: Boolean(record.presentedSoftwareMapRevision), baseCommit: record.baseCommit, sourceCommit: record.sourceCommit, sourceRepository }, null, 2)}\n`,
  );
  console.log(
    `captured ${name}: schema ${record.schemaVersion}, ${size} bytes`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
