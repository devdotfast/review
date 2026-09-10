import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeNote } from "@dev.fast/local-vcs";
import type {
  JsonObject,
  JsonValue,
  ReviewVerbResponse,
} from "@dev.fast/review-protocol";
import type { z } from "zod";

import type { ProgressiveReviewTelemetry } from "../progressive-review-telemetry";
import { type StoredReview, createReviewDir } from "../review-home";
import { ReviewPublicationResultSchema } from "../review-lifecycle-contracts";
import type { ReviewActivationHooks } from "../review-publication-activation";
import { SOFTWARE_MAP_NOTES_REF } from "../review-storage";
import { gitRepository, reviewHome } from "../review-test-utils";
import { CANONICAL_SOFTWARE_MAP_MODEL_IMPORT } from "../software-map-artifact";
import {
  type GlobalReviewServer,
  createGlobalReviewServer,
} from "./desktop-server";
import {
  GlobalReviewDesktopVerbRelay,
  type ReviewDesktopVerbRelay,
} from "./global-verb-relay";

export type ReviewPublicationResult = z.infer<
  typeof ReviewPublicationResultSchema
>;

export type VerbResponder = (
  sessionId: string,
  verb: JsonValue,
) => Promise<ReviewVerbResponse>;

/** A running desktop with one publishable Review, driven over its real HTTP
 * boundary. `respond` answers the canvas verbs a test wants to script. */
export interface PublicationHarness {
  home: string;
  source: string;
  sourceCommit: string;
  review: StoredReview;
  server: GlobalReviewServer;
  respond: VerbResponder;
  request(route: string, body?: JsonObject): Promise<Response>;
  publishDocument(body?: JsonObject): Promise<ReviewPublicationResult>;
  publishMap(): Promise<ReviewPublicationResult>;
  /** Drops every in-memory session, so the next open reads storage again. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** A minimal valid software map, written as a note on the pinned commit so
 * `review map publish` can read it. */
export function softwareMapNote(label: string): string {
  return [
    `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
    "",
    `export default defineSoftwareMap({ systems: { app: { label: ${JSON.stringify(label)} } } });`,
    "",
  ].join("\n");
}

export async function publicationHarness(
  options: {
    softwareMap?: string;
    document?: string;
    activationHooks?: ReviewActivationHooks;
    telemetry?: ProgressiveReviewTelemetry;
  } = {},
): Promise<PublicationHarness> {
  const home = await reviewHome();
  // The review record stores a resolved path and `review publish` resolves the
  // checkout root, so the fixture must agree with both on macOS's /private
  // symlink.
  const source = await realpath(await gitRepository());
  const sourceCommit = execFileSync(
    "git",
    ["-C", source, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (options.softwareMap !== undefined) {
    await writeNote({
      rootPath: source,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit: sourceCommit,
      content: options.softwareMap,
    });
  }
  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: sourceCommit,
    sourceCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  await writeFile(
    path.join(review.dir, "review.mdx"),
    options.document ?? "# Published document\n\nFirst publication.\n",
  );
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const token = "publication-harness-token";
  const state = { respond: acceptEveryVerb };
  const startServer = () =>
    createGlobalReviewServer({
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(home, "desktop.json"),
      telemetry: options.telemetry,
      relay: scriptedRelay(() => state.respond),
      publishRuntime: { activationHooks: options.activationHooks },
    });
  let server = startServer();
  await server.listen();
  const request: PublicationHarness["request"] = (route, body) =>
    fetch(`${server.url}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-review-token": token,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const lifecycle = async (route: string, body: JsonObject) =>
    ReviewPublicationResultSchema.parse(
      await (await request(route, body)).json(),
    );
  return {
    home,
    source,
    sourceCommit,
    review,
    get server() {
      return server;
    },
    get respond() {
      return state.respond;
    },
    set respond(responder: VerbResponder) {
      state.respond = responder;
    },
    request,
    publishDocument: (body = {}) =>
      lifecycle("/lifecycle/publish", {
        cwd: source,
        reviewUuid: review.review.uuid,
        ...body,
      }),
    publishMap: () =>
      lifecycle("/lifecycle/map/publish", {
        cwd: source,
        reviewUuid: review.review.uuid,
      }),
    restart: async () => {
      await server.close();
      server = startServer();
      await server.listen();
    },
    close: () => server.close(),
  };
}

const acceptEveryVerb: VerbResponder = async () => ({ ok: true });

/** The desktop's control channel, answered in-process by the test. */
function scriptedRelay(responder: () => VerbResponder): ReviewDesktopVerbRelay {
  const inner = new GlobalReviewDesktopVerbRelay();
  return {
    get attached() {
      return true;
    },
    attach: (writer) => inner.attach(writer),
    dispatch: (sessionId, value) => responder()(sessionId, value),
    acceptResult: (value) => inner.acceptResult(value),
    close: () => inner.close(),
  };
}
