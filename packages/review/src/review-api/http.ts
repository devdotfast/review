import type { JsonObject } from "@dev.fast/json";
import type { ReviewStructuralDiffEvent } from "@dev.fast/review-protocol";
import { errorMessage } from "@dev.fast/trace-core";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import { AgentSelectionSchema, selectionMarkdown } from "../agent-selection.js";
import { resolveReviewBranchLinks } from "../review-branch-links.js";
import { resolveReviewStackLayers } from "../review-stack.js";
import { readBoundedRequestJson } from "../server/hono-http.js";
import { HttpJsonError } from "../server/http-json.js";
import { mountSharingHost } from "../sharing/host.js";
import type { SharedReviewStore } from "../sharing/import.js";
import { SharedReviewData } from "../sharing/routes.js";
import { scopedCoverage } from "../viewed-coverage.js";
import { authoringTools } from "./authoring-tools.js";
import { documentText } from "./document-text.js";
import { ReviewInputError, fileLineRangeSchema } from "./document.js";
import {
  instructionsQuerySchema,
  renderInstructions,
  scratchpadAvailable,
} from "./instructions.js";
import type { LocalReviewData } from "./local-data.js";
import {
  inspectQuerySchema,
  queryAnchor,
  readQuerySchemas,
} from "./read-schemas.js";
import {
  type UncategorizedReport,
  coverageModeSchema,
  lensReport,
  progressUpdateSchema,
  reviewProgress,
  uncategorizedReport,
} from "./review-progress.js";
import {
  type ReviewStore,
  SCRATCHPAD_ID,
  type Snapshot,
  commandSchema,
  inspectSnapshot,
} from "./store.js";
import { listPinnedTraces, readStoredTrace } from "./traces.js";

export interface AuthoringCapabilities {
  desktopAvailable: boolean;
  softwareMapEnabled: boolean;
  /** Off, the host neither makes nor lists the scratchpad, and refuses its id. */
  scratchpadEnabled: boolean;
}

const SCRATCHPAD_DISABLED =
  "The scratchpad is off. Turn it on in Review Desktop Settings.";

