// A second installer version built from the same payload exercises Inno's
// upgrade behavior without downloading or trusting an unrelated old release.
import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const app = path.resolve(import.meta.dirname, "..");

const checkout = path.join(app, "code-oss");

const files = [
  path.join(checkout, "product.json"),
  path.join(app, "VSCode-win32-x64/resources/app/product.json"),
];

const originals = await Promise.all(
  files.map((file) => readFile(file, "utf8")),
);

try {
  for (let index = 0; index < files.length; index++) {
    const product = JSON.parse(originals[index]);
    product.reviewVersion =
      product.quality === "preview" ? "0.1.4-preview.1" : "0.1.3";
    await writeFile(files[index], JSON.stringify(product));
  }

  execFileSync(
    process.execPath,
    [
      path.join(checkout, "node_modules/gulp/bin/gulp.js"),
      "vscode-win32-x64-user-setup",
    ],
    {
      cwd: checkout,
      stdio: "inherit",
      // Inno Setup needs the commit that package-windows.sh stamped; the
      // vendored checkout has no .git of its own for Code OSS to read.
      env: {
        ...process.env,
        BUILD_SOURCEVERSION:
          process.env.BUILD_SOURCEVERSION ||
          execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: app,
            encoding: "utf8",
          }).trim(),
      },
    },
  );
  await copyFile(
    path.join(checkout, ".build/win32-x64/user-setup/VSCodeSetup.exe"),
    path.join(app, "dist/windows/Whiteboard-win32-x64-upgrade-fixture.exe"),
  );
} finally {
  for (let index = 0; index < files.length; index++)
    await writeFile(files[index], originals[index]);
}
