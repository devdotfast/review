/** The curated `go` group carries the Go extension but no language server:
 *  `golang.go` ships none, and prompts to `go install` gopls against the
 *  reader's own toolchain. That install is a network download and a from-source
 *  build, so this journey is phase 2 and skips without a Go toolchain. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-go";

export const phase = 2;

export const options = lspOptions("go");

export const run = (ctx) => runLspJourney(ctx, "go");