/** Both hosts mount this behind their token authentication. */
export function createReviewApi(
  store: ReviewStore,
  data?: LocalReviewData,
  open?: (review: {
    reviewId: string;
    title: string;
  }) => Promise<{ softwareMapEnabled: boolean }>,
  shared?: SharedReviewStore,
  capabilities: () =>
    | Omit<AuthoringCapabilities, "scratchpadEnabled">
    | Promise<Omit<AuthoringCapabilities, "scratchpadEnabled">> = () => ({
    desktopAvailable: Boolean(open),
    softwareMapEnabled: false,
  }),
  // Synchronous because the catalog is read inside watch callbacks. The host
  // keeps it current from its preferences file.
  scratchpadEnabled: () => boolean = () => false,
  // Read per request: capture can change from outside this server.
  traceEnabled: () => Promise<boolean> = async () => false,
  /** Which server this is, for whiteboard_status. */
  status: () => JsonObject = () => ({}),
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
      if (context.req.method === "GET" && !context.req.query("version"))
        await store.refreshWorktrees();
      await next();
    });

  const sharedData = shared ? new SharedReviewData(shared) : undefined;
  const isShared = (id: string) => id.startsWith("shared-");

  const sharedCommandSchema = z.object({
    operation: z.object({ reviewId: z.string().optional() }),
  });

  // The host that can show the scratchpad keeps it: Desktop, while the
  // preference is on. Headless servers never make one, and a pad made earlier
  // stays in the store while it is off.
  const ensureScratchpad = async (id?: string) => {
    if (open && scratchpadEnabled() && (!id || id === SCRATCHPAD_ID))
      await store.ensureScratchpad();
  };

  const refuseDisabledScratchpad = (id?: string) => {
    if (id === SCRATCHPAD_ID && !scratchpadEnabled())
      throw new ReviewInputError(SCRATCHPAD_DISABLED, 409);
  };

  const sharedGuard: MiddlewareHandler = async (context, next) => {
    refuseDisabledScratchpad(context.req.param("id"));
    await ensureScratchpad(context.req.param("id"));

    const id = context.req.param("id");

    if (!id || !isShared(id)) return next();

    const query = readQuerySchemas.get.parse({
      version: context.req.query("version"),
    });

    readReview(id, query.version);

    if (
      context.req.method !== "GET" &&
      !/\/(open|source|copy-context|environment)$/.test(context.req.path) &&
      !/\/workspaces\/[^/]+\/retry$/.test(context.req.path)
    )
      throw new ReviewInputError("Shared reviews are read-only.", 409);

    return next();
  };

  app.use("/:id", sharedGuard);
  app.use("/:id/*", sharedGuard);

  if (shared && data) {
    shared.connect(store, data);
    mountSharingHost(app, store, data, shared);
  }

  const readReview = (id: string, version?: number): Snapshot => {
    if (!id.startsWith("shared-")) return store.read(id, version);
    const snapshot = shared?.get(id).snapshot;

    if (!snapshot || (version !== undefined && version !== snapshot.version))
      throw new ReviewInputError("Shared review version is unavailable.", 404);

    return snapshot;
  };

  const catalog = (mode: "structural" | "textual" = "structural") => {
    const local = store.list(mode);

    return [
      ...(scratchpadEnabled()
        ? local
        : local.filter((summary) => summary.kind !== "scratchpad")),
      ...(shared?.list(mode) ?? []),
    ];
  };

  app.get("/", async (context) => {
    await ensureScratchpad();

    return context.json(
      catalog(coverageModeSchema.parse(context.req.query("mode"))),
    );
  });

  // Server-owned state only: asking the Desktop canvas would let a stalled
  // renderer block tool listing and the first instructions call.
  const instructionContext = async () => ({
    desktopAvailable: Boolean(open),
    scratchpadEnabled: scratchpadEnabled(),
    traceEnabled: await traceEnabled(),
  });

  app.get("/authoring", async (context) => {
    const instructions = await instructionContext();

    return context.json(
      authoringTools(
        scratchpadAvailable(instructions),
        instructions.traceEnabled,
      ),
    );
  });
  app.get("/instructions", async (context) => {
    const { topic } = instructionsQuerySchema.parse(context.req.query());

    return context.json(
      await renderInstructions(topic, await instructionContext()),
    );
  });
  app.get("/:id/progress", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const query = readQuerySchemas.get
      .pick({ version: true })
      .extend({
        mode: coverageModeSchema,
        wait: z.enum(["false", "true"]).default("true"),
      })
      .parse(context.req.query());

    const snapshot = readReview(context.req.param("id"), query.version);

    const documentPins =
      query.wait === "false" && snapshot.pins
        ? (await data.resolveSource(snapshot)).pins
        : undefined;

    if (documentPins) {
      const state = data.coverageSnapshot(
        snapshot.reviewId,
        documentPins,
        query.mode,
      );

      if (state.pending)
        return context.json(
          await reviewProgress(
            store,
            data,
            snapshot,
            context.req.raw.signal,
            query.mode,
            state.comparison,
          ),
          202,
        );
    }

    return context.json(
      await reviewProgress(
        store,
        data,
        snapshot,
        context.req.raw.signal,
        query.mode,
      ),
    );
  });
  app.post("/:id/progress", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const input = progressUpdateSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    const id = context.req.param("id");

    const snapshot = store.read(id);

    const progress = await reviewProgress(
      store,
      data,
      snapshot,
      context.req.raw.signal,
      input.mode,
    );

    const files = input.files.map((update) => {
      const file = progress.files.find((file) => file.path === update.path);

      if (!file || file.fingerprint !== update.fingerprint)
        throw new ReviewInputError(
          "This file changed. Reload before marking it viewed.",
          409,
        );

      return {
        path: file.path,
        fingerprint: file.fingerprint,
        scope: scopedCoverage(file, update.sources),
      };
    });

    if (store.read(id).version !== snapshot.version)
      throw new ReviewInputError(
        "Review changed during this update. Try again.",
        409,
      );
    store.updateViewedCoverage(id, files, input.viewed);

    return context.json(
      await reviewProgress(
        store,
        data,
        store.read(id, input.version),
        context.req.raw.signal,
        input.mode,
      ),
    );
  });
  // A lens author's cheap read: the lenses as authored, what each resolves
  // to, and the changed lines no lens selects yet.
  app.get("/:id/lenses", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const snapshot = readReview(context.req.param("id"));

    return context.json({
      version: snapshot.version,
      ...lensReport(
        snapshot.lenses ?? [],
        await reviewProgress(store, data, snapshot, context.req.raw.signal),
      ),
    });
  });
  app.get("/status", async (context) =>
    context.json({
      ...status(),
      desktopAvailable: (await capabilities()).desktopAvailable,
    }),
  );

  app.get("/capabilities", async (context) =>
    context.json({
      ...(await capabilities()),
      scratchpadEnabled: scratchpadEnabled(),
    }),
  );

  app.get("/:id/activity", (context) => {
    const id = context.req.param("id");
    readReview(id);

    return context.json(
      isShared(id)
        ? { workingCount: 0, expiresAt: null }
        : store.activity.read(id),
    );
  });
  app.post("/:id/activity", async (context) => {
    const input = await readBoundedRequestJson(context.req.raw);
    const id = context.req.param("id");
    store.assertExists(id);

    return context.json(store.activity.update(id, input));
  });
  app.get("/watch", async (context) => {
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
            mode: coverageModeSchema,
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
          subscriptions.map(({ reviewId, mode }, index) => {
            if (!dirty.delete(index)) return null;

            try {
              return {
                value:
                  reviewId === null
                    ? catalog(mode)
                    : {
                        ...readReview(reviewId),
                        activity: store.activity.read(reviewId),
                        coverageRevision: data?.coverageRevision ?? 0,
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
            data?.subscribeCoverage(() => {
              subscriptions.forEach((item, index) => {
                if (item.reviewId !== null) dirty.add(index);
              });
              notify();
            }) ?? (() => {}),
            store.subscribe((result) => {
              if (mark(result.reviewId)) notify();
            }),
            store.activity.subscribe((id) => {
              if (mark(id)) notify();
            }),
            shared?.subscribe(() => {
              if (mark(null)) notify();
            }) ?? (() => {}),
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

    await ensureScratchpad();

    return watch(
      () => catalog(coverageModeSchema.parse(context.req.query("mode"))),
      (notify) => {
        const local = store.subscribeCatalog(notify);
        const imported = shared?.subscribe(notify);

        return () => {
          local();
          imported?.();
        };
      },
    );
  });

  /** Show a review in Desktop and start preparing its pinned checkouts. */
  const openReview = async (review: Snapshot) => {
    if (!open) throw new ReviewInputError("The desktop is not connected.", 409);

    const settings = await open({
      reviewId: review.reviewId,
      title: review.title,
    });

    let environmentIssues: { side?: string; message: string }[] | undefined;

    try {
      if (review.target?.kind === "commits" && review.pins)
        void data?.workspaces
          .open(review.reviewId, review.pins)
          .catch(() => {});
      environmentIssues = data?.currentEnvironmentIssues(review);
    } catch (error) {
      environmentIssues = [
        {
          message: `Could not check language checkouts: ${errorMessage(error)}. Recheck with review_environment.`,
        },
      ];
    }

    return {
      ...settings,
      environmentIssues: environmentIssues?.length
        ? environmentIssues
        : undefined,
    };
  };

  /**
   * A created or returned review is shown where Desktop can, unless the author asked
   * not to. The review is already saved, so a failed open is reported, not thrown.
   */
  const openCreated = async (reviewId: string) => {
    try {
      if (!open || !(await capabilities()).desktopAvailable)
        return { opened: false };

      return { opened: true, ...(await openReview(store.read(reviewId))) };
    } catch (error) {
      return {
        opened: false,
        openError: `${errorMessage(error)} Retry with review_open.`,
      };
    }
  };

  app.post("/:id/open", async (context) => {
    const id = context.req.param("id");

    if (isShared(id)) await shared?.assertReady(id);

    return context.json({ ok: true, ...(await openReview(readReview(id))) });
  });
  app.get("/:id/watch", (context) => {
    const id = context.req.param("id");

    // Activity changes every renewal; reload the document only when it changed.
    let document: Snapshot | undefined;

    return watch(
      () => ({
        ...(document ??= readReview(id)),
        activity: isShared(id)
          ? { workingCount: 0, expiresAt: null }
          : store.activity.read(id),
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

    // Traces are stored beside the review's own repository.
    const tracePins = (id: string, version?: number) => {
      const { pins } = readReview(id, version);

      if (!pins)
        throw new ReviewInputError(
          "This document has no source pins of its own.",
          409,
        );

      return pins;
    };

    app.get("/:id/agent-traces", async (context) => {
      const query = traceQuery.parse(context.req.query());
      const pins = tracePins(context.req.param("id"), query.version);

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
      const pins = tracePins(context.req.param("id"), query.version);

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
    app.post("/:id/navigator", async (context) => {
      const input = readQuerySchemas.file
        .extend({
          side: z.enum(["base", "head"]).default("head"),
          file: z.string().min(1).optional(),
          empty: z.literal("true").optional(),
        })
        .parse(context.req.query());

      return context.json(
        await data.navigatorWorkspace(
          readReview(context.req.param("id"), input.version),
          {
            ...input,
            empty: input.empty === "true",
            anchor: queryAnchor(input),
          },
        ),
      );
    });
    app.get("/:id/tree", async (context) => {
      const input = readQuerySchemas.tree.parse(context.req.query());

      const { pins } = await data.resolveSource(
        readReview(context.req.param("id"), input.version),
        input.commit,
        queryAnchor(input),
      );

      return context.json(await data!.tree(pins, input.side, input.path));
    });
    app.get("/:id/maps/:resourceId", async (context) => {
      const query = readQuerySchemas.maps.parse(context.req.query());
      const id = context.req.param("id");

      if (id && isShared(id))
        return context.json(
          sharedData!.map(
            id,
            z.string().parse(context.req.param("resourceId")),
          ),
        );

      return context.json(
        await data.map(
          await data.sourcePins(readReview(id, query.version)),
          z.string().parse(context.req.param("resourceId")),
        ),
      );
    });
    app.post("/repositories", async (context) => {
      const input = z
        .strictObject({ path: z.string().min(1) })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json(await data!.register(input.path));
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
        await data!.resolvePins(input.repositoryId, input.base, input.head),
      );
    });
    app.post("/resources", async (context) =>
      context.json(
        await data!.upload(
          await readBoundedRequestJson(context.req.raw, 8 * 1024 * 1024),
        ),
      ),
    );
    app.get("/:id/resources/:resourceId", async (context) => {
      const id = context.req.param("id");
      const snapshot = readReview(id);

      const resource =
        id && isShared(id)
          ? {
              ...(await sharedData!.resource(
                id,
                z.string().parse(context.req.param("resourceId")),
              )),
              repositoryId: snapshot.pins?.repositoryId ?? "",
            }
          : store.resource(z.string().parse(context.req.param("resourceId")));

      // A document with pins serves only its repository's resources.
      if (snapshot.pins && resource.repositoryId !== snapshot.pins.repositoryId)
        throw new ReviewInputError("Resource is outside this repository.", 404);

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
          source: fileLineRangeSchema,
          commit: z.string().min(1).optional(),
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      const { pins } = await data.resolveSource(
        readReview(context.req.param("id"), input.version),
        input.commit,
        input.source.pins,
      );

      return context.json(await data.quote(pins, input.source));
    });
    app.get("/:id/language-context", async (context) => {
      const input = readQuerySchemas.maps
        .extend({
          side: z.enum(["base", "head"]).default("head"),
          commit: z.string().optional(),
          repositoryId: z.string().optional(),
          head: z.string().optional(),
          base: z.string().optional(),
        })
        .parse(context.req.query());

      const snapshot = readReview(context.req.param("id"), input.version);

      return context.json(
        await data.languageEnvironment(
          snapshot,
          input.side,
          input.commit,
          false,
          queryAnchor(input),
        ),
      );
    });
    app.post("/:id/environment", async (context) => {
      const input = z
        .strictObject({ retry: z.boolean().optional() })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json({
        issues: await data.environmentIssues(
          readReview(context.req.param("id")),
          input.retry,
        ),
      });
    });
    app.post("/workspace-cleanup", async (context) => {
      const input = z
        .strictObject({ workspaceId: z.string().min(1).optional() })
        .parse(await readBoundedRequestJson(context.req.raw));

      if (input.workspaceId)
        await data.workspaces.retryCleanup(input.workspaceId);

      return context.json({ failures: data.workspaces.failures() });
    });
    app.get("/:id/workspaces", (context) => {
      readReview(context.req.param("id"));

      return context.json(data.workspaces.list(context.req.param("id")));
    });
    app.post("/:id/workspaces/:workspaceId/retry", async (context) => {
      return context.json(
        await data.workspaces.retry(
          context.req.param("id"),
          context.req.param("workspaceId"),
        ),
      );
    });
    app.get("/:id/file", async (context) => {
      const input = readQuerySchemas.file.parse(context.req.query());
      const id = context.req.param("id");

      const anchor = queryAnchor(input);

      const { snapshot, pins } = await data.resolveSource(
        readReview(id, input.version),
        input.commit,
        anchor,
      );

      const file = await data.file(pins, input.side, input.file);

      const local =
        !input.commit &&
        !anchor &&
        input.side === "head" &&
        snapshot.target?.kind === "worktree"
          ? await data.liveFile(pins.repositoryId, input.file, file.text)
          : undefined;

      return context.json({ ...file, ...local });
    });
    app.get("/:id/structural-diff", async (context) => {
      const input = readQuerySchemas.structuralDiff.parse(context.req.query());
      const id = context.req.param("id");

      const { pins } = await data.resolveSource(
        readReview(id, input.version),
        input.commit,
        queryAnchor(input),
      );

      const abort = new AbortController();
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: ReviewStructuralDiffEvent) => {
            if (!abort.signal.aborted)
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          };

          try {
            for await (const event of data.structuralChanges({
              reviewId: id,
              pins,
              signal: AbortSignal.any([context.req.raw.signal, abort.signal]),
              file: input.file,
            }))
              send(event);
          } catch (error) {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            if (!abort.signal.aborted) controller.close();
          }
        },
        cancel() {
          abort.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        },
      });
    });
    app.get("/:id/diff", async (context) => {
      const query = context.req.query();
      const paths = context.req.queries("paths");
      const input = readQuerySchemas.diff.parse({ ...query, paths });

      if (input.file !== undefined && (paths || "format" in query))
        throw new ReviewInputError(
          'file cannot be combined with paths or format; use paths:["…"], format:"patch".',
        );

      const { pins } = await data.resolveSource(
        readReview(context.req.param("id"), input.version),
        input.commit,
        queryAnchor(input),
      );

      if (input.format === "files" && input.file === undefined)
        return context.json(await data.changedFiles(pins, input.paths));

      return context.text(
        await data.patches(pins, {
          paths: input.file === undefined ? input.paths : [input.file],
          contextLines: input.context,
          maxBytes: input.maxBytes,
        }),
      );
    });
    app.get("/:id/commits", async (context) => {
      const input = readQuerySchemas.commits.parse(context.req.query());

      return context.json(
        await data.commits(
          (
            await data.resolveSource(
              readReview(context.req.param("id"), input.version),
            )
          ).pins,
        ),
      );
    });
  }

  app.post("/:id/copy-context", async (context) => {
    const query = readQuerySchemas.get
      .pick({ version: true })
      .extend({ mode: coverageModeSchema })
      .parse(context.req.query());

    const selection = AgentSelectionSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    const reviewId = context.req.param("id");

    if (selection.apiSource && selection.apiSource.reviewId !== reviewId)
      throw new ReviewInputError("Selection belongs to another review.");

    const snapshot = readReview(
      reviewId,
      selection.apiSource?.version ?? query.version,
    );

    const target = selection.target;
    let excerpt = "";

    if (target.kind === "code" && !selection.selectedDiff) {
      if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

      const source = await data.quote(
        (
          await data.resolveSource(
            snapshot,
            selection.apiSource?.commit,
            selection.apiSource?.pins,
          )
        ).pins,
        {
          side: target.side,
          file: target.path,
          fromLine: target.startLine,
          toLine: target.endLine,
        },
      );

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
        `Selected ${target.kind === "text" ? "text" : "code"} from Whiteboard: ${snapshot.title}`,
        `Session ID: ${snapshot.reviewId}`,
        `Version: ${snapshot.version}`,
        ...(selection.apiSource?.commit
          ? [`Selected commit: ${selection.apiSource.commit}`]
          : []),
        ...(selection.apiSource?.pins
          ? [
              `Selected repository ID: ${selection.apiSource.pins.repositoryId}`,
              ...(selection.apiSource.pins.base
                ? [`Selected base: ${selection.apiSource.pins.base}`]
                : []),
              `Selected head: ${selection.apiSource.pins.head}`,
            ]
          : []),
        ...(snapshot.pins
          ? [
              `Repository ID: ${snapshot.pins.repositoryId}`,
              `Session base: ${snapshot.pins.base}`,
              `Session head: ${snapshot.pins.head}`,
            ]
          : []),
        `Read this version with session_get({"sessionId":"${snapshot.reviewId}","version":${snapshot.version},"full":true}).`,
        "",
        text,
        "",
        "",
      ].join("\n"),
    });
  });

  app.get("/:id/branch-links", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = readReview(id, query.version);

    if (!snapshot.pins)
      throw new ReviewInputError(
        "This document has no source pins of its own.",
        409,
      );

    const baseRef =
      snapshot.origin?.baseRef ?? snapshot.target?.base ?? snapshot.pins.base;

    const headRef =
      snapshot.origin?.branch ??
      (snapshot.target?.kind === "commits" ? snapshot.target.head : "HEAD");

    if (isShared(id))
      return context.json({
        ok: true,
        baseRef,
        headRef,
        baseUrl: null,
        headUrl: null,
      });

    const links = await resolveReviewBranchLinks({
      rootPath: store.repositoryPath(snapshot.pins.repositoryId),
      baseRef,
      headRef,
      pullRequestUrl: snapshot.origin?.pullRequestUrl,
    });

    return context.json({ ok: true, baseRef, headRef, ...links });
  });

  app.get("/:id/stack", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = readReview(id, query.version);

    if (isShared(id) || !snapshot.pins) return context.json({ layers: [] });
    const repositoryId = snapshot.pins.repositoryId;

    const repoKey = (review: Pick<Snapshot, "origin" | "pins">) =>
      review.origin?.pullRequestUrl?.replace(/\/pull\/\d+.*$/, "") ??
      review.pins?.repositoryId ??
      "";

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

  app.get("/:id/history", (context) => {
    const id = context.req.param("id");

    if (!isShared(id)) return context.json(store.history(id));
    const snapshot = readReview(id);

    return context.json([
      {
        version: snapshot.version,
        title: snapshot.title,
        createdAt: snapshot.createdAt,
      },
    ]);
  });
  app.get("/:id/inspect", (context) => {
    const query = inspectQuerySchema.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = readReview(id, query.version);

    return context.json(
      query.format === "text"
        ? documentText(snapshot, query.targetId, Boolean(query.full))
        : query.targetId !== undefined
          ? inspectSnapshot(snapshot, query.targetId)
          : query.full
            ? snapshot
            : inspectSnapshot(snapshot),
    );
  });
  app.get("/:id", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());

    const snapshot = { ...readReview(context.req.param("id"), query.version) };

    if (data && query.full) {
      try {
        const pins = await data.sourcePins(snapshot);

        if (pins) snapshot.pins = pins;
      } catch (error) {
        if (!(error instanceof ReviewInputError) || error.status !== 404)
          throw error;
        snapshot.sourceUnavailable = true;
      }
    }

    return context.json(
      query.full ? snapshot : inspectSnapshot(snapshot, query.targetId),
    );
  });

  /** After a lens write: the changed lines still uncategorized at that
   * version, so the author can fill the gaps. A comparison that cannot be
   * read leaves a warning instead of failing the saved write. */
  const lensGaps = async (
    reviewId: string,
    version: number,
    request: Request,
  ): Promise<{ uncategorized?: UncategorizedReport; warnings?: string[] }> => {
    if (!data) return {};

    try {
      return {
        uncategorized: uncategorizedReport(
          await reviewProgress(
            store,
            data,
            store.read(reviewId, version),
            request.signal,
          ),
        ),
      };
    } catch (error) {
      return {
        warnings: [
          `Uncategorized changes are unavailable: ${errorMessage(error)}`,
        ],
      };
    }
  };

  app.post("/commands", async (context) => {
    const { command: request, open: requestedOpen } = takeCreateOpen(
      await readBoundedRequestJson(context.req.raw),
    );

    const input = commandSchema.parse(request);

    const command = sharedCommandSchema.safeParse(input);

    if (command.success) {
      refuseDisabledScratchpad(command.data.operation.reviewId);
      await ensureScratchpad(command.data.operation.reviewId);
    }

    if (
      input.operation.type === "create" &&
      input.operation.kind === "scratchpad"
    )
      refuseDisabledScratchpad(SCRATCHPAD_ID);

    if (
      command.success &&
      command.data.operation.reviewId?.startsWith("shared-")
    ) {
      const parsed = commandSchema.parse(input);

      if (shared && parsed.operation.type === "delete") {
        await shared.removeLocal(parsed.operation.reviewId);

        return context.json({
          reviewId: parsed.operation.reviewId,
          version: 0,
          deleted: true,
        });
      }

      if (shared && parsed.operation.type === "attention") {
        await shared.setAttention(
          parsed.operation.reviewId,
          parsed.operation.action,
        );

        return context.json({
          reviewId: parsed.operation.reviewId,
          version: shared.get(parsed.operation.reviewId).snapshot.version,
          attention: true,
        });
      }

      throw new ReviewInputError("Shared reviews are read-only.", 409);
    }

    const result = await store.execute(input);

    if (input.operation.type === "lens") {
      const gaps = await lensGaps(
        result.reviewId,
        result.version,
        context.req.raw,
      );

      return context.json({
        ...result,
        ...gaps,
        ...(gaps.warnings && {
          warnings: [...(result.warnings ?? []), ...gaps.warnings],
        }),
      });
    }

    if (input.operation.type !== "create") return context.json(result);

    return context.json({
      ...result,
      review: store.summary(result.reviewId),
      ...(requestedOpen === false
        ? { opened: false }
        : await openCreated(result.reviewId)),
    });
  });

  return app;
}

/**
 * `open` steers presentation, not the saved review, so it stays out of the
 * command and its receipt: a retry may choose differently. Anything else,
 * including `open` off create, is left for commandSchema to reject.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Request body boundary: commandSchema parses the result.
function takeCreateOpen(body: unknown) {
  const create = z
    .looseObject({
      operation: z.looseObject({
        type: z.literal("create"),
        open: z.boolean().optional(),
      }),
    })
    .safeParse(body);

  if (!create.success) return { command: body };
  const { open, ...operation } = create.data.operation;

  return { command: { ...create.data, operation }, open };
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
