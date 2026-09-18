/** One reader path, four languages: a code peek over a call site, a hover that
 *  only a running language server can answer, and Go to Definition crossing
 *  into the file that declares the symbol. The table below is the whole
 *  per-language difference; `journeys/lsp-*.mjs` are thin wrappers over it. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createReview,
  dismissModalEditor,
  installExtensionGroup,
} from "./harness.mjs";

const exec = promisify(execFile);

/** The first directory on `search` with an executable `tool` in it. */
function resolveTool(tool, search) {
  return search.split(path.delimiter).find((entry) => {
    if (!entry) return false;

    try {
      accessSync(path.join(entry, tool), constants.X_OK);

      return true;
    } catch {
      return false;
    }
  });
}

/** Rewrites the journey's PATH so nothing on it provides `hide` any more, while
 *  `keep` stays reachable. Dropping the directories that provide `hide` is not
 *  enough on its own: `brew install go` and `brew install gopls` land in the
 *  same directory, so the scrub can take the toolchain with it and the journey
 *  would skip itself for a reason that is not true. A link of this journey's
 *  own, inside the temp root, puts just the toolchain back. */
async function hideToolFromPath(ctx, hide, keep) {
  const search = ctx.env.PATH ?? "";

  const toolchain = resolveTool(keep, search);

  const kept = search
    .split(path.delimiter)
    .filter((entry) => entry && !resolveTool(hide, entry))
    .join(path.delimiter);

  if (!toolchain || resolveTool(keep, kept)) return kept;

  const directory = path.join(ctx.root, "toolchain");

  await mkdir(directory, { recursive: true });
  await symlink(path.join(toolchain, keep), path.join(directory, keep));

  return [directory, kept].join(path.delimiter);
}

export const LANGUAGES = {
  typescript: {
    extensions: "none",
    peekFile: "orders.ts",
    symbol: "saveOrder",
    definitionFile: "storage.ts",
    hoverText: /saveOrder\(order: OrderRecord\)/,
  },
  python: {
    extensions: "python",
    peekFile: "orders.py",
    symbol: "save_order",
    definitionFile: "storage.py",
    // ty answers `def save_order(order: OrderRecord) -> OrderRecord`; the
    // brief's `/save_order/` would also pass on an echo of the token itself.
    hoverText: /save_order\(order: OrderRecord\)/,
  },
  go: {
    extensions: "go",
    peekFile: "orders.go",
    symbol: "SaveOrder",
    definitionFile: "storage.go",
    hoverText: /func SaveOrder\(order OrderRecord\) OrderRecord/,
    needsToolchain: "go",
    installsTool: "gopls",
    // gopls is built from source on the reader's machine, and the journey's
    // HOME is a fresh temp root, so the module and build caches start empty.
    hoverTimeout: 300000,
    // Every Go path an ambient shell could redirect. Unset, the install and
    // its caches all sit under $HOME, which is the temp root: GOPATH/GOBIN
    // decide where the binary lands, GOMODCACHE and GOCACHE where the module
    // and build caches go, and GOFLAGS/GOENV could reintroduce any of them.
    // An empty value is a deletion (`harness.mjs:98-101`).
    env: {
      GOPATH: "",
      GOBIN: "",
      GOMODCACHE: "",
      GOCACHE: "",
      GOFLAGS: "",
      GOENV: "",
    },
    // The Go extension provisions gopls only when it cannot find one
    // (`golang.go/dist/goMain.js`, `getMissingTools`), and a developer machine
    // usually has one on PATH already. Taking it off the journey's PATH is
    // what puts this journey on the path a reader without Go tooling takes.
    beforeLaunch: async (ctx) => {
      ctx.env.PATH = await hideToolFromPath(ctx, "gopls", "go");
    },
  },
  rust: {
    // Not a DEV_REVIEW_EXTENSIONS group: rust-analyzer is `tier: "optional"`
    // (`curated-extensions.manifest.mjs:63-96`), downloaded from Open VSX only
    // after consent through the in-app picker, which is what this journey
    // walks.
    extensions: "none",
    peekFile: "src/lib.rs",
    symbol: "save_order",
    definitionFile: "src/storage.rs",
    hoverText: /fn save_order\(order: OrderRecord\) -> OrderRecord/,
    needsToolchain: "cargo",
    // A cold CARGO_HOME means the first `cargo metadata` and proc-macro build
    // happen while the reader is already hovering.
    hoverTimeout: 300000,
    // How the extension's own log tells a server that never started from one
    // that is merely slow: `Ctx.start` logs the first line either way, and
    // only `getOrCreateClient` past its `kind !== "Empty"` guard logs the
    // second (`out/main.js`).
    serverStartLog: {
      extensionId: "rust-lang.rust-analyzer",
      activated: "Starting language client",
      started: "Using server binary at",
      // A server that could not be unpacked or run logs this instead, and is a
      // different bug from the one the retry corroborates (`Ctx.bootstrap`).
      failed: "Bootstrap error",
    },
    optionalExtension: {
      label: "Rust (rust-analyzer)",
      extensionId: "rust-lang.rust-analyzer",
    },
    // rust-analyzer shells out to `cargo`, which on this machine is a rustup
    // shim: under the journey's temp HOME it finds no toolchain unless
    // RUSTUP_HOME still points at the real one. This is the one deliberate
    // exception to keeping everything inside the temp root — the real rustup
    // home is read, never written, and installing a toolchain of the
    // journey's own would be a gigabyte of download per run. An unset value
    // is a deletion (`harness.mjs:98-101`), so a machine without rustup skips
    // instead.
    env: { RUSTUP_HOME: process.env.RUSTUP_HOME ?? rustupHome() },
    // Everything cargo writes for itself stays inside the temp root.
    beforeLaunch: (ctx) => {
      ctx.env.CARGO_HOME = path.join(ctx.root, "cargo-home");
    },
  },
};

