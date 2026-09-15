import { Hono } from "hono";
import { z } from "zod";

import { readBoundedRequestJson } from "../server/hono-http.js";
import { HttpJsonError } from "../server/http-json.js";
import { authoringTools } from "./authoring-tools.js";
import { documentText } from "./document-text.js";
import { ReviewInputError, sourceSchema } from "./document.js";
import type { LocalReviewData } from "./local-data.js";
import { inspectQuerySchema, readQuerySchemas } from "./read-schemas.js";
import type { ReviewStore, Snapshot } from "./store.js";

/** Mounted behind the desktop server's existing token authentication. */
export function createReviewApi(
  store: ReviewStore,
  data?: LocalReviewData,
  open?: (review: { reviewId: string; title: string }) => Promise<void>,
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
  app.get("/", (context) => context.json(store.list()));
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

      return watch(
        () =>
          subscriptions.map(({ reviewId }) => {
            try {
              return {
                value:
                  reviewId === null
                    ? store.list()
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
          const interested = (id: string) =>
            subscriptions.some((item) => item.reviewId === id);

          const stops = [
            store.subscribe((result) => {
              if (interested(result.reviewId)) notify();
            }),
            store.activity.subscribe((id) => {
              if (interested(id)) notify();
            }),
            store.subscribeCatalog(() => {
              if (subscriptions.some((item) => item.reviewId === null))
                notify();
            }),
          ];

          return () => stops.forEach((stop) => stop());
        },
      );
    }

    return watch(
      () => store.list(),
      (notify) => store.subscribeCatalog(notify),
    );
  });
  app.post("/:id/open", async (context) => {
    const review = store.read(context.req.param("id"));

    if (!open) throw new ReviewInputError("The desktop is not connected.", 409);
    await open({ reviewId: review.reviewId, title: review.title });

    return context.json({ ok: true });
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
          stopDocument();
          stopActivity();
        };
      },
    );
  });

  if (data) {
    app.get("/:id/tree", async (context) => {
      const input = readQuerySchemas.tree.parse(context.req.query());

      const pins = await data.comparison(
        store.read(context.req.param("id"), input.version).pins,
        input.commit,
      );

      return context.json(await data.tree(pins, input.side, input.path));
    });
    app.get("/:id/maps/:resourceId", async (context) => {
      const query = readQuerySchemas.maps.parse(context.req.query());

      return context.json(
        await data.map(
          store.read(context.req.param("id"), query.version).pins,
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
          source: sourceSchema,
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(
        await data.quote(
          store.read(context.req.param("id"), input.version).pins,
          input.source,
        ),
      );
    });
    app.get("/:id/file", async (context) => {
      const input = readQuerySchemas.file.parse(context.req.query());

      return context.json(
        await data.file(
          await data.comparison(
            store.read(context.req.param("id"), input.version).pins,
            input.commit,
          ),
          input.side,
          input.file,
        ),
      );
    });
    app.get("/:id/diff", async (context) => {
      const input = readQuerySchemas.diff.parse(context.req.query());

      return context.json(
        await data.changes(
          await data.comparison(
            store.read(context.req.param("id"), input.version).pins,
            input.commit,
          ),
          input.file,
        ),
      );
    });
    app.get("/:id/commits", async (context) => {
      const input = readQuerySchemas.commits.parse(context.req.query());

      return context.json(
        await data.commits(
          store.read(context.req.param("id"), input.version).pins,
        ),
      );
    });
  }

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
) {
  read(); // Return a normal 404 before opening the response.
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
