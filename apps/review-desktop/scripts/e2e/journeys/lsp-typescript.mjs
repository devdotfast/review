/** TypeScript ships in tree (`extensions/typescript-language-features`), so this
 *  journey needs no curated extension group. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-typescript";

export const phase = 1;

export const options = lspOptions("typescript");

export const run = (ctx) => runLspJourney(ctx, "typescript");
