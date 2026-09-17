import { Hono } from "hono";
import { z } from "zod";

import { AgentSelectionSchema, selectionMarkdown } from "../agent-selection.js";
import { resolveReviewStackLayers } from "../review-stack.js";
import { readBoundedRequestJson } from "../server/hono-http.js";
import { HttpJsonError } from "../server/http-json.js";
import { authoringTools } from "./authoring-tools.js";
import { documentText } from "./document-text.js";
import { ReviewInputError, sourceSchema } from "./document.js";
import type { LocalReviewData } from "./local-data.js";
import { inspectQuerySchema, readQuerySchemas } from "./read-schemas.js";
import type { ReviewStore, Snapshot } from "./store.js";
import { listPinnedTraces, readStoredTrace } from "./traces.js";

/** Mounted behind the desktop server's existing token authentication. */
export function createReviewApi(
  store: ReviewStore,
  data?: LocalReviewData,
  open?: (review: {
    reviewId: string;
    title: string;
  }) => Promise<{ softwareMapEnabled: boolean }>,
) {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HttpJsonError)
      return context.json({ error: error.message }, error.statusCode);

    if (error instanceof ReviewInputError)
      return context.json({ error: error.message }, error.status);

    // A readable message for agents and the canvas; issues stay for programs.
    if (error instanceof z.ZodError)
      return context.json(
        { error: z.prettifyError(error), issues: error.issues },
        400,
      );

    // Provider failures may contain local paths/subprocess output; do not return them.
    return context.json({ error: "Review operation failed." }, 500);
  });

  if (data)
    app.use("*", async (context, next) => {
      if (
        context.req.method === "GET" &&
        !context.req.query("version") &&
        !context.req.query("generation")
      )
        await store.refreshWorktrees();
      await next();
    });

  const catalog = () => {
    void data?.populateCatalogStats();

    return store.list();
  };

  app.get("/", (context) => context.json(catalog()));
  app.get("/authoring", (context) => context.json(authoringTools()));
  app.get("/:id/activity", (context) => {
    const id = context.req.param("id");
    store.assertExists(id);

    return context.json(store.activity.read(id));
  });
  app.post("/:id/activity", async (context) => {
    const input = await readBoundedRequestJson(context.req.raw);
    const id = context.req.param("id");
    store.assertExists(id);

    return context.json(store.activity.update(id, input));
  });
  app.get("/watch", (context) => {
    const query = context.req.query("subscriptions");

    if (query !== undefined) {
      let input: unknown;

      try {
        input = JSON.parse(query);
      } catch {
        throw new ReviewInputError("Invalid subscriptions.");
      }

      const subscriptions = z
        .array(
          z.strictObject({
            reviewId: z.string().min(1).nullable(),
          }),
        )
        .parse(input);

      // Only entries whose review (or the catalog) changed are re-read and re-sent.
      const dirty = new Set(subscriptions.keys());

      const mark = (id: string | null) => {
        let marked = false;

        subscriptions.forEach((item, index) => {
          if (item.reviewId === id) {
            dirty.add(index);
            marked = true;
          }
        });

        return marked;
      };

      return watch(
        () =>
          subscriptions.map(({ reviewId }, index) => {
            if (!dirty.delete(index)) return null;

            try {
              return {
                value:
                  reviewId === null
                    ? catalog()
                    : {
                        ...store.read(reviewId),
                        activity: store.activity.read(reviewId),
                      },
              };
            } catch (error) {
              return {
                error:
                  error instanceof ReviewInputError
                    ? error.message
                    : "Could not read review.",
              };
            }
          }),
        (notify) => {
          const stopRefresh = store.watchWorktrees();

          const stops = [
            stopRefresh,
            store.subscribe((result) => {
              if (mark(result.reviewId)) notify();
            }),
            store.activity.subscribe((id) => {
              if (mark(id)) notify();
            }),
            store.subscribeCatalog(() => {
              if (mark(null)) notify();
            }),
          ];

          return () => stops.forEach((stop) => stop());
        },
        // A missing review is an {error} entry here, never a 404.
        () => {},
      );
    }

    return watch(catalog, (notify) => store.subscribeCatalog(notify));
  });
  app.post("/:id/open", async (context) => {
    const review = store.read(context.req.param("id"));

    if (!open) throw new ReviewInputError("The desktop is not connected.", 409);

    if (review.target.kind !== "worktree")
      void data?.workspaces.open(review.reviewId, review.pins).catch(() => {});

    const settings = await open({
      reviewId: review.reviewId,
      title: review.title,
    });

    return context.json({ ok: true, ...settings });
  });
  app.get("/:id/watch", (context) => {
    const id = context.req.param("id");

    // Activity changes every renewal; reload the document only when it changed.
    let document: Snapshot | undefined;

    return watch(
      () => ({
        ...(document ??= store.read(id)),
        activity: store.activity.read(id),
      }),
      (notify) => {
        const stopRefresh = store.watchWorktrees();

        const stopDocument = store.subscribe((result) => {
          if (result.reviewId === id) {
            document = undefined;
            notify();
          }
        });

        const stopActivity = store.activity.subscribe((changed) => {
          if (changed === id) notify();
        });

        return () => {
          stopRefresh();
          stopDocument();
          stopActivity();
        };
      },
    );
  });

  if (data) {
    const traceQuery = readQuerySchemas.maps.extend({
      storage: z.enum(["s3", "hosted"]).optional(),
      trace: z.string().min(1).optional(),
    });

    app.get("/:id/agent-traces", async (context) => {
      const query = traceQuery.parse(context.req.query());
      const { pins } = store.read(context.req.param("id"), query.version);

      return context.json(
        await listPinnedTraces(
          store.repositoryPath(pins.repositoryId),
          pins,
          query.storage,
        ),
      );
    });
    app.get("/:id/agent-traces/:sessionId", async (context) => {
      const query = traceQuery.parse(context.req.query());
      const { pins } = store.read(context.req.param("id"), query.version);

      const result = await readStoredTrace(
        store.repositoryPath(pins.repositoryId),
        context.req.param("sessionId"),
        query.trace,
        query.storage,
      );

      if (!result.ok)
        return context.json({ ok: false, error: result.error }, result.status);

      return context.json(result);
    });
    app.get("/:id/tree", async (context) => {
      const input = readQuerySchemas.tree.parse(context.req.query());

      const { pins } = await data.resolveSource(context.req.param("id"), input);

      return context.json(await data.tree(pins, input.side, input.path));
    });
    app.get("/:id/maps/:resourceId", async (context) => {
      const query = readQuerySchemas.maps.parse(context.req.query());

      return context.json(
        await data.map(
          (await data.resolveSource(context.req.param("id"), query)).pins,
          context.req.param("resourceId"),
        ),
      );
    });
    app.post("/repositories", async (context) => {
      const input = z
        .strictObject({ path: z.string().min(1) })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(await data.register(input.path));
    });
    app.post("/pins", async (context) => {
      const input = z
        .strictObject({
          repositoryId: z.string(),
          base: z.string(),
          head: z.string(),
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(
        await data.resolvePins(input.repositoryId, input.base, input.head),
      );
    });
    app.post("/resources", async (context) =>
      context.json(
        await data.upload(
          await readBoundedRequestJson(context.req.raw, 8 * 1024 * 1024),
        ),
      ),
    );
    app.get("/resources/:resourceId", (context) => {
      const resource = store.resource(context.req.param("resourceId"));

      return new Response(Buffer.from(resource.data), {
        headers: {
          "content-type": resource.mimeType,
          "x-content-type-options": "nosniff",
        },
      });
    });
    app.post("/:id/source", async (context) => {
      const input = z
        .strictObject({
          version: z.number().int().nonnegative().optional(),
          generation: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          source: sourceSchema,
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(
        await data.quote(
          (await data.resolveSource(context.req.param("id"), input)).pins,
          input.source,
        ),
      );
    });
    app.get("/:id/language-context", async (context) => {
      const input = readQuerySchemas.maps
        .extend({
          side: z.enum(["base", "head"]).default("head"),
          commit: z.string().optional(),
        })
        .parse(context.req.query());

      const snapshot = store.read(context.req.param("id"), input.version);

      return context.json(
        await data.languageEnvironment(snapshot, input.side, input.commit),
      );
    });
    app.get("/workspace-cleanup", (context) =>
      context.json(data.workspaces.failures()),
    );
    app.post("/workspace-cleanup/:workspaceId/retry", (context) => {
      data.workspaces.retryCleanup(context.req.param("workspaceId"));

      return context.json({ ok: true });
    });
    app.get("/:id/workspaces", (context) => {
      store.assertExists(context.req.param("id"));

      return context.json(data.workspaces.list(context.req.param("id")));
    });
    app.post("/:id/workspaces/:workspaceId/retry", async (context) => {
      await data.workspaces.retry(
        context.req.param("id"),
        context.req.param("workspaceId"),
      );

      return context.json({ ok: true });
    });
    app.get("/:id/file", async (context) => {
      const input = readQuerySchemas.file.parse(context.req.query());

      const { snapshot, pins } = await data.resolveSource(
        context.req.param("id"),
        input,
      );

      const file = await data.file(pins, input.side, input.file);

      const local =
        input.live &&
        !input.commit &&
        input.side === "head" &&
        snapshot.target.kind === "worktree"
          ? await data.liveFile(
              snapshot.pins.repositoryId,
              input.file,
              file.text,
            )
          : undefined;

      return context.json({ ...file, ...local });
    });
    app.get("/:id/diff", async (context) => {
      const input = readQuerySchemas.diff.parse(context.req.query());

      return context.json(
        await data.changes(
          (await data.resolveSource(context.req.param("id"), input)).pins,
          input.file,
        ),
      );
    });
    app.get("/:id/commits", async (context) => {
      const input = readQuerySchemas.commits.parse(context.req.query());

      return context.json(
        await data.commits(
          (await data.resolveSource(context.req.param("id"), input)).pins,
        ),
      );
    });
  }

  app.post("/:id/copy-context", async (context) => {
    const query = readQuerySchemas.get
      .pick({ version: true })
      .parse(context.req.query());

    const snapshot = store.read(context.req.param("id"), query.version);

    const selection = AgentSelectionSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    const target = selection.target;
    let excerpt = "";

    if (target.kind === "code" && !selection.selectedDiff) {
      if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

      const source = await data.quote(snapshot.pins, {
        side: target.side,
        file: target.path,
        fromLine: target.startLine,
        toLine: target.endLine,
      });

      excerpt =
        `## ${target.side}: ${target.path}:${target.startLine}-${target.endLine} (${source.commit})\n` +
        source.text
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n");
    }

    const diff = selection.selectedDiff;

    const text = selectionMarkdown(
      selection,
      excerpt,
      diff
        ? { base: `a/${diff.oldPath}`, head: `b/${diff.newPath}` }
        : undefined,
    );

    return context.json({
      text: [
        `Selected ${target.kind === "text" ? "text" : "code"} from Review: ${snapshot.title}`,
        `Review ID: ${snapshot.reviewId}`,
        `Version: ${snapshot.version}`,
        `Repository ID: ${snapshot.pins.repositoryId}`,
        `Review base: ${snapshot.pins.base}`,
        `Review head: ${snapshot.pins.head}`,
        `Read this version with review_get({"reviewId":"${snapshot.reviewId}","version":${snapshot.version},"full":true}).`,
        "",
        text,
        "",
        "",
      ].join("\n"),
    });
  });

  app.get("/:id/stack", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());
    const snapshot = store.read(context.req.param("id"), query.version);

    const repoKey = (review: Pick<Snapshot, "origin" | "pins">) =>
      review.origin?.pullRequestUrl?.replace(/\/pull\/\d+.*$/, "") ??
      review.pins.repositoryId;

    const layers = await resolveReviewStackLayers(
      {
        pullRequestUrl: snapshot.origin?.pullRequestUrl,
      },
      store.list().map((review) => ({
        uuid: review.reviewId,
        title: review.title,
        repoKey: repoKey(review),
        pullRequestNumber: review.origin?.pullRequestNumber,
        presentedDocumentRevision: String(review.version),
      })),
    );

    return context.json({ layers });
  });

  app.get("/:id/history", (context) =>
    context.json(store.history(context.req.param("id"))),
  );
  app.get("/:id/inspect", (context) => {
    const query = inspectQuerySchema.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = store.read(id, query.version);

    return context.json(
      query.format === "text"
        ? documentText(snapshot, query.targetId, Boolean(query.full))
        : query.targetId !== undefined
          ? store.inspect(id, query.targetId, query.version)
          : query.full
            ? snapshot
            : store.inspect(id, undefined, query.version),
    );
  });
  app.get("/:id", (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());

    return context.json(
      query.full
        ? store.read(context.req.param("id"), query.version)
        : store.inspect(context.req.param("id"), query.targetId, query.version),
    );
  });
  app.post("/commands", async (context) =>
    context.json(
      await store.execute(await readBoundedRequestJson(context.req.raw)),
    ),
  );

  return app;
}

/** Send committed state, coalescing updates when the reader falls behind. */
function watch<T>(
  read: () => T,
  subscribe: (notify: () => void) => () => void,
  probe: () => void = read,
) {
  probe(); // Return a normal 404 before opening the response.
  let stop = () => {};

  let dirty = true;
  const encoder = new TextEncoder();

  const send = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (
      !dirty ||
      controller.desiredSize === null ||
      controller.desiredSize <= 0
    )
      return;

    try {
      controller.enqueue(encoder.encode(JSON.stringify(read()) + "\n"));
      dirty = false;
    } catch (error) {
      // A review can be deleted while this stream is open. Do not throw into
      // the already-committed writer; close this reader and unsubscribe it.
      stop();
      controller.error(error);
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = subscribe(() => {
        dirty = true;
        send(controller);
      });
      send(controller);
    },
    pull: send,
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}
