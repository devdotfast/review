import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  bundledExtensions,
  bundledGroups,
  curatedExtensions,
  curatedGroups,
  defaultDisabledIds,
  keymapGroups,
  openVsxUrl,
  optionalExtensions,
  optionalGroups,
  parseGroupSelection,
  supportedTargets,
  targetKeyFor,
  userFacingGroups,
} from "./curated-extensions.manifest.mjs";
import {
  copyCuratedExtensions,
  verifyCuratedExtensions,
} from "./curated-extensions.mjs";

const APP_DIR = path.dirname(fileURLToPath(new URL("./", import.meta.url)));
const EXTENSIONS_DIR = path.join(APP_DIR, "code-oss", "extensions");

const buildExtensions = await readFile(
  new URL("../code-oss/build/lib/extensions.ts", import.meta.url),
  "utf8",
);
const gitignore = await readFile(
  new URL("../code-oss/.gitignore", import.meta.url),
  "utf8",
);
const runScript = await readFile(new URL("./run.sh", import.meta.url), "utf8");
const curatedContribution = await readFile(
  new URL(
    "../code-oss/src/vs/review/contrib/extensions/reviewCuratedExtensions.contribution.ts",
    import.meta.url,
  ),
  "utf8",
);
const reviewConfiguration = await readFile(
  new URL(
    "../code-oss/src/vs/review/common/reviewConfigurationDefaults.ts",
    import.meta.url,
  ),
  "utf8",
);

