import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseJsonText } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { hydrateReviewDocument } from "../app/src/review-document-hydrate";
import { reviewAuthoringPropsSchemas } from "./authoring";
import { patchChangedLines } from "./call-stack-diff-test-utils";
