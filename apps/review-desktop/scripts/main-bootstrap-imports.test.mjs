/**
 * Guards the Electron main process's pre-bootstrap window.
 *
 * `code-oss/src/main.ts` runs before anything else. Its `startup()` calls
 * `bootstrapESM()` — which installs `globalThis._VSCODE_NLS_MESSAGES` — and only
 * then dynamically imports `vs/code/electron-main/main.js`. Every *static* import
 * at the top of `main.ts`, and everything those pull in transitively, is evaluated
 * before that message table exists.
 *
 * In a packaged build the NLS mangler rewrites `localize('key', "Text")` into
 * `localize(2488, null)`, and `vs/nls.ts` throws `!!! NLS MISSING: 2488 !!!` when
 * the table is absent. Thrown there, Electron shows a modal that blocks the main
 * thread before any window, renderer, or log line exists: the app never starts and
 * leaves no trace. Review Desktop 0.0.4 shipped exactly this and could not launch.
 *
 * None of it is visible from sources — running from `out/` keeps NLS keys as
 * strings and `localize` returns the English fallback — so this test is the only
 * cheap way to catch it. It reads sources only; no build required.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SRC = fileURLToPath(new URL("../code-oss/src/", import.meta.url));
const ENTRY = path.join(SRC, "main.ts");

/**
 * Modules that must not be evaluated during the pre-bootstrap window.
 *
 * `allowedImporters` keeps an exception a reviewed line rather than a silent
 * hole: the named importer may pull the module in, nothing else may.
 */
const FORBIDDEN_MODULES = [
  {
    module: "vs/platform/configuration/common/configurationRegistry.ts",
    reason:
      "constructs `new ConfigurationRegistry()` at module scope, and that " +
      "constructor calls nls.localize. Importing this module is by itself " +
      "fatal — deleting a registerConfiguration call while keeping a value " +
      "import of Extensions or ConfigurationScope does not help.",
    allowedImporters: [],
  },
  {
    module: "vs/platform/registry/common/platform.ts",
    reason:
      "the Registry singleton. Reaching it means a module-scope " +
      "`Registry.as(...)` registration is running in the main process before " +
      "bootstrapESM(), and those registrations localize their titles.",
    allowedImporters: [],
  },
  {
    module: "vs/nls.ts",
    reason:
      "`localize` throws before bootstrapESM() installs " +
      "globalThis._VSCODE_NLS_MESSAGES.",
    // Upstream edge: platform.ts imports nls only for getNLSLanguage() and the
    // INLSConfiguration type. It calls no localize, at module scope or otherwise.
    allowedImporters: ["vs/base/common/platform.ts"],
  },
];

/**
 * Reachable modules allowed to contain a `localize()` call at all.
 *
 * Add an entry only when the call is provably unreachable during module
 * evaluation — i.e. it sits inside a function that nothing invokes before
 * `bootstrapESM()`. When in doubt, move the value instead of allowlisting.
 */
const LOCALIZE_CALLERS_ALLOWED = [
  "vs/nls.ts", // the definition itself
];

const rel = (file) => path.relative(SRC, file).split(path.sep).join("/");

/**
 * The import specifiers that survive TypeScript's emit.
 *
 * Emit, not regex: `main.ts` imports `INLSConfiguration` and `NativeParsedArgs`
 * without the `type` keyword and both are fully elided, so a textual scan invents
 * runtime edges that do not exist and forces bogus allowlist entries. Dynamic
 * `import()` is not a static edge either, so the walk stops at main.ts's
 * `await import('./vs/code/electron-main/main.js')` for free — that one runs
 * after bootstrapESM() and is legitimate.
 */
function runtimeEdges(file) {
  const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
  const source = ts.createSourceFile(
    "emitted.js",
    emitted,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  return source.statements
    .filter(
      (statement) =>
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier),
    )
    .map((statement) => statement.moduleSpecifier.text);
}

/** Resolve a relative specifier to its `.ts` source, or report it unresolved. */
function resolveToSource(specifier, fromFile) {
  // Bare specifiers are node builtins, electron, or npm deps — not our graph.
  if (!specifier.startsWith(".")) {
    return { external: true };
  }
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    absolute.replace(/\.js$/, ".ts"),
    `${absolute}.ts`,
    path.join(absolute, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { file: candidate };
    }
  }
  return { unresolved: specifier };
}