/** The default rustup home, or "" when this machine has none. */
function rustupHome() {
  const home = path.join(os.homedir(), ".rustup");

  try {
    accessSync(home, constants.R_OK);

    return home;
  } catch {
    return "";
  }
}

/** The harness options for a language's journey. Language-specific setup lives
 *  in the table, not in the wrappers. */
export function lspOptions(id) {
  const { extensions, env, beforeLaunch } = LANGUAGES[id];

  return { extensions, env, beforeLaunch };
}

/** A toolchain this journey cannot install for itself. `which` says whether the
 *  tool exists at all; `<tool> version` says whether it can still answer under
 *  the journey's isolated HOME, which a rustup shim without RUSTUP_HOME cannot.
 *  Either answer skips the journey — and only those two: a command that could
 *  not be spawned at all, or anything else this function gets wrong, is a fault
 *  in the journey and must not read as a missing toolchain. */
async function requireToolchain(ctx, tool) {
  for (const [command, ...args] of [
    ["which", tool],
    [tool, "version"],
  ])
    try {
      await exec(command, args, { env: ctx.env, cwd: ctx.repo });
    } catch (error) {
      // A command that ran and answered carries an exit status; one that could
      // not be spawned carries a syscall instead, and is a fault in the
      // journey — except `which` itself being absent, which is still an answer
      // about this machine.
      if (error.syscall && error.code !== "ENOENT") throw error;

      const reason = (error.stderr || error.message)
        .split("\n")
        .find((line) => line.trim())
        ?.trim();

      throw new Error(
        `skip: ${tool} toolchain missing (${[command, ...args].join(" ")}: ${reason})`,
      );
    }
}

/** The newest log the extension wrote in this profile, across windows. */
async function extensionLog(ctx, extensionId) {
  const logs = path.join(ctx.userData, "logs");

  const candidates = (
    await readdir(logs, { recursive: true }).catch(() => [])
  ).filter(
    (entry) =>
      entry.includes(path.join("exthost", extensionId)) &&
      entry.endsWith(".log"),
  );

  let newest;

  for (const candidate of candidates) {
    const file = path.join(logs, candidate);

    const at = (await stat(file)).mtimeMs;

    if (!newest || at > newest.at) newest = { file, at };
  }

  return newest ? readFile(newest.file, "utf8") : "";
}

/** True when the extension activated and then never even tried to start its
 *  server — not when it tried and failed, which is another bug entirely. */
async function serverNeverStarted(
  ctx,
  { extensionId, activated, started, failed },
) {
  const log = await extensionLog(ctx, extensionId);

  return (
    log.includes(activated) && !log.includes(started) && !log.includes(failed)
  );
}

/** The same review, in the window a restart left behind. */
async function reopenReview(ctx, review) {
  const opened = await ctx.api(`/reviews-api/${review.reviewId}/open`, "POST", {});

  assert.equal(opened.status, 200, JSON.stringify(opened.value));

  const page = await ctx.apiCanvasFor(review.title);

  return page.locator(".review-canvas-root [data-review-api]");
}

