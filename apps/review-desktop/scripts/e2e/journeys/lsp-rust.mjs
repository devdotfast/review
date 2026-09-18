/** rust-analyzer is downloaded from Open VSX only after consent in the picker, so this journey walks Settings first and is phase 2. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-rust";

export const phase = 2;

export const options = lspOptions("rust");

export const run = (ctx) => runLspJourney(ctx, "rust");
