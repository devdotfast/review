import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { parseShareLink, shareIdSchema } from "@dev.fast/review-share-protocol";
import {
  DEFAULT_STORE_ORIGIN,
  clearStoreAuth,
  readStoreAuth,
  runStoreLogin,
} from "@dev.fast/trace-core";
import type { Hono } from "hono";
import { z } from "zod";

import { ReviewInputError } from "../review-api/document.js";
import type { LocalReviewData } from "../review-api/local-data.js";
import type { ReviewStore } from "../review-api/store.js";
import { readBoundedRequestJson } from "../server/hono-http.js";
import { ShareClient } from "./client.js";
import { cloneSharedRepository } from "./clone.js";
import { exportShare } from "./export.js";
import { SharedReviewStore, sharedReviewId } from "./import.js";

interface LoginState {
  pending: boolean;
  url?: string;
  error?: string;
}

const exec = promisify(execFile);

const publishSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  requestId: z.uuid().optional(),
});

/** Mounted behind local host authentication. Account credentials never enter the renderer. */
export function mountSharingHost(
  app: Hono,
  store: ReviewStore,
  data: LocalReviewData,
  shared: SharedReviewStore,
) {
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

      const stdout = new Writable({
        write(chunk, _encoding, done) {
          try {
            const event = z
              .object({ status: z.string(), url: z.string().optional() })
              .parse(JSON.parse(String(chunk)));

            if (event.status === "pending") login.url = event.url;
          } catch {
            /* Human output is discarded. */
          }

          done();
        },
      });

      const stderr = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });

      void runStoreLogin({ traces: false, stdout, stderr, json: true })
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
    const account = await readStoreAuth();

    if (!account)
      throw new ReviewInputError(
        "Run review login or sign in before sharing.",
        409,
      );
    let repository: { cloneUrl: string } | undefined;

    try {
      const remote = (
        await exec(
          "git",
          [
            "-C",
            store.repositoryPath(snapshot.pins.repositoryId),
            "remote",
            "get-url",
            "origin",
          ],
          {
            cwd: store.repositoryPath(snapshot.pins.repositoryId),
          },
        )
      ).stdout.trim();

      const normalized = remote.replace(
        /^git@github\.com:/,
        "https://github.com/",
      );

      const url = new URL(normalized);

      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        repository = { cloneUrl: url.href };
    } catch {
      /* Repositories without a usable remote can still be shared. */
    }

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
      ).create(bundle, input.requestId ?? randomUUID());

      return context.json({ ...result, version: snapshot.version });
    } catch {
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

    const account = await readStoreAuth();

    if (!account) throw new ReviewInputError("Run review login first.", 409);
    await new ShareClient(account.origin, account.token).revoke(shareId);

    return context.json({ shareId, revoked: true });
  });
  app.post("/sharing/clone", async (context) => {
    const { reviewId } = z
      .strictObject({ reviewId: z.string().regex(/^shared-[a-f0-9]{64}$/) })
      .parse(await readBoundedRequestJson(context.req.raw));

    try {
      await cloneSharedRepository(shared, reviewId);

      return context.json({ attached: true });
    } catch {
      throw new ReviewInputError(
        "Could not clone the repository at the shared commits. Check your GitHub repository access.",
        409,
      );
    }
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

    try {
      const existing = shared.get(id);

      return context.json({ reviewId: id, title: existing.snapshot.title });
    } catch {
      /* Download only when not cached. */
    }

    try {
      const bundle = await new ShareClient(parsed.origin).download(
        parsed.shareId,
        parsed.capability,
      );

      await shared.import(parsed.origin, parsed.shareId, bundle);

      return context.json({ reviewId: id, title: bundle.manifest.title });
    } catch {
      throw new ReviewInputError(
        "This share is unavailable, revoked, or needs a newer Review version.",
        404,
      );
    }
  });
}
