/** One reader path, four languages: a code peek, an LSP hover and Go to Definition; the table below is the whole difference. */
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

/** Rewrites PATH so nothing provides `hide`, re-linking `keep` in the temp root when one directory provides both. */
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
    // Specific enough that an echo of the token itself cannot pass for a signature.
    hoverText: /save_order\(order: OrderRecord\)/,
  },
  go: {
    // Not a DEV_REVIEW_EXTENSIONS group: the Go extension installs gopls on activation, so it is downloaded only after consent.
    extensions: "none",
    peekFile: "orders.go",
    symbol: "SaveOrder",
    definitionFile: "storage.go",
    hoverText: /func SaveOrder\(order OrderRecord\) OrderRecord/,
    needsToolchain: "go",
    installsTool: "gopls",
    hoverTimeout: 300000, // gopls is built from source under a fresh HOME, so the caches start empty.
    // Unset, every Go install and cache path sits under the temp $HOME; an empty value is a deletion.
    env: {
      GOPATH: "",
      GOBIN: "",
      GOMODCACHE: "",
      GOCACHE: "",
      GOFLAGS: "",
      GOENV: "",
    },
    optionalExtension: {
      label: "Go",
      extensionId: "golang.go",
    },
    // The Go extension provisions gopls only when PATH has none, which is the reader this journey stands in for.
    beforeLaunch: async (ctx) => {
      ctx.env.PATH = await hideToolFromPath(ctx, "gopls", "go");
    },
  },
  rust: {
    // Not a DEV_REVIEW_EXTENSIONS group: rust-analyzer is tier "optional", downloaded only after consent in the picker.
    extensions: "none",
    peekFile: "src/lib.rs",
    symbol: "save_order",
    definitionFile: "src/storage.rs",
    hoverText: /fn save_order\(order: OrderRecord\) -> OrderRecord/,
    needsToolchain: "cargo",
    hoverTimeout: 300000, // A cold CARGO_HOME builds proc macros while the reader is already hovering.
    // How the extension's own log separates a server that never started from one that is merely slow.
    serverStartLog: {
      extensionId: "rust-lang.rust-analyzer",
      activated: "Starting language client",
      started: "Using server binary at",
      failed: "Bootstrap error", // A server that could not be unpacked logs this instead: a different bug.
    },
    optionalExtension: {
      label: "Rust (rust-analyzer)",
      extensionId: "rust-lang.rust-analyzer",
    },
    // rust-analyzer needs the real RUSTUP_HOME to find a toolchain; an empty value is a deletion, so a machine without rustup skips.
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

/** The harness options for a language's journey. */
export function lspOptions(id) {
  const { extensions, env, beforeLaunch } = LANGUAGES[id];

  return { extensions, env, beforeLaunch };
}

/** Skips the journey when `tool` is missing or cannot answer under the isolated HOME. */
async function requireToolchain(ctx, tool) {
  for (const [command, ...args] of [
    ["which", tool],
    [tool, "version"],
  ])
    try {
      await exec(command, args, { env: ctx.env, cwd: ctx.repo });
    } catch (error) {
      // A command that answered carries an exit status; one that could not be spawned carries a syscall, and is our fault.
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

/** True when the extension activated and then never even tried to start its server. */
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

/** `go install` writes to GOPATH/bin, and GOPATH defaults to $HOME/go inside the temp root. */
const goToolPath = (ctx, tool) => path.join(ctx.home, "go/bin", tool);

/** Nothing the Go extension downloads may exist before the reader consents to its group. */
async function assertNothingInstalledYet(ctx, tool) {
  assert.equal(
    await access(goToolPath(ctx, tool)).then(() => true, () => false),
    false,
    `${tool} was installed before the Go group was consented to`,
  );
  assert.deepEqual(
    (
      await readdir(path.join(ctx.userData, "logs"), {
        recursive: true,
      }).catch(() => [])
    ).filter((entry) => entry.includes(path.join("exthost", "golang.go"))),
    [],
    "the Go extension activated before its group was consented to",
  );
}

/** Waits for the consented-to Go extension to provision `tool` into the journey's GOPATH. */
async function provisionLanguageServer(ctx, tool) {
  await ctx.until(
    () => access(goToolPath(ctx, tool)).then(() => true, () => false),
    `${tool} to be installed into the journey's GOPATH`,
    300000,
  );
  ctx.check(`go: ${tool} is installed only after the Go group is consented to`);
}

/** Commits the fixture, creates a review whose code_peek covers the call site, hovers the call and presses F12. */
export async function runLspJourney(ctx, id) {
  const language = LANGUAGES[id];

  // Covers an explicit `--journey lsp-go` on a machine that never opted into the network.
  if (
    (language.needsToolchain || language.optionalExtension) &&
    process.env.REVIEW_E2E_NETWORK !== "1"
  )
    throw new Error(`skip: ${id} needs REVIEW_E2E_NETWORK=1`);

  if (language.needsToolchain)
    await requireToolchain(ctx, language.needsToolchain);

  // Before the review exists: the picker ends in a window reload that would take the open review with it.
  if (language.optionalExtension) {
    if (language.installsTool)
      await assertNothingInstalledYet(ctx, language.installsTool);
    await installExtensionGroup(ctx, language.optionalExtension);
  }

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
          file: language.peekFile,
          start: { side: "head", line: callLine },
          end: { side: "head", line: callLine },
        },
      },
    ],
  });

  let canvas = review.canvas;

  // rust-analyzer can lose a race with the workspace folder, and only a race earns a retry in another window.
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

/** The reader's half: from the open review to the modal editor Go to Definition opens. */
async function hoverAndJump(ctx, id, language, canvas, lines, callLine) {
  const page = canvas.page();

  const editor = canvas
    .locator(
      `.review-inline-editor[data-review-inline-editor="${language.peekFile}"]`,
    )
    .first();

  await editor.locator(".view-line").first().waitFor({ timeout: 60000 });

  // The peek opens the language's first document, so the extension activates only once it is on screen.
  if (language.installsTool)
    await provisionLanguageServer(ctx, language.installsTool);

  const callRow = editor
    .locator(".view-line")
    .filter({ hasText: lines[callLine - 1].trim() })
    .first();

  const token = callRow.locator("span", { hasText: language.symbol }).last();

  await token.waitFor({ timeout: 60000 });

  // Monaco merges adjacent same-colour tokens, so aim at the symbol's own characters; the editor font is monospaced.
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

  // Monaco computes a hover once per pointer position, so each retry steps off the token onto the inert indentation.
  const hover = page.locator(".monaco-hover-content:visible").first();

  // `.monaco-hover-content` is shared with every workbench hover, so only its contents prove it belongs to the call.
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

  // Go to Definition opens the file in the modal editor, whose header carries the resolved label: the cross-file evidence.
  const modalTitle = page
    .locator(".monaco-modal-editor-block .modal-editor-title")
    .first();

  // The label is the file name, not its path in the repository.
  const definitionName = path.basename(language.definitionFile);

  await ctx.until(
    async () => (await modalTitle.innerText().catch(() => "")).includes(definitionName),
    `${id} Go to Definition to open ${language.definitionFile} in the modal editor`,
    60000,
  );
  ctx.check(`${id}: go to definition crosses files`);

  await dismissModalEditor(ctx, page);
}
