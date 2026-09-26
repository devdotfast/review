// Curated built-in extensions for Review Desktop.
//
// Review ships no marketplace (`extensionsGallery` is null and stays that way).
// Bundled extensions are fetched from Open VSX at build time. Optional
// extensions are fetched after user consent. Every file is checked against the
// pinned checksum below. Nothing binary is committed to git.
//
// Microsoft Marketplace terms forbid serving its offerings to forks of Code OSS,
// so every entry must resolve from Open VSX (or the project's own releases).
//
// To add or bump an extension: edit the entry, then run
//   node scripts/curated-extensions.mjs --print-hashes
// and paste the emitted sha256 values back in here.

/**
 * `group` drives the DEV_REVIEW_EXTENSIONS materialization filter in run.sh.
 * Which of the materialized extensions are enabled is a separate, persisted
 * choice made through the in-app "Manage Extensions" picker.
 *
 * `targets` maps a build target to its pinned checksum. An entry with a
 * `universal` target has a single platform-independent VSIX; anything else must
 * list every target Review builds for.
 *
 * `executables` are paths (relative to the unpacked extension root) that must
 * exist and stay executable. They are asserted at materialize time so a payload
 * layout change fails the build instead of silently shipping a broken server.
 */
export const curatedExtensions = Object.freeze([
  {
    id: "vscodevim.vim",
    tier: "bundled",
    namespace: "vscodevim",
    name: "vim",
    version: "1.32.4",
    group: "vim",
    label: "Vim keybindings",
    targets: {
      universal: {
        sha256:
          "0faab122afd25bc94f5ef9cf9678e64cbd554d6dc88fe87ffe11bba623814168",
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "tuttieee.emacs-mcx",
    tier: "bundled",
    namespace: "tuttieee",
    name: "emacs-mcx",
    version: "0.111.1",
    group: "emacs",
    label: "Emacs keybindings",
    targets: {
      universal: {
        sha256:
          "fb4c080bfef16ee9f659ff3078f53a35247d50c35dd11bcbcfa51d00cdd7e58e",
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "ms-vscode.sublime-keybindings",
    tier: "bundled",
    namespace: "ms-vscode",
    name: "sublime-keybindings",
    version: "4.1.10",
    group: "sublime",
    label: "Sublime Text keybindings",
    targets: {
      universal: {
        sha256:
          "fe064eb9f0b83466ede5ed1c7b1a8289b11af8abba82005f7187d571fdb26a34",
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "rust-lang.rust-analyzer",
    tier: "optional",
    role: "primary",
    namespace: "rust-lang",
    name: "rust-analyzer",
    version: "0.4.2990",
    group: "rust",
    label: "Rust (rust-analyzer)",
    targets: {
      "win32-x64": {
        url: "https://open-vsx.org/api/rust-lang/rust-analyzer/win32-x64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@win32-x64.vsix",
        sha256:
          "09e9023bf4e7c1d7b333b2a2457742c482b897b776d12528e38853230e5bcb38",
        size: 19125573,
      },
      "darwin-arm64": {
        url: "https://open-vsx.org/api/rust-lang/rust-analyzer/darwin-arm64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@darwin-arm64.vsix",
        sha256:
          "e068ebb88f705491856b91cdbf8b7ead40c22d50f2c24df70e345c889c2b0111",
        size: 15445156,
      },
      "linux-x64": {
        url: "https://open-vsx.org/api/rust-lang/rust-analyzer/linux-x64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@linux-x64.vsix",
        sha256:
          "317cb128e8caf2495b955ef6612d828fef809187ac445242116ad8e2e32382ff",
        size: 16313907,
      },
    },
    executables: ["server/rust-analyzer"],
    stripExtensionPack: false,
    // rust-analyzer ships only `workspaceContains:` activation events. Review
    // now roots the workspace at the reviewed repository, so those can fire,
    // but two gaps remain: the extension host only re-evaluates
    // `workspaceContains:` for folders added while it is already running, and
    // the patterns miss a Rust file whose Cargo.toml is not at the folder
    // root. Every other curated language extension already declares an
    // `onLanguage:` event; this gives rust-analyzer the same trigger.
    addActivationEvents: ["onLanguage:rust"],
  },
  {
    id: "swiftlang.swift-vscode",
    tier: "optional",
    role: "primary",
    namespace: "swiftlang",
    name: "swift-vscode",
    version: "2.17.20260702",
    group: "swift",
    label: "Swift",
    targets: {
      universal: {
        url: "https://open-vsx.org/api/swiftlang/swift-vscode/2.17.20260702/file/swiftlang.swift-vscode-2.17.20260702.vsix",
        sha256:
          "64fcca2666e033c3934ceeb98b13ff73e30071d32e0795bec891652814ef947b",
        size: 14779649,
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "llvm-vs-code-extensions.lldb-dap",
    tier: "optional",
    role: "support",
    namespace: "llvm-vs-code-extensions",
    name: "lldb-dap",
    version: "0.7.20260804",
    group: "swift",
    label: "Swift LLDB DAP support",
    targets: {
      universal: {
        url: "https://open-vsx.org/api/llvm-vs-code-extensions/lldb-dap/0.7.20260804/file/llvm-vs-code-extensions.lldb-dap-0.7.20260804.vsix",
        sha256:
          "69dad4f902a1a9d96403205e209a9aef760189c93d687e02f568a753148c537f",
        size: 819802,
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "muhammad-sammy.csharp",
    tier: "optional",
    role: "primary",
    namespace: "muhammad-sammy",
    name: "csharp",
    version: "2.145.21-g154a82fd27",
    group: "csharp",
    label: "C#",
    targets: {
      "win32-x64": {
        url: "https://open-vsx.org/api/muhammad-sammy/csharp/win32-x64/2.145.21-g154a82fd27/file/muhammad-sammy.csharp-2.145.21-g154a82fd27@win32-x64.vsix",
        sha256:
          "29c22be7c5d15e8b395a403a18953e6f069bb8d9f5e886ee81eba7ee4e1a0e6b",
        size: 78285827,
      },
      "darwin-arm64": {
        url: "https://open-vsx.org/api/muhammad-sammy/csharp/darwin-arm64/2.145.21-g154a82fd27/file/muhammad-sammy.csharp-2.145.21-g154a82fd27@darwin-arm64.vsix",
        sha256:
          "93f61e8b6938cbe8ecda8768bfaf08abed9789db9461177d3d0ab59ccda2528d",
        size: 75096042,
      },
      "linux-x64": {
        url: "https://open-vsx.org/api/muhammad-sammy/csharp/linux-x64/2.145.21-g154a82fd27/file/muhammad-sammy.csharp-2.145.21-g154a82fd27@linux-x64.vsix",
        sha256:
          "78bc006683cc998e9fd1a6f2760d8cb3da63096464a217bbd192ecfb490a5516",
        size: 78144854,
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    id: "ms-dotnettools.vscode-dotnet-runtime",
    tier: "optional",
    role: "support",
    namespace: "ms-dotnettools",
    name: "vscode-dotnet-runtime",
    version: "3.1.0",
    group: "csharp",
    label: ".NET runtime support",
    targets: {
      universal: {
        url: "https://open-vsx.org/api/ms-dotnettools/vscode-dotnet-runtime/3.1.0/file/ms-dotnettools.vscode-dotnet-runtime-3.1.0.vsix",
        sha256:
          "10fd1e1693a81e2c68f0382ae3cfcf0784c5f3e0da002dd4bfd322575b46941e",
        size: 1458566,
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
  {
    // ty and ruff both declare `extensionDependencies: ["ms-python.python"]`,
    // so the Python extension has to ship alongside them or neither activates.
    id: "ms-python.python",
    tier: "bundled",
    namespace: "ms-python",
    name: "python",
    version: "2026.4.0",
    group: "python",
    label: "Python",
    targets: {
      universal: {
        sha256:
          "232aeafb01f069824fdd92d3e628c1c442bbcfa1d3cc945ff97076340bb2b4a6",
      },
    },
    executables: [],
    // Its extension pack points at Pylance (proprietary, not redistributable)
    // and debugpy, none of which Review ships.
    stripExtensionPack: true,
  },
  {
    id: "astral-sh.ty",
    tier: "bundled",
    namespace: "astral-sh",
    name: "ty",
    version: "2026.64.0",
    group: "python",
    label: "Python type checking (ty)",
    targets: {
      "win32-x64": {
        url: "https://open-vsx.org/api/astral-sh/ty/win32-x64/2026.64.0/file/astral-sh.ty-2026.64.0@win32-x64.vsix",
        sha256:
          "b88ffd1b25c87fe209745ecf68a1871ad31e1eb970441b1d016cba64429b112d",
        size: 12920723,
      },
      "darwin-arm64": {
        sha256:
          "3ac92b3f4b7ac848ea9a125a787a0b181879835d54b2e136e760161df414b08a",
      },
      "linux-x64": {
        sha256:
          "d64fc3104f07c4d47c3122a0fa9f2da3e593937c8b506b5f952b4283d877d212",
      },
    },
    executables: ["bundled/libs/bin/ty"],
    stripExtensionPack: false,
  },
  {
    id: "charliermarsh.ruff",
    tier: "bundled",
    namespace: "charliermarsh",
    name: "ruff",
    version: "2026.66.0",
    group: "python",
    label: "Python lint/format (ruff)",
    targets: {
      "win32-x64": {
        url: "https://open-vsx.org/api/charliermarsh/ruff/win32-x64/2026.66.0/file/charliermarsh.ruff-2026.66.0@win32-x64.vsix",
        sha256:
          "23474f4e92ead0e18e8034275d2dff743f2aaaff6c4e87254b156bbedac7fb46",
        size: 12802660,
      },
      "darwin-arm64": {
        sha256:
          "652cf695fbe11c4bcae85432b3baf70f8bc2520dc13bbc5dd95b3600c8b1f227",
      },
      "linux-x64": {
        sha256:
          "3ed6bc6d6dc9a70cff97698d498844b756110b5c66964689dad5839845f06556",
      },
    },
    executables: ["bundled/libs/bin/ruff"],
    stripExtensionPack: false,
  },
  {
    // Ships no server: on activation it runs `go install` for gopls and vscgo
    // against the reader's own Go toolchain, with no prompt and no setting that
    // stops it. There are no official gopls prebuilts to bundle, so the group is
    // optional and the download consent covers the toolchain install too.
    // Note the Open VSX namespace capitalises the name (`golang/Go`) while the
    // extension identifier itself is lowercase.
    id: "golang.go",
    tier: "optional",
    role: "primary",
    namespace: "golang",
    name: "Go",
    version: "0.56.0",
    group: "go",
    label: "Go",
    targets: {
      universal: {
        url: "https://open-vsx.org/api/golang/Go/0.56.0/file/golang.Go-0.56.0.vsix",
        sha256:
          "9f5959fb17ba0a8dbd804387ddda50975fcaa9dd5267aa33eaaa89912072aacb",
        size: 621478,
      },
    },
    executables: [],
    stripExtensionPack: false,
  },
]);

/** Build targets Review knows how to materialize platform-specific VSIXes for. */
export const supportedTargets = Object.freeze([
  "darwin-arm64",
  "linux-x64",
  "win32-x64",
]);

/** Group tokens accepted by DEV_REVIEW_EXTENSIONS, in display order. */
export const curatedGroups = Object.freeze([
  "rust",
  "swift",
  "csharp",
  "python",
  "go",
  "vim",
  "emacs",
  "sublime",
]);

/** Extensions that release builds materialize and package. */
export const bundledExtensions = Object.freeze(
  curatedExtensions.filter((extension) => extension.tier === "bundled"),
);

/** Extensions that Review downloads only after user consent. */
export const optionalExtensions = Object.freeze(
  curatedExtensions.filter((extension) => extension.tier === "optional"),
);

/** Group tokens included by the default and `all` materialization selections. */
export const bundledGroups = Object.freeze(
  curatedGroups.filter((group) =>
    bundledExtensions.some((extension) => extension.group === group),
  ),
);

/** Group tokens that require an explicit development selection. */
export const optionalGroups = Object.freeze(
  curatedGroups.filter((group) =>
    optionalExtensions.some((extension) => extension.group === group),
  ),
);

/** Groups represented by a primary or bundled extension in the management UI. */
export const userFacingGroups = Object.freeze(
  curatedGroups.filter((group) =>
    curatedExtensions.some(
      (extension) => extension.group === group && extension.role !== "support",
    ),
  ),
);

/** Keymaps conflict with each other, so at most one may be enabled at a time. */
export const keymapGroups = Object.freeze(["vim", "emacs", "sublime"]);

/** Extensions that start out disabled on a fresh profile. */
export const defaultDisabledIds = Object.freeze(
  curatedExtensions
    .filter((e) => keymapGroups.includes(e.group))
    .map((e) => e.id),
);

/**
 * Open VSX serves platform-specific builds under a target segment and suffixes
 * the filename with `@<target>`; universal builds omit both. Downloads answer
 * with a 302 to the storage host, so callers must follow redirects.
 */
export function openVsxUrl({ namespace, name, version, target }) {
  const scoped = target ? `/${target}` : "";
  const suffix = target ? `@${target}` : "";

  return `https://open-vsx.org/api/${namespace}/${name}${scoped}/${version}/file/${namespace}.${name}-${version}${suffix}.vsix`;
}

/**
 * Resolves the target key to use for an extension on `target`, or undefined when
 * the extension has no build for it.
 */
export function targetKeyFor(extension, target) {
  if (extension.targets.universal) {
    return "universal";
  }

  return extension.targets[target] ? target : undefined;
}

/** Parses a DEV_REVIEW_EXTENSIONS value into the set of groups to materialize. */
export function parseGroupSelection(raw) {
  const value = (raw ?? "all").trim();

  if (value === "" || value === "all") {
    return new Set(bundledGroups);
  }

  if (value === "none") {
    return new Set();
  }

  const selected = new Set();

  for (const token of value.split(",")) {
    const group = token.trim();

    if (group === "") {
      continue;
    }

    if (!curatedGroups.includes(group)) {
      throw new Error(
        `unknown extension group "${group}"; expected all, none, or a comma-separated subset of ${curatedGroups.join(", ")}`,
      );
    }

    selected.add(group);
  }

  return selected;
}
