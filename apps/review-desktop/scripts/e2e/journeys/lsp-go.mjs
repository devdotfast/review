/** Exercises bundled go language support with a local toolchain. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-go";

export const phase = 2;

export const options = lspOptions("go");

export const run = (ctx) => runLspJourney(ctx, "go");
