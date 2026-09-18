import { type Context, Hono } from "hono";
import { z } from "zod";

import { AgentSelectionSchema, selectionMarkdown } from "../agent-selection.js";
import { resolveReviewStackLayers } from "../review-stack.js";
import { readBoundedRequestJson } from "../server/hono-http.js";
import { HttpJsonError } from "../server/http-json.js";
import { authoringTools } from "./authoring-tools.js";
import { documentText } from "./document-text.js";
import { ReviewInputError, sourceSchema } from "./document.js";
import type { AuthoringMode } from "./drafts.js";
import type { LocalReviewData } from "./local-data.js";
import { inspectQuerySchema, readQuerySchemas } from "./read-schemas.js";
import { type ReviewStore, type Snapshot, commandSchema } from "./store.js";
import { listPinnedTraces, readStoredTrace } from "./traces.js";

export interface AuthoringCapabilities {
  authoringMode: AuthoringMode;
  desktopAvailable: boolean;
  softwareMapEnabled: boolean;
}

/** Both hosts mount this behind their token authentication. */
export function createReviewApi(
  store: ReviewStore,
  data?: LocalReviewData,
  open?: (review: {
    reviewId: string;
    title: string;
  }) => Promise<{ softwareMapEnabled: boolean }>,
  capabilities: () =>
    | Omit<AuthoringCapabilities, "authoringMode">
    | Promise<Omit<AuthoringCapabilities, "authoringMode">> = () => ({
    desktopAvailable: Boolean(open),
    softwareMapEnabled: false,
  }),
  authoringMode: AuthoringMode = "interactive",
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

  const catalog = () => {
    void data?.populateCatalogStats();

    return store.list();
  };

  app.get("/", (context) => context.json(catalog()));
  app.get("/authoring", (context) =>
    context.json(authoringTools(authoringMode)),
  );
  app.get("/capabilities", async (context) =>
    context.json({ ...(await capabilities()), authoringMode }),
  );

  if (authoringMode === "batch") {
    app.post("/draft-commands/:operation", async (context) => {
      const input = z
        .record(z.string(), z.unknown())
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(
        await store.executeDraft({
          ...input,
          type: context.req.param("operation"),
        }),
      );
    });
    app.get("/drafts/:draftId", (context) =>
      context.json(store.drafts.read(context.req.param("draftId"))),
    );
  }

  const sourcePaths = (suffix: string) =>
    authoringMode === "batch"
      ? [`/:id/${suffix}`, `/drafts/:draftId/${suffix}`]
      : [`/:id/${suffix}`];

  const sourceSnapshot = (context: Context, version?: number) => {
    const draftId = context.req.param("draftId");

    if (draftId) {
      if (version !== undefined)
        throw new ReviewInputError(
          "Draft source reads do not take a committed version.",
        );

      return store.drafts.read(draftId);
    }

    return store.read(z.string().parse(context.req.param("id")), version);
  };

  app.get("/:id/activity", (context) => {
    const id = context.req.param("id");
    store.assertExists(id);

    return context.json(store.activity.read(id));
  });
  app.post("/:id/activity", async (context) => {
    if (authoringMode === "batch")
      throw new ReviewInputError(
        "Batch authoring uses server-owned drafts, not activity leases.",
        409,
      );
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
          const stops = [
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
    app.on("GET", sourcePaths("tree"), async (context) => {
      const input = readQuerySchemas.tree.parse(context.req.query());

      const pins = await data.comparison(
        sourceSnapshot(context, input.version).pins,
        input.commit,
      );

      return context.json(await data.tree(pins, input.side, input.path));
    });
    app.on("GET", sourcePaths("maps/:resourceId"), async (context) => {
      const query = readQuerySchemas.maps.parse(context.req.query());

      return context.json(
        await data.map(
          sourceSnapshot(context, query.version).pins,
          z.string().parse(context.req.param("resourceId")),
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
    app.on("POST", sourcePaths("source"), async (context) => {
      const input = z
        .strictObject({
          version: z.number().int().nonnegative().optional(),
          source: sourceSchema,
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(
        await data.quote(
          sourceSnapshot(context, input.version).pins,
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
      const pins = await data.comparison(snapshot.pins, input.commit);

      return context.json(
        await data.workspaces.source(snapshot.reviewId, pins, input.side),
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
    app.on("GET", sourcePaths("file"), async (context) => {
      const input = readQuerySchemas.file.parse(context.req.query());

      return context.json(
        await data.file(
          await data.comparison(
            sourceSnapshot(context, input.version).pins,
            input.commit,
          ),
          input.side,
          input.file,
        ),
      );
    });
    app.on("GET", sourcePaths("diff"), async (context) => {
      const input = readQuerySchemas.diff.parse(context.req.query());

      return context.json(
        await data.changes(
          await data.comparison(
            sourceSnapshot(context, input.version).pins,
            input.commit,
          ),
          input.file,
        ),
      );
    });
    app.on("GET", sourcePaths("commits"), async (context) => {
      const input = readQuerySchemas.commits.parse(context.req.query());

      return context.json(
        await data.commits(sourceSnapshot(context, input.version).pins),
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
  app.post("/commands", async (context) => {
    const input = commandSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (authoringMode === "batch" && input.operation.type !== "attention")
      throw new ReviewInputError(
        "Use batch draft tools to author content, then commit the draft once.",
        409,
      );

    return context.json(await store.execute(input));
  });

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
