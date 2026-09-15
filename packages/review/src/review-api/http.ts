import { Hono } from "hono";
import { z } from "zod";

import { readBoundedRequestJson } from "../server/hono-http.js";
import { HttpJsonError } from "../server/http-json.js";
import { ReviewInputError, sourceSchema } from "./document.js";
import type { LocalReviewData } from "./local-data.js";
import type { ReviewStore } from "./store.js";

// `?version=` must mean "current", not `Number("") === 0`.
const version = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

/** Mounted behind the desktop server's existing token authentication. */
export function createReviewApi(store: ReviewStore, data?: LocalReviewData) {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HttpJsonError)
      return context.json({ error: error.message }, error.statusCode);

    if (error instanceof ReviewInputError)
      return context.json({ error: error.message }, error.status);

    if (error instanceof z.ZodError)
      return context.json(
        { error: "Invalid request.", issues: error.issues },
        400,
      );

    // Provider failures may contain local paths/subprocess output; do not return them.
    return context.json({ error: "Review operation failed." }, 500);
  });
  app.get("/", (context) => context.json(store.list()));

  if (data) {
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
      const input = z
        .strictObject({
          version,
          side: z.enum(["base", "head"]),
          file: z.string(),
        })
        .parse(context.req.query());

      return context.json(
        await data.file(
          store.read(context.req.param("id"), input.version).pins,
          input.side,
          input.file,
        ),
      );
    });
    app.get("/:id/diff", async (context) => {
      const input = z
        .strictObject({
          version,
          file: z.string().optional(),
        })
        .parse(context.req.query());

      return context.json(
        await data.changes(
          store.read(context.req.param("id"), input.version).pins,
          input.file,
        ),
      );
    });
  }

  app.get("/:id/history", (context) =>
    context.json(store.history(context.req.param("id"))),
  );
  app.get("/:id", (context) => {
    const query = z
      .strictObject({
        version,
        targetId: z.string().optional(),
        full: z.enum(["true"]).optional(),
      })
      .parse(context.req.query());

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
