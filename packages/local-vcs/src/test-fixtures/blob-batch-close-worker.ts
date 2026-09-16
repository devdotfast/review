import { createBlobBatchReader } from "../index";

const [rootPath, commit, relativePath] = process.argv.slice(2);

if (!rootPath || !commit || !relativePath) {
  throw new Error(
    "Usage: blob-batch-close-worker <root-path> <commit> <relative-path>",
  );
}

const reader = createBlobBatchReader({ rootPath, kind: "git" });

const blob = await reader.read(commit, relativePath);

if (blob === null) throw new Error(`No blob at ${commit}:${relativePath}`);

await reader.close();

// After `await close()` the host must still be alive to print.
process.stdout.write("closed\n");