/** The Go extension carries no server of its own: it provisions `gopls` against
 *  the machine's Go toolchain the first time a Go file is opened. In
 *  `golang.go@0.56.0` that happens twice over, without asking —
 *  `maybeInstallImportantTools` installs every missing "important" tool on
 *  activation (`dist/goMain.js`, `installTools` → `go install -v
 *  golang.org/x/tools/gopls@latest`), and only a tool needed later, after that
 *  pass, still reaches the prompt this waits for in parallel
 *  (`promptForMissingTool`: `The "gopls" command is not available. Run "<cmd>"
 *  to install.` with an `Install` action). Either way the binary lands in the
 *  journey's own GOPATH under the temp HOME, and the extension starts the
 *  language server itself once the build finishes. */
async function provisionLanguageServer(ctx, page, tool) {
  // "Install All" is offered beside it whenever another important Go tool is
  // missing too, and this journey wants only the language server.
  const install = page
    .locator(".notifications-toasts .notification-list-item")
    .filter({ hasText: `The "${tool}" command is not available.` })
    .first()
    .getByRole("button", { name: "Install", exact: true });

  let asked = false;

  // `go install` writes to GOPATH/bin, and GOPATH defaults to $HOME/go, which
  // is inside the temp root. Building gopls from source on a cold module and
  // build cache is the slow part.
  const binary = path.join(ctx.home, "go/bin", tool);

  await ctx.until(
    async () => {
      if (await access(binary).then(() => true, () => false)) return true;

      if (await install.isVisible().catch(() => false)) {
        await install.click();
        asked = true;
      }

      return false;
    },
    `${tool} to be installed into the journey's GOPATH`,
    300000,
  );

  if (asked) {
    ctx.check(`go: the missing ${tool} prompt offers to install it in app`);

    return;
  }

  await ctx.knownBug(
    "Opening a Go file installs Go tools from the network without asking",
  );
  ctx.check(`go: the Go extension provisions ${tool} into the journey's GOPATH`);
}

/** Commits the fixture into ctx.repo, creates a review whose code_peek covers
 *  the call site, opens it, hovers the call and presses F12. */
export async function runLspJourney(ctx, id) {
  const language = LANGUAGES[id];

  // run.mjs already keeps phase 2 out of the default selection; this also
  // covers an explicit `--journey lsp-go` on a machine that never opted in,
  // where the journey would otherwise reach the network.
  if (
    (language.needsToolchain || language.optionalExtension) &&
    process.env.REVIEW_E2E_NETWORK !== "1"
  )
    throw new Error(`skip: ${id} needs REVIEW_E2E_NETWORK=1`);

  if (language.needsToolchain)
    await requireToolchain(ctx, language.needsToolchain);

  // Consent, download and install before the review exists: the picker ends in
  // a window reload, which would take the open review with it.
  if (language.optionalExtension)
    await installExtensionGroup(ctx, language.optionalExtension);

  await cp(path.join(import.meta.dirname, "fixtures/lsp", id), ctx.repo, {
    recursive: true,
  });
  await ctx.git("add", ".");
  await ctx.git("commit", "-qm", `Add ${id} fixture`);

  const head = await ctx.git("rev-parse", "HEAD");

  const lines = (
    await readFile(path.join(ctx.repo, language.peekFile), "utf8")
  ).split("\n");

  // The import names the symbol too; the peek has to land on the call.
  const callLine =
    lines.findIndex(
      (line) =>
        line.includes(language.symbol) && !/^(import|from)\b/.test(line),
    ) + 1;

  assert.ok(
    callLine > 0,
    `${language.peekFile} does not call ${language.symbol}`,
  );

  const review = await createReview(ctx, {
    title: `${id} peek`,
    head,
    blocks: [
      {
        type: "code_peek",
        source: {
          side: "head",
          file: language.peekFile,
          fromLine: callLine,
          toLine: callLine,
        },
      },
    ],
  });

  let canvas = review.canvas;

  // rust-analyzer decides once, while it activates, whether it has a workspace
  // at all, and a window that lost that race never gets a language server —
  // see the bugs-log entry this corroborates. It is a race, so another window
  // is a fair retry; every other language fails on the spot, as before.
  for (let attempt = 1; ; attempt++) {
    try {
      await hoverAndJump(ctx, id, language, canvas, lines, callLine);

      return;
    } catch (error) {
      if (
        attempt >= 3 ||
        !language.serverStartLog ||
        !(await serverNeverStarted(ctx, language.serverStartLog))
      )
        throw error;

      await ctx.knownBug(
        "A review's Rust language server never starts when the extension wins a race with the workspace folder",
      );
      await ctx.restartDesktop();
      canvas = await reopenReview(ctx, review);
    }
  }
}

