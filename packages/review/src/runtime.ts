import { spawn } from "node:child_process";
import path from "node:path";

export async function resolveReviewRoot(
  cwd: string,
  execFile: typeof execFilePromise = execFilePromise,
): Promise<string> {
  const initialCwd = path.resolve(cwd);

  try {
    // cwd-based invocation: jj walks up from cwd like git does, while
    // `-R <subdir>` fails for a subdirectory of a workspace and would
    // silently fall back to git's cwd walk (the OUTER repo, for a
    // non-colocated jj workspace nested in another git repo).
    const { stdout } = await execFile("jj", ["root"], { cwd: initialCwd });
    const root = stdout.trim();

    if (root) return path.resolve(root);
  } catch {
    // Not a jj workspace, or jj is unavailable. Try Git below.
  }

  try {
    const { stdout } = await execFile("git", [
      "-C",
      initialCwd,
      "rev-parse",
      "--show-toplevel",
    ]);

    const root = stdout.trim();

    if (root) return path.resolve(root);
  } catch {
    // Non-VCS directories keep their original cwd for existing review behavior.
  }

  return initialCwd;
}

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string }> {
  return execFileUntraced(file, args, options);
}

function execFileUntraced(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim() || `${file} exited with ${code}`));
    });
  });
}
