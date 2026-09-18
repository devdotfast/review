/** The curated `python` group (`ms-python.python`, `astral-sh.ty`,
 *  `charliermarsh.ruff`) carries its servers inside the VSIXes, so this journey
 *  is offline once `run.sh` has materialized the group once. */
import { lspOptions, runLspJourney } from "../lsp-languages.mjs";

export const name = "lsp-python";

export const phase = 1;

export const options = lspOptions("python");

export const run = (ctx) => runLspJourney(ctx, "python");
