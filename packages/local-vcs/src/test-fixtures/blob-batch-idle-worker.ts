import { createBlobBatchReader } from "../index";

const [rootPath, commit, relativePath] = process.argv.slice(2);

if (!rootPath || !commit || !relativePath) {
  throw new Error(
    "Usage: blob-batch-idle-worker <root-path> <commit> <relative-path>",
  );
}

const reader = createBlobBatchReader({ rootPath, kind: "git" });

const blob = await reader.read(commit, relativePath);

if (blob === null) throw new Error(`No blob at ${commit}:${relativePath}`);

process.stdout.write(blob);

/* No close(): a host that forgets one must still exit, so the idle batch
   process may not hold the event loop. The default idle timeout is 30 s. */