/** The reader's half of the journey, from the open review to the modal editor
 *  that Go to Definition opens. Separate from the setup so a language whose
 *  server can fail to start at all can be given another window (see
 *  `runLspJourney`). */
async function hoverAndJump(ctx, id, language, canvas, lines, callLine) {
  const page = canvas.page();

  const editor = canvas
    .locator(
      `.review-inline-editor[data-review-inline-editor="${language.peekFile}"]`,
    )
    .first();

  await editor.locator(".view-line").first().waitFor({ timeout: 60000 });

  // The peek is what opens the language's first document, so the extension
  // only activates — and only asks for its server — once it is on screen.
  if (language.installsTool)
    await provisionLanguageServer(ctx, page, language.installsTool);

  // The call line, not the import line above it, which names the symbol too.
  const callRow = editor
    .locator(".view-line")
    .filter({ hasText: lines[callLine - 1].trim() })
    .first();

  const token = callRow.locator("span", { hasText: language.symbol }).last();

  await token.waitFor({ timeout: 60000 });

  // Monaco merges adjacent tokens that share a colour, so the call name is not
  // always a span of its own: Python renders `return save_order(` with
  // `<span class="mtk1">&nbsp;save_order</span>`. Aim at the symbol's own
  // characters inside whichever span carries them — the editor font is
  // monospaced, so the offset is exact.
  const aim = async () => {
    const text = await token.textContent();

    const box = await token.boundingBox();

    const index = text?.indexOf(language.symbol) ?? -1;

    assert.ok(
      box && index >= 0,
      `${language.symbol} is not rendered in the peek`,
    );

    return {
      x: (box.width * (index + language.symbol.length / 2)) / text.length,
      y: box.height / 2,
    };
  };

  // Only the extension host can fill a hover for this token, and a bundled
  // server takes seconds to come up, so keep hovering until it answers.
  // Monaco computes a hover once per pointer position, so each retry has to
  // step off the token first: without that, a server that was still starting
  // on the first pass is never asked again. The resting place is the call
  // line's own indentation — inert (no word under the pointer, so no hover)
  // and inside the peek, unlike the window corner, where a workbench tooltip
  // could be showing when the read lands.
  const hover = page.locator(".monaco-hover-content:visible").first();

  // `.monaco-hover-content` is shared with every other workbench hover
  // (`hoverWidget.ts:39`) and the widget is not a descendant of the token, so
  // only the expected contents prove this one belongs to the call.
  const hovered = await ctx.until(
    async () => {
      const point = await aim();

      await callRow.hover({ position: { x: 1, y: 2 } });
      await token.hover({ position: point });
      await page.waitForTimeout(700);

      const text = (await hover.innerText().catch(() => "")).trim();

      return language.hoverText.test(text) ? text : null;
    },
    `${id} hover contents matching ${language.hoverText}`,
    language.hoverTimeout ?? 90000,
  );

  assert.match(hovered, language.hoverText);
  ctx.check(`${id}: hover shows the signature from the language server`);

  await page.keyboard.press("Escape");
  await token.click({ position: await aim() });
  await page.keyboard.press("F12");

  // Go to Definition resolves to the file on disk
  // (`reviewUnifiedDefinition.ts:74-88`), which the workbench opens in the
  // modal editor over the canvas — not as another inline editor or a workbench
  // tab. Its header carries the resolved resource's label
  // (`modalEditorPart.ts:242`, `:366`), so that is the cross-file evidence.
  const modalTitle = page
    .locator(".monaco-modal-editor-block .modal-editor-title")
    .first();

  // The label is the resource's file name, not its path in the repository, so
  // a fixture whose definition sits in a subdirectory is matched by its name.
  const definitionName = path.basename(language.definitionFile);

  await ctx.until(
    async () => (await modalTitle.innerText().catch(() => "")).includes(definitionName),
    `${id} Go to Definition to open ${language.definitionFile} in the modal editor`,
    60000,
  );
  ctx.check(`${id}: go to definition crosses files`);

  // Leave the reader back on the review rather than under the modal.
  await dismissModalEditor(ctx, page);
}
