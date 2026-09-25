import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// Signs Windows binaries with Azure Artifact Signing through signtool's dlib.
// Arguments are files or directories; directories are searched for PE files.
// Inno Setup calls this with the installer and uninstaller it builds.
const dlib = process.env.REVIEW_WINDOWS_SIGNING_DLIB;

const metadata = process.env.REVIEW_WINDOWS_SIGNING_METADATA;

if (!dlib || !metadata) {
  console.error(
    "REVIEW_WINDOWS_SIGNING_DLIB and REVIEW_WINDOWS_SIGNING_METADATA are required",
  );
  process.exit(1);
}

const SIGNABLE = /\.(exe|dll|node)$/i;

const walk = (target) =>
  statSync(target).isDirectory()
    ? readdirSync(target).flatMap((name) => walk(path.join(target, name)))
    : [target];

const targets = process.argv.slice(2).flatMap((target) => {
  const resolved = path.resolve(target);

  return statSync(resolved).isDirectory()
    ? walk(resolved).filter((file) => SIGNABLE.test(file))
    : [resolved];
});

const signtool = (args) =>
  spawnSync("signtool", args, { stdio: ["ignore", "pipe", "pipe"] });

// Third-party binaries that already carry a valid signature keep it.
const unsigned = targets.filter(
  (file) => signtool(["verify", "/pa", "/q", file]).status !== 0,
);

console.log(
  `Signing ${unsigned.length} of ${targets.length} file(s); the rest are already signed.`,
);

if (unsigned.length === 0) process.exit(0);

const result = spawnSync(
  "signtool",
  [
    "sign",
    "/v",
    "/fd",
    "SHA256",
    "/tr",
    "http://timestamp.acs.microsoft.com",
    "/td",
    "SHA256",
    "/dlib",
    dlib,
    "/dmdf",
    metadata,
    ...unsigned,
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
