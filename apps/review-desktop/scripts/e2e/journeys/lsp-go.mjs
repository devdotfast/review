/** The curated `go` group ships no language server: `golang.go` prompts to `go install` gopls, so this is phase 2. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-go";

export const phase = 2;

export const options = lspOptions("go");

export const run = (ctx) => runLspJourney(ctx, "go");
