import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { parseShareLink, shareIdSchema } from "@dev.fast/review-share-protocol";
import {
  DEFAULT_STORE_ORIGIN,
  clearStoreAuth,
  openUrlInBrowser,
  readStoreAuth,
  runStoreLogin,
} from "@dev.fast/trace-core";
import type { Hono } from "hono";
import { z } from "zod";

import { ReviewInputError } from "../review-api/document.js";
import type { LocalReviewData } from "../review-api/local-data.js";
import type { ReviewStore } from "../review-api/store.js";
import { readBoundedRequestJson } from "../server/hono-http.js";
import { readSharingAuth } from "./auth.js";
import { ShareAuthError, ShareClient, SharePreflightError } from "./client.js";
import { exportShare } from "./export.js";
import { SharedReviewStore, sharedReviewId } from "./import.js";
import { readShareRepository, verifyShareRepository } from "./repository.js";

interface LoginState {
  pending: boolean;
  url?: string;
  error?: string;
}

const publishSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  requestId: z.uuid().optional(),
});

interface SharingHostOptions {
  verifyRepository?: typeof verifyShareRepository;
  readRepository?: typeof readShareRepository;
  login?: typeof runStoreLogin;
  openUrl?: typeof openUrlInBrowser;
  fetch?: typeof fetch;
}

/** Mounted behind local host authentication. Account credentials never enter the renderer. */
export function mountSharingHost(
  app: Hono,
  store: ReviewStore,
  data: LocalReviewData,
  shared: SharedReviewStore,
  options: SharingHostOptions = {},
) {
  const startLogin = options.login ?? runStoreLogin;
  const openUrl = options.openUrl ?? openUrlInBrowser;

  let login: LoginState = {
    pending: false,
  };

  app.get("/sharing/account", async (context) => {
    const account = await readStoreAuth();

    return context.json({
      account: account
        ? { login: account.login, origin: account.origin }
        : null,
      ...login,
    });
  });
  app.post("/sharing/logout", async (context) => {
    await clearStoreAuth();

    return context.json({ ok: true });
  });
  app.post("/sharing/login", async (context) => {
    if (!login.pending) {
      login = { pending: true };

      const discard = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });

      void startLogin({
        traces: false,
        stdout: discard,
        stderr: discard,
        openUrl: async (url) => {
          login.url = url;
          await openUrl(url);
        },
      })
        .then((code) => {
          login = { pending: false };

          if (code) login.error = "Sign-in did not finish. Try again.";
        })
        .catch(() => {
          login = { pending: false, error: "Sign-in failed. Try again." };
        });
    }

    return context.json(login);
  });
  mountSharingPublisher(app, store, data, options);
  const imports = new Map<string, Promise<void>>();
  app.get("/sharing/import/:id", (context) => {
    const id = context.req.param("id");
    const status = shared.status(id);

    const result = { reviewId: id, ...status };

    if (status.stage === "ready")
      return context.json({ ...result, title: shared.get(id).snapshot.title });

    return context.json(result);
  });
  app.post("/sharing/import", async (context) => {
    const { url } = z
      .strictObject({ url: z.string().max(2048) })
      .parse(await readBoundedRequestJson(context.req.raw));

    const parsed = parseShareLink(url);
    const account = await readStoreAuth();

    if (
      parsed.origin !== DEFAULT_STORE_ORIGIN &&
      parsed.origin !== account?.origin
    )
      throw new ReviewInputError(
        "This share uses an untrusted service. Sign in to that service before opening its links.",
        400,
      );
    const id = sharedReviewId(parsed.origin, parsed.shareId);

    if (!imports.has(id)) {
      shared.setStatus(id, "downloading");

      const job = (async () => {
        if (shared.has(id)) {
          // Retained bytes survive a failed fetch and let retries work offline.
          await shared.prepare(id);

          return;
        }

        const bundle = await new ShareClient(parsed.origin).download(
          parsed.shareId,
          parsed.capability,
        );

        await shared.import(parsed.origin, parsed.shareId, bundle);
      })()
        .catch((error) => {
          shared.setStatus(
            id,
            "error",
            error instanceof ReviewInputError
              ? error.message
              : "This share is unavailable, revoked, or needs a newer Review version.",
          );
        })
        .finally(() => imports.delete(id));

      imports.set(id, job);
      shared.trackImport(job);
    }

    return context.json({ reviewId: id, ...shared.status(id) }, 202);
  });
}

/** Publishing needs only an authored store, never Desktop or recipient workspaces. */
export function mountSharingPublisher(
  app: Hono,
  store: ReviewStore,
  data: LocalReviewData,
  options: Pick<
    SharingHostOptions,
    "verifyRepository" | "readRepository" | "fetch"
  > = {},
) {
  const verifyRepository = options.verifyRepository ?? verifyShareRepository;
  app.post("/sharing/publish", async (context) => {
    const input = publishSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (input.reviewId.startsWith("shared-"))
      throw new ReviewInputError(
        "Only the authoring review can be shared.",
        409,
      );
    const snapshot = store.read(input.reviewId, input.version);

    if (snapshot.target.kind === "worktree")
      throw new ReviewInputError(
        "Pin this review to commits before sharing it.",
      );
    const account = await readSharingAuth();

    if (!account)
      throw new ReviewInputError(
        "Set DEV_REVIEW_SHARE_TOKEN for CI, or run review login before sharing.",
        409,
      );

    const root = store.repositoryPath(snapshot.pins.repositoryId);

    const repository = await (options.readRepository ?? readShareRepository)(
      root,
    );

    const verification = verifyRepository(root, snapshot.pins, repository).then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, error }),
    );

    const bundle = await exportShare({
      store,
      data,
      reviewId: input.reviewId,
      version: snapshot.version,
      repository,
    });

    try {
      const result = await new ShareClient(
        account.origin,
        account.token,
        options.fetch,
      ).create(bundle, input.requestId ?? randomUUID(), async () => {
        const result = await verification;

        if (!result.ok) throw result.error;
      });

      return context.json({ ...result, version: snapshot.version });
    } catch (error) {
      if (error instanceof SharePreflightError)
        return context.json({ error: error.message }, 422);

      if (error instanceof ShareAuthError) {
        // A CI token lives in the environment; only the saved login can go stale.
        if (process.env.DEV_REVIEW_SHARE_TOKEN === undefined)
          await clearStoreAuth();
        throw new ReviewInputError(
          "Your sign-in has expired. Sign in again to share.",
          401,
        );
      }

      throw new ReviewInputError(
        "Sharing failed. Check your connection and login, then retry.",
        409,
      );
    }
  });
  app.post("/sharing/revoke", async (context) => {
    const { shareId } = z
      .strictObject({ shareId: shareIdSchema })
      .parse(await readBoundedRequestJson(context.req.raw));

    const account = await readSharingAuth();

    if (!account)
      throw new ReviewInputError(
        "Set DEV_REVIEW_SHARE_TOKEN for CI, or run review login first.",
        409,
      );
    await new ShareClient(account.origin, account.token).revoke(shareId);

    return context.json({ shareId, revoked: true });
  });
}