/** Breadth-first walk from `main.ts`, remembering who first imported each module. */
function walk() {
  const importers = new Map([[rel(ENTRY), null]]);
  const unresolved = [];
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.shift();
    for (const specifier of runtimeEdges(file)) {
      const resolved = resolveToSource(specifier, file);
      if (resolved.external) {
        continue;
      }
      if (resolved.unresolved) {
        unresolved.push(`${rel(file)} -> ${resolved.unresolved}`);
        continue;
      }
      const key = rel(resolved.file);
      if (importers.has(key)) {
        continue;
      }
      importers.set(key, rel(file));
      queue.push(resolved.file);
    }
  }

  return { importers, unresolved };
}

/** Render `main.ts -> ... -> module` so a failure names the edge to cut. */
function chainTo(module, importers) {
  const chain = [];
  for (let at = module; at != null; at = importers.get(at)) {
    chain.unshift(at);
  }
  return chain.join("\n           -> ");
}

function callsLocalize(file) {
  const source = ts.createSourceFile(
    "module.ts",
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      if (name === "localize" || name === "localize2") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

const { importers, unresolved } = walk();

test("every relative import from main.ts resolves to a source file", () => {
  assert.deepEqual(
    unresolved,
    [],
    "an unresolved import means this walk is blind to part of the graph",
  );
});

test("main.ts reaches no module that localizes before bootstrapESM()", () => {
  for (const { module, reason, allowedImporters } of FORBIDDEN_MODULES) {
    const importer = importers.get(module);
    if (importer === undefined || allowedImporters.includes(importer)) {
      continue;
    }
    assert.fail(
      `src/main.ts statically reaches ${module}\n` +
        `  chain: ${chainTo(module, importers)}\n` +
        `  why this is fatal: ${reason}\n` +
        `  fix: move the value you need into an import-free module under\n` +
        `       vs/review/common/ (see reviewConfigurationDefaults.ts), or load\n` +
        `       it behind the dynamic import in startup().`,
    );
  }
});

test("no module reachable from main.ts calls localize", () => {
  // Stronger than the deny list, and the reason this catches the class rather
  // than three known names: ConfigurationRegistry localizes inside its
  // *constructor*, invoked from a module-scope `new`, which no syntactic
  // "top-level call" check can see.
  const offenders = [...importers.keys()]
    .filter((module) => !LOCALIZE_CALLERS_ALLOWED.includes(module))
    .filter((module) => callsLocalize(path.join(SRC, module)))
    .sort();

  assert.deepEqual(
    offenders,
    [],
    "these run before the NLS message table exists; move the localize call " +
      "behind the dynamic import in startup(), or add it to " +
      "LOCALIZE_CALLERS_ALLOWED with a note on why it cannot run at " +
      "module-evaluation time",
  );
});

test("the electron-main bundle stays behind the dynamic import", () => {
  // Making this static would drag the entire workbench registry graph into the
  // pre-bootstrap window.
  assert.equal(
    importers.has("vs/code/electron-main/main.ts"),
    false,
    "vs/code/electron-main/main.ts must not be statically reachable from main.ts",
  );
  assert.match(
    readFileSync(ENTRY, "utf8"),
    /await import\('\.\/vs\/code\/electron-main\/main\.js'\)/,
    "startup() must keep loading electron-main through a dynamic import, after bootstrapESM()",
  );
});

test("the bootstrap crash-note module imports nothing but node builtins", () => {
  // It records a crash that happens before anything else exists, including the
  // NLS table. The tests above already forbid the fatal modules; this one keeps
  // the file at zero in-tree edges, so it cannot acquire one by accident.
  const module = "vs/review/node/reviewBootstrapBreadcrumb.ts";
  assert.ok(
    importers.has(module),
    `${module} must stay reachable from main.ts — it is the only record of a pre-bootstrap crash`,
  );
  const edges = runtimeEdges(path.join(SRC, module));
  assert.deepEqual(
    edges.filter((specifier) => !specifier.startsWith("node:")),
    [],
    `${module} may import node builtins only`,
  );
});
