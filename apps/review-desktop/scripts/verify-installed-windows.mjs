import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { smokeWindows } from "./smoke-windows.mjs";

assert.equal(process.platform, "win32");

const artifacts = path.resolve(process.argv[2]);

const evidence = path.resolve(process.argv[3] ?? "artifacts/windows-installed");

// Bundled extensions nest up to ~185 characters deep, so a runner temp
// directory would push installed files past MAX_PATH. Keep the root short but
// spaced, like a real install location.
const root = await mkdtemp(
  path.join(path.parse(os.tmpdir()).root, "Whiteboard test "),
);

const installed = [];

const step = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

const run = (exe, args) => {
  step(`${path.basename(exe)} ${args.join(" ")}`);
  execFileSync(exe, args, { timeout: 180000, stdio: "inherit" });
};

const installer = (channel, kind) =>
  path.join(
    artifacts,
    `windows-packages-${channel}`,
    `Whiteboard-win32-x64-${kind}.exe`,
  );

const install = (exe, destination) =>
  run(exe, [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/TASKS=addtopath",
    `/DIR=${destination}`,
  ]);

const uninstall = (destination) =>
  run(path.join(destination, "unins000.exe"), [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
  ]);

try {
  for (const channel of ["stable", "preview"]) {
    const destination = path.join(root, `${channel} user install`);
    install(installer(channel, "user"), destination);
    installed.push(destination);

    const product = JSON.parse(
      await readFile(
        path.join(destination, "resources/app/product.json"),
        "utf8",
      ),
    );

    assert.equal(product.quality, channel);
    assert.equal(product.target, "user");
    const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product.win32x64UserAppId.slice(1)}_is1`;

    const registry = execFileSync(
      "reg.exe",
      ["query", uninstallKey, "/v", "DisplayVersion"],
      { encoding: "utf8" },
    );

    assert.ok(registry.includes(product.reviewVersion));

    const protocol = execFileSync(
      "reg.exe",
      [
        "query",
        `HKCU\\Software\\Classes\\${product.urlProtocol}\\shell\\open\\command`,
        "/ve",
      ],
      { encoding: "utf8" },
    );

    assert.ok(
      protocol.includes(path.join(destination, `${product.nameShort}.exe`)),
    );
    assert.ok(protocol.includes('--open-url -- "%1"'));
    // Shortcut names become file names, so a "/" in the display name would
    // nest the shortcut inside folders instead of creating it.
    await access(
      path.join(
        process.env.APPDATA,
        "Microsoft/Windows/Start Menu/Programs",
        product.nameShort,
        `${product.nameShort}.lnk`,
      ),
    );
    // "Add to PATH" puts the Whiteboard CLI on PATH, not the Code OSS editor launcher.
    const bin = path.join(destination, "bin");
    await assert.rejects(
      access(path.join(bin, `${product.applicationName}.cmd`)),
    );
    assert.match(
      execFileSync("cmd.exe", ["/d", "/c", path.join(bin, "whiteboard.cmd"), "version"], {
        encoding: "utf8",
        timeout: 30000,
      }),
      /\d+\.\d+\.\d+/,
    );
    assert.ok(
      execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
        encoding: "utf8",
      })
        .toLowerCase()
        .includes(bin.toLowerCase()),
    );
    step(`smoke ${destination}`);
    await smokeWindows(destination, evidence);

    // A reinstall must replace the embedded dependency closure, including files
    // removed by a newer release, while leaving user data outside the app intact.
    const stale = path.join(
      destination,
      "resources/app/review-runtime/removed-in-next-version.txt",
    );

    await writeFile(stale, "obsolete runtime file");
    const saved = path.join(root, `${channel}-saved-review.json`);
    await writeFile(saved, '{"review":"preserve"}');
    install(installer(channel, "upgrade-fixture"), destination);
    await assert.rejects(access(stale));

    const updated = JSON.parse(
      await readFile(
        path.join(destination, "resources/app/product.json"),
        "utf8",
      ),
    );

    assert.notEqual(updated.reviewVersion, product.reviewVersion);

    const updatedRegistry = execFileSync(
      "reg.exe",
      ["query", uninstallKey, "/v", "DisplayVersion"],
      { encoding: "utf8" },
    );

    assert.ok(updatedRegistry.includes(updated.reviewVersion));
    step(`smoke ${destination}`);
    await smokeWindows(destination, evidence);

    assert.equal(await readFile(saved, "utf8"), '{"review":"preserve"}');
  }

  // Both identities are installed together. Removing preview cannot unregister
  // stable's protocol or break its runtime.
  uninstall(installed.pop());
  step(`smoke ${installed[0]}`);
  await smokeWindows(installed[0], evidence);
  uninstall(installed.pop());
  const system = path.join(root, "system install");
  install(installer("stable", "system"), system);
  installed.push(system);

  const product = JSON.parse(
    await readFile(path.join(system, "resources/app/product.json"), "utf8"),
  );

  assert.equal(product.target, "system");
  step(`smoke ${system}`);
  await smokeWindows(system, evidence);
  uninstall(installed.pop());
  console.log(
    "User/system installs, replacement, channel coexistence and uninstall passed.",
  );
} finally {
  for (const destination of installed.reverse()) {
    try {
      uninstall(destination);
    } catch {}
  }

  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
