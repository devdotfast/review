import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Callers hold the shared skill installer lock throughout the replacement. */
export async function installDirectory(
  src: string,
  dest: string,
  renameDirectory: typeof rename = rename,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  // The installer lock serializes these swaps. Temporary rollback copies are
  // removed on success; user edits are not retained as preservation backups.
  const staging = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.review-staging`,
  );
  const backup = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.review-previous`,
  );
  // A terminated process may have moved the previous directory but not yet
  // promoted staging. Recover it before attempting another copy.
  try {
    await lstat(dest);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    try {
      await renameDirectory(backup, dest);
    } catch (restoreError) {
      if (
        !(
          restoreError instanceof Error &&
          "code" in restoreError &&
          restoreError.code === "ENOENT"
        )
      )
        throw restoreError;
    }
  }
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(src, staging, { recursive: true });
    let movedExisting = false;
    try {
      await renameDirectory(dest, backup);
      movedExisting = true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    try {
      await renameDirectory(staging, dest);
    } catch (error) {
      if (movedExisting) {
        try {
          await renameDirectory(backup, dest);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Could not restore ${dest}. The previous skill remains at ${backup}.`,
          );
        }
      }
      throw error;
    }
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
