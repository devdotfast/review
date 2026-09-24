/** Exercises bundled rust language support with a local toolchain. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-rust";

export const phase = 2;

export const options = lspOptions("rust");

export const run = (ctx) => runLspJourney(ctx, "rust");
