import { detectLocalVcs, git } from "@dev.fast/local-vcs";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, "i");
const SOURCE_HEAD_REF_REGEX = new RegExp(
  `^refs/dev-fast/reviews/${UUID_PATTERN}/head$`,
  "i",
);

export function reviewSourceHeadRef(uuid: string): string {
  if (!UUID_REGEX.test(uuid)) {
    throw new Error(`Review UUID is invalid: ${uuid}`);
  }
  return `refs/dev-fast/reviews/${uuid}/head`;
}

/** Points a review's source head ref at a known commit. */
export async function pinReviewSourceHeadRef(
  cwd: string,
  targetRef: string,
  commit: string,
): Promise<void> {
  assertReviewSourceHeadRef(targetRef);
  const vcs = await detectLocalVcs(cwd);
  if (!vcs) throw new Error(`No Git or jj repository found at ${cwd}.`);
  await updateRef(vcs.rootPath, targetRef, commit);
}

export async function deleteReviewSourceHeadRef(
  cwd: string,
  targetRef: string,
): Promise<void> {
  assertReviewSourceHeadRef(targetRef);
  await git(cwd, ["update-ref", "-d", targetRef]);
}

async function updateRef(
  rootPath: string,
  targetRef: string,
  commit: string,
): Promise<void> {
  await git(rootPath, ["update-ref", targetRef, commit]);
}

function assertReviewSourceHeadRef(targetRef: string): void {
  if (!SOURCE_HEAD_REF_REGEX.test(targetRef)) {
    throw new Error(`Review source head ref is invalid: ${targetRef}`);
  }
}