async function loadImportFreeTypeScriptModule(url) {
  const source = await readFile(url, "utf8");
  const emitted = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(emitted).toString("base64")}`
  );
}

const mainOptionalCatalog = (
  await loadImportFreeTypeScriptModule(
    new URL(
      "../code-oss/src/vs/review/node/reviewOptionalExtensionCatalog.ts",
      import.meta.url,
    ),
  )
).reviewOptionalExtensionCatalog;
const rendererOptionalCatalog = (
  await loadImportFreeTypeScriptModule(
    new URL(
      "../code-oss/src/vs/review/contrib/extensions/reviewOptionalExtensionCatalog.ts",
      import.meta.url,
    ),
  )
).reviewOptionalExtensionCatalog;

test("pins every curated extension to a checksum for every supported target", () => {
  assert.ok(curatedExtensions.length > 0);
  for (const extension of curatedExtensions) {
    assert.equal(
      extension.id,
      `${extension.namespace}.${extension.name}`.toLowerCase(),
      `${extension.id} must be <namespace>.<name> lowercased`,
    );
    assert.ok(curatedGroups.includes(extension.group), `${extension.id} group`);
    assert.ok(
      ["bundled", "optional"].includes(extension.tier),
      `${extension.id} tier`,
    );
    assert.match(extension.version, /^\d/, `${extension.id} version`);

    const targetKeys = Object.keys(extension.targets);
    if (extension.targets.universal) {
      assert.deepEqual(targetKeys, ["universal"], `${extension.id} targets`);
    } else {
      assert.deepEqual(
        targetKeys.sort(),
        [...supportedTargets].sort(),
        `${extension.id} must pin every supported target`,
      );
    }
    for (const [targetKey, target] of Object.entries(extension.targets)) {
      assert.match(
        target.sha256,
        /^[0-9a-f]{64}$/,
        `${extension.id} ${targetKey} sha256`,
      );
      if (extension.tier === "optional") {
        assert.equal(
          target.url,
          openVsxUrl({
            namespace: extension.namespace,
            name: extension.name,
            version: extension.version,
            target: targetKey === "universal" ? undefined : targetKey,
          }),
          `${extension.id} ${targetKey} url`,
        );
        assert.ok(
          Number.isSafeInteger(target.size) && target.size > 0,
          `${extension.id} ${targetKey} size`,
        );
      }
    }
  }
});

test("separates bundled extensions from optional language groups", () => {
  assert.deepEqual(
    [...bundledExtensions, ...optionalExtensions]
      .map((extension) => extension.id)
      .sort(),
    curatedExtensions.map((extension) => extension.id).sort(),
  );
  assert.deepEqual(optionalExtensions.map((extension) => extension.id).sort(), [
    "llvm-vs-code-extensions.lldb-dap",
    "ms-dotnettools.vscode-dotnet-runtime",
    "muhammad-sammy.csharp",
    "rust-lang.rust-analyzer",
    "swiftlang.swift-vscode",
  ]);

  for (const extension of optionalExtensions) {
    assert.ok(
      ["primary", "support"].includes(extension.role),
      `${extension.id} role`,
    );
  }
  assert.deepEqual(
    optionalExtensions
      .filter((extension) => extension.role === "primary")
      .map((extension) => extension.group),
    ["rust", "swift", "csharp"],
  );
  for (const support of optionalExtensions.filter(
    (extension) => extension.role === "support",
  )) {
    assert.ok(
      optionalExtensions.some(
        (extension) =>
          extension.role === "primary" && extension.group === support.group,
      ),
      `${support.id} must belong to an optional primary group`,
    );
  }

  assert.deepEqual([...userFacingGroups], [...curatedGroups]);
});

test("keeps every optional pin identical in build, main, and renderer catalogs", () => {
  const normalize = (catalog) =>
    catalog
      .flatMap((extension) =>
        Object.entries(extension.targets).map(([target, pin]) => ({
          id: extension.id,
          role: extension.role,
          group: extension.group,
          version: extension.version,
          target,
          url: pin.url,
          sha256: pin.sha256,
          size: pin.size,
        })),
      )
      .sort((left, right) =>
        `${left.id}:${left.target}`.localeCompare(
          `${right.id}:${right.target}`,
        ),
      );

  const buildPins = normalize(optionalExtensions);
  assert.deepEqual(normalize(mainOptionalCatalog), buildPins);
  assert.deepEqual(normalize(rendererOptionalCatalog), buildPins);
});

test("keeps the curated identifiers unique", () => {
  const ids = curatedExtensions.map((extension) => extension.id);
  assert.deepEqual(ids, [...new Set(ids)], "duplicate curated extension id");
});

test("disables only the conflicting keymaps by default", () => {
  assert.deepEqual([...keymapGroups], ["vim", "emacs"]);
  assert.deepEqual([...defaultDisabledIds].sort(), [
    "tuttieee.emacs-mcx",
    "vscodevim.vim",
  ]);
});

test("builds Open VSX download urls for universal and per-platform builds", () => {
  assert.equal(
    openVsxUrl({ namespace: "vscodevim", name: "vim", version: "1.32.4" }),
    "https://open-vsx.org/api/vscodevim/vim/1.32.4/file/vscodevim.vim-1.32.4.vsix",
  );
  assert.equal(
    openVsxUrl({
      namespace: "rust-lang",
      name: "rust-analyzer",
      version: "0.4.2990",
      target: "darwin-arm64",
    }),
    "https://open-vsx.org/api/rust-lang/rust-analyzer/darwin-arm64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@darwin-arm64.vsix",
  );
});

test("resolves a target key for every extension on every supported target", () => {
  for (const target of supportedTargets) {
    for (const extension of curatedExtensions) {
      assert.ok(
        targetKeyFor(extension, target),
        `${extension.id} has no build for ${target}`,
      );
    }
  }
});

test("parses DEV_REVIEW_EXTENSIONS selections", () => {
  assert.deepEqual([...bundledGroups], ["python", "go", "vim", "emacs"]);
  assert.deepEqual([...optionalGroups], ["rust", "swift", "csharp"]);
  assert.deepEqual(
    [...parseGroupSelection(undefined)].sort(),
    [...bundledGroups].sort(),
  );
  assert.deepEqual(
    [...parseGroupSelection("all")].sort(),
    [...bundledGroups].sort(),
  );
  assert.deepEqual([...parseGroupSelection("none")], []);
  assert.deepEqual([...parseGroupSelection("rust, vim")].sort(), [
    "rust",
    "vim",
  ]);
  assert.throws(() => parseGroupSelection("nope"), /unknown extension group/);
});

test("carries Darwin curated extensions from Linux compile through release validation", async () => {
  const [
    buildScript,
    compileScript,
    payloadManifest,
    packageScript,
    validationScript,
  ] = await Promise.all([
    readFile(new URL("./build.sh", import.meta.url), "utf8"),
    readFile(new URL("./compile-darwin-payload.sh", import.meta.url), "utf8"),
    readFile(new URL("./darwin-payload-manifest.sh", import.meta.url), "utf8"),
    readFile(new URL("./package-macos.sh", import.meta.url), "utf8"),
    readFile(
      new URL("./validate-release-artifacts.mjs", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(buildScript, /REVIEW_DESKTOP_CURATED_EXTENSION_TARGET/);
  assert.match(
    compileScript,
    /REVIEW_DESKTOP_CURATED_EXTENSION_TARGET=darwin-arm64/,
  );
  assert.match(
    compileScript,
    /source "\$APP_DIR\/scripts\/darwin-payload-manifest\.sh"/,
  );
  assert.match(
    packageScript,
    /source "\$APP_DIR\/scripts\/darwin-payload-manifest\.sh"/,
  );
  assert.match(payloadManifest, /DARWIN_PAYLOAD_REQUIRED_PATHS=/);
  assert.match(payloadManifest, /DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS=/);
  assert.ok(
    payloadManifest.indexOf("$DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH") >
      payloadManifest.indexOf("DARWIN_PAYLOAD_REQUIRED_PATHS=(") &&
      payloadManifest.indexOf("$DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH") <
        payloadManifest.indexOf("DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS=("),
    "the curated extension payload must be required by macOS packaging",
  );
  assert.match(compileScript, /DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS\[@\]/);
  assert.match(compileScript, /DARWIN_PAYLOAD_REQUIRED_PATHS\[@\]/);
  assert.match(packageScript, /DARWIN_PAYLOAD_REQUIRED_PATHS\[@\]/);
  assert.match(compileScript, /--target=darwin-arm64/);
  assert.match(compileScript, /--copy-to "\$CURATED_EXTENSIONS_PAYLOAD"/);
  assert.match(packageScript, /"\$CURATED_EXTENSIONS_PAYLOAD"/);
  assert.match(packageScript, /--source-root "\$CURATED_EXTENSIONS_SOURCE"/);
  assert.match(
    packageScript,
    /--copy-to "\$PACKAGED_APP\/Contents\/Resources\/app\/extensions"/,
  );
  assert.ok(
    packageScript.indexOf("curated-extensions.mjs") <
      packageScript.indexOf("scripts/notarize-macos.sh"),
    "curated extensions must be staged before signing and notarization",
  );
  assert.match(validationScript, /verifyCuratedExtensions/);
  assert.match(validationScript, /target: "darwin-arm64"/);
  assert.doesNotMatch(packageScript, /rust-lang\.rust-analyzer/);
  assert.doesNotMatch(payloadManifest, /rust-lang\.rust-analyzer/);
});

test("keeps curated extensions out of the gulp packaging stream", () => {
  for (const extension of curatedExtensions) {
    assert.ok(
      buildExtensions.includes(`'${extension.id}'`),
      `${extension.id} must be listed in excludedExtensions in build/lib/extensions.ts`,
    );
  }
});

test("ignores every materialized curated extension directory", () => {
  for (const extension of curatedExtensions) {
    assert.ok(
      gitignore.includes(`/extensions/${extension.id}/`),
      `${extension.id} must be gitignored; its payload is downloaded, not committed`,
    );
  }
});

test("materializes the selected groups from run.sh", () => {
  assert.match(runScript, /DEV_REVIEW_EXTENSIONS/);
  assert.match(runScript, /curated-extensions\.mjs/);
});

// The payloads are downloaded rather than committed, so a clean checkout has
// nothing to inspect. When they are present, hold them to the contract the
// materialize step promises.
const materialized = curatedExtensions.filter((extension) =>
  existsSync(path.join(EXTENSIONS_DIR, extension.id, "package.json")),
);

test(
  "materialized extensions match their pinned manifest entry",
  { skip: materialized.length === 0 && "no curated extensions materialized" },
  () => {
    for (const extension of materialized) {
      const directory = path.join(EXTENSIONS_DIR, extension.id);
      const stamp = JSON.parse(
        readFileSync(path.join(directory, ".curated.json"), "utf8"),
      );
      assert.equal(stamp.id, extension.id);
      assert.equal(stamp.version, extension.version);
      assert.equal(stamp.sha256, extension.targets[stamp.target].sha256);

      const manifest = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      );
      assert.equal(
        manifest.dependencies,
        undefined,
        `${extension.id} dependencies`,
      );
      assert.equal(manifest.scripts, undefined, `${extension.id} scripts`);
      if (extension.stripExtensionPack) {
        assert.equal(
          manifest.extensionPack,
          undefined,
          `${extension.id} extensionPack`,
        );
      }
      for (const activationEvent of extension.addActivationEvents ?? []) {
        assert.ok(
          manifest.activationEvents.includes(activationEvent),
          `${extension.id} must declare ${activationEvent}`,
        );
      }
      for (const relative of extension.executables) {
        const executable = path.join(directory, relative);
        assert.ok(
          existsSync(executable),
          `${extension.id} is missing ${relative}`,
        );
        assert.ok(
          statSync(executable).mode & 0o111,
          `${extension.id} ${relative} must stay executable`,
        );
      }
    }
  },
);

test("copies only bundled extensions for both package targets", () => {
  for (const target of supportedTargets) {
    const root = mkdtempSync(path.join(os.tmpdir(), "review-curated-copy-"));
    const sourceRoot = path.join(root, "source");
    const destinationRoot = path.join(root, "destination");
    try {
      for (const extension of bundledExtensions) {
        const targetKey = targetKeyFor(extension, target);
        assert.ok(targetKey, `${extension.id} must support ${target}`);
        const directory = path.join(sourceRoot, extension.id);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, "package.json"),
          `${JSON.stringify({
            publisher: extension.namespace,
            name: extension.name,
            version: extension.version,
            activationEvents: extension.addActivationEvents ?? [],
          })}\n`,
        );
        writeFileSync(
          path.join(directory, ".curated.json"),
          `${JSON.stringify({
            id: extension.id,
            version: extension.version,
            target: targetKey,
            sha256: extension.targets[targetKey].sha256,
          })}\n`,
        );
        for (const relative of extension.executables) {
          const executable = path.join(directory, relative);
          mkdirSync(path.dirname(executable), { recursive: true });
          writeFileSync(executable, "fixture\n");
          chmodSync(executable, 0o755);
        }
      }

      copyCuratedExtensions({ destinationRoot, sourceRoot, target });
      verifyCuratedExtensions({ root: destinationRoot, target });
      for (const extension of bundledExtensions) {
        assert.ok(
          existsSync(path.join(destinationRoot, extension.id, "package.json")),
          `${extension.id} must reach the ${target} destination`,
        );
      }
      for (const extension of optionalExtensions) {
        assert.ok(
          !existsSync(path.join(destinationRoot, extension.id)),
          `${extension.id} must stay out of the ${target} package`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("keeps the in-app picker list in sync with the manifest", () => {
  // Phase 1 keeps the existing bundled picker contract. Optional entries get
  // their group rows when the trusted runtime installer is connected.
  for (const extension of bundledExtensions) {
    assert.ok(
      curatedContribution.includes(`id: '${extension.id}'`),
      `${extension.id} must appear in reviewCuratedExtensions.contribution.ts`,
    );
  }
  // Nothing may be offered that this build does not vendor.
  const offered = [...curatedContribution.matchAll(/\{ id: '([^']+)'/g)].map(
    (match) => match[1],
  );
  const known = new Set(curatedExtensions.map((extension) => extension.id));
  for (const id of offered) {
    assert.ok(known.has(id), `${id} is offered by the picker but not vendored`);
  }
});

test("manages optional extensions as three user-facing groups", () => {
  for (const group of ["rust", "swift", "csharp"]) {
    assert.ok(
      curatedContribution.includes(`group: '${group}'`),
      `${group} must have one optional picker row`,
    );
  }
  for (const supportId of [
    "llvm-vs-code-extensions.lldb-dap",
    "ms-dotnettools.vscode-dotnet-runtime",
  ]) {
    assert.ok(
      !curatedContribution.includes(`{ id: '${supportId}'`),
      `${supportId} must not have a separate picker row`,
    );
  }
  assert.match(curatedContribution, /installMissingOptionalExtensions/);
  assert.match(curatedContribution, /vscode:reviewDownloadOptionalExtension/);
  assert.match(curatedContribution, /getInstalled\(\)/);
  assert.match(curatedContribution, /getInstalled\(ExtensionType\.User\)/);
  assert.match(curatedContribution, /donotIncludePackAndDependencies: true/);
  assert.match(curatedContribution, /donotCheckDependents: true/);
  assert.match(curatedContribution, /Codicon\.trash/);
  assert.match(curatedContribution, /Requires a system \.NET SDK/);
});

test("keeps the keymaps mutually exclusive in the picker", () => {
  for (const id of defaultDisabledIds) {
    assert.ok(
      curatedContribution.includes(`'${id}'`),
      `${id} must be listed as a keymap in the picker`,
    );
  }
  assert.match(curatedContribution, /KEYMAP_IDS/);

  const enumDeclaration = reviewConfiguration.match(
    /REVIEW_KEYMAPS\s*=\s*\[([^\]]+)\]/,
  );
  assert.ok(enumDeclaration, "review.keymap enum declaration");
  const enumValues = [...enumDeclaration[1].matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(enumValues, ["none", ...keymapGroups]);
  for (const keymap of keymapGroups) {
    assert.match(
      curatedContribution,
      new RegExp(`${keymap}:\\s*'[^']+'`),
      `${keymap} must map to a curated extension`,
    );
  }
});
