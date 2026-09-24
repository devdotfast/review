// Build Go's language tools on the build host, never on the reader's machine.
// Go's module checksums authenticate source downloads; explicit root sums also
// make a changed upstream pin fail closed. CGO is disabled for cross-compilation.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const goToolchain = "go1.26.2";

export const goTools = Object.freeze([
  {
    name: "gopls",
    module: "golang.org/x/tools/gopls",
    version: "v0.23.0",
    sum: "h1:Dn6mf9WXu9iLnTftDDMb9wV0c6Se7PjzEMqP0LEe08Y=",
    package: ".",
  },
  {
    name: "vscgo",
    module: "github.com/golang/vscode-go",
    version: "v0.56.0",
    sum: "h1:kWmdDGAlITqR/zEOhQfa87SQSTlhUyp43lnkQUsTheY=",
    package: "./vscgo",
  },
]);

export function goToolsStamp(target) {
  return { recipe: 1, target, toolchain: goToolchain, tools: goTools };
}

export function buildGoTools(destination, target) {
  const platforms = {
    "darwin-arm64": ["darwin", "arm64"],
    "linux-x64": ["linux", "amd64"],
  };

  const platform = platforms[target];

  if (!platform) throw new Error(`unsupported Go tools target ${target}`);

  const env = {
    ...process.env,
    GOTOOLCHAIN: goToolchain,
    GOOS: platform[0],
    GOARCH: platform[1],
    CGO_ENABLED: "0",
    GOFLAGS: "",
    GOWORK: "off",
    GO111MODULE: "on",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
  };

  fs.mkdirSync(destination, { recursive: true });

  const run = (args, cwd = destination) =>
    execFileSync("go", args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

  // Keep module/toolchain downloads in the normal cache while directing install
  // output to staging. Unlike building from a module directory, go install @pin
  // retains the release version in the executable's Go build information.
  env.GOMODCACHE = run(["env", "GOMODCACHE"]).trim();
  env.GOPATH = path.join(destination, ".go-build");
  env.GOBIN = "";
  const host = run(["env", "GOHOSTOS", "GOHOSTARCH"]).trim().split(/\s+/);

  const binaryDir = path.join(
    env.GOPATH,
    "bin",
    host.join("-") === platform.join("-") ? "" : platform.join("_"),
  );

  fs.mkdirSync(path.join(destination, "bin"), { recursive: true });

  for (const tool of goTools) {
    console.log(`building ${tool.name}@${tool.version} for ${target}`);

    const source = JSON.parse(
      run(["mod", "download", "-json", `${tool.module}@${tool.version}`]),
    );

    if (source.Sum !== tool.sum || !source.Dir)
      throw new Error(`${tool.name}: source checksum mismatch`);

    const importPath =
      tool.package === "."
        ? tool.module
        : `${tool.module}/${tool.package.slice(2)}`;

    run([
      "install",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w",
      `${importPath}@${tool.version}`,
    ]);
    fs.renameSync(
      path.join(binaryDir, tool.name),
      path.join(destination, "bin", tool.name),
    );

    // Preserve notices for the tool and its transitive modules alongside the
    // binaries. The extension's own LICENSE does not cover all Go dependencies.
    const modules = run(["list", "-m", "-json", "all"], source.Dir)
      .trim()
      .split(/\n(?=\{)/)
      .map(JSON.parse);

    for (const mod of modules) {
      if (!mod.Dir) continue;

      for (const file of fs
        .readdirSync(mod.Dir)
        .filter((name) => /^(LICENSE|COPYING|NOTICE)(\.|$)/i.test(name))) {
        const from = path.join(mod.Dir, file);

        if (!fs.statSync(from).isFile()) continue;

        const to = path.join(
          destination,
          "third-party-notices",
          `${mod.Path}@${mod.Version ?? tool.version}`,
          file,
        );

        fs.mkdirSync(path.dirname(to), { recursive: true });

        if (!fs.existsSync(to)) fs.copyFileSync(from, to);
      }
    }
  }

  fs.rmSync(env.GOPATH, { recursive: true, force: true });
}
