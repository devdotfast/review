/** rust-analyzer is an optional extension: Review packages nothing and
 *  downloads it from Open VSX only after consent through the in-app picker, so
 *  this journey walks Settings → Tools → Extensions first and is phase 2. It
 *  skips without a Rust toolchain, which rust-analyzer shells out to. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-rust";

export const phase = 2;

export const options = lspOptions("rust");

export const run = (ctx) => runLspJourney(ctx, "rust");
