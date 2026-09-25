import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The npm distribution has no Windows asset yet. Build the exact same release
// from its immutable source with Cargo's lockfile, then verify the staged bytes.
const commit = "ea5f6c126982cef5d7b8059bf05978f07b87b399";

const root = path.resolve(import.meta.dirname, "../../..");

const output = path.join(root, "packages/review/bin");

const binary = path.join(output, "diffr.exe");

const stamp = path.join(output, "diffr.windows.json");

const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function verifyWindowsDiffr(source = binary) {
  const record = JSON.parse(
    readFileSync(path.join(path.dirname(source), "diffr.windows.json"), "utf8"),
  );

  if (record.commit !== commit || record.sha256 !== digest(source)) {
    throw new Error("Windows diffr does not match its pinned build receipt");
  }
}

function build() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Build diffr on Windows x64");

  const checkout = path.join(
    root,
    "apps/review-desktop/code-oss/.build/diffr-windows",
  );

  const run = (cmd, args, cwd = root) =>
    execFileSync(cmd, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, RUSTFLAGS: "-C target-feature=+crt-static" },
    });

  mkdirSync(path.dirname(checkout), { recursive: true });

  if (!existsSync(path.join(checkout, ".git")))
    run("git", [
      "clone",
      "--no-checkout",
      "https://github.com/devdotfast/diffr.git",
      checkout,
    ]);
  run("git", ["checkout", "--detach", commit], checkout);
  run(
    "cargo",
    [
      "+stable",
      "build",
      "--locked",
      "--release",
      "--bin",
      "diffr",
      "--target",
      "x86_64-pc-windows-msvc",
    ],
    checkout,
  );
  mkdirSync(output, { recursive: true });
  copyFileSync(
    path.join(checkout, "target/x86_64-pc-windows-msvc/release/diffr.exe"),
    binary,
  );
  run(binary, ["--version"]);
  writeFileSync(
    stamp,
    JSON.stringify({ commit, sha256: digest(binary) }) + "\n",
  );
  verifyWindowsDiffr();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) verifyWindowsDiffr();
  else build();
}
