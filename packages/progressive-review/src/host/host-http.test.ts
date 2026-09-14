import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  HOST_LIMITS,
  HostBugReportResponseSchema,
  type HostCommandInputs,
  type HostCommandName,
  type HostPrincipal,
  HostQueryBodySchema,
  type JsonValue,
  hostCommandResponseSchema,
  hostQueryResponseSchema,
  isObjectValue,
} from "@dev.fast/review-protocol";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ReviewHonoEnv,
  createNodeRequestListener,
} from "../server/hono-http";
import { HostCredentials } from "./host-credentials";
import { createHostHttp } from "./host-http";
import { ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  bugReportFetch?: typeof fetch,
  authoringActivity = false,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "json-review-http-"));
  const repository = path.join(directory, "source");
  mkdirSync(repository);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Review Test"]);
  git(["config", "user.email", "review@example.test"]);
  writeFileSync(
    path.join(repository, "file.ts"),
    "export const answer = 42;\n",
  );
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const store = new ReviewHostStore(path.join(directory, "review.db"));
  const host = new ReviewHost(store, { authoringActivity });
  const desktopToken = "private-desktop-test-token";
  const credentials = new HostCredentials(store, desktopToken);
  const openReview = vi.fn<(reviewId: string) => Promise<void>>(async () => {});
  let baseUrl = "";
  const router = createHostHttp({
    host,
    credentials,
    baseUrl: () => baseUrl,
    openReview,
    bugReportFetch,
  });
  const app = new Hono<ReviewHonoEnv>();
  app.route("/v1", router.app);
  const server = createServer(createNodeRequestListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!isObjectValue(address)) throw new Error("Expected a TCP listener.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const clientId = randomUUID();
  const envelope = {};
  const commandsUrl = `${baseUrl}/v1/workspaces/${store.workspaceId}/commands`;
  const queriesUrl = `${baseUrl}/v1/workspaces/${store.workspaceId}/queries`;
  const headers = {
    "x-review-token": credentials.agentToken,
    "content-type": "application/json",
    "x-review-client-id": clientId,
  };
  const command = async <K extends HostCommandName>(
    type: K,
    input: HostCommandInputs[K],
    token = credentials.agentToken,
  ) => {
    const request = { ...envelope, type, input, commandId: randomUUID() };
    const response = await fetch(commandsUrl, {
      method: "POST",
      headers: { ...headers, "x-review-token": token },
      body: JSON.stringify(request),
    });
    const parsed = hostCommandResponseSchema(type).parse(await response.json());
    if (!parsed.ok)
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return parsed.data;
  };
  return {
    directory,
    repository,
    store,
    host,
    credentials,
    desktopToken,
    openReview,
    baseUrl,
    envelope,
    headers,
    commandsUrl,
    queriesUrl,
    command,
  };
}

async function createReview(test: Awaited<ReturnType<typeof fixture>>) {
  const registered = await test.command("repository.register", {
    path: test.repository,
  });
  if (!("id" in registered.result))
    throw new Error("Repository result missing.");
  const created = await test.command("review.create", {
    repositoryId: registered.result.id,
    change: { kind: "snapshot", ref: "HEAD" },
    title: "HTTP review",
  });
  if (!("review" in created.result)) throw new Error("Review result missing.");
  return created.result.review;
}

describe("JSON host HTTP boundary", () => {
  it("identifies invalid request fields consistently across native and domain inputs", async () => {
    const test = await fixture();
    const input = { reviewId: randomUUID(), reviewVersion: -1 };
    for (const [url, body] of [
      [`${test.baseUrl}/v1/app/open`, input],
      [test.queriesUrl, { type: "document.get", input }],
    ] as const) {
      const response = await fetch(url, {
        method: "POST",
        headers: test.headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.diagnostics).toContainEqual(
        expect.objectContaining({ path: "/input/reviewVersion" }),
      );
    }
    const unauthenticated = await fetch(`${test.baseUrl}/v1/connection`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
    expect(test.openReview).not.toHaveBeenCalled();
  });

  it("keeps authoring activity opt-in and out of persistent review state", async () => {
    const disabled = await fixture();
    const disabledReview = await createReview(disabled);
    const read = async (
      test: Awaited<ReturnType<typeof fixture>>,
      type: string,
      input = {},
    ) => {
      const response = await fetch(test.queriesUrl, {
        method: "POST",
        headers: test.headers,
        body: JSON.stringify({ ...test.envelope, type, input }),
      });
      return { status: response.status, body: await response.json() };
    };
    const capabilities = await read(disabled, "capabilities");
    expect(capabilities.body.data.result.commands).not.toContain(
      "authoring.begin",
    );
    expect(capabilities.body.data.result.queries).not.toContain(
      "authoring.get",
    );
    expect(
      (await read(disabled, "authoring.get", { reviewId: disabledReview.id }))
        .status,
    ).toBe(404);
    await expect(
      disabled.command("authoring.begin", {
        reviewId: disabledReview.id,
        activityId: randomUUID(),
      }),
    ).rejects.toThrow(/not enabled/);

    const test = await fixture(undefined, true);
    const review = await createReview(test);
    const before = {
      cursor: test.store.cursor(),
      review: test.store.review(review.id),
      history: test.store.reviewHistory(review.id),
    };
    const activityId = randomUUID();
    await test.command("authoring.begin", { reviewId: review.id, activityId });
    expect(
      (await read(test, "authoring.get", { reviewId: review.id })).body.data
        .result,
    ).toMatchObject({ workingCount: 1, unknownCount: 0 });
    await test.command("authoring.renew", { reviewId: review.id, activityId });
    await test.command("authoring.end", { reviewId: review.id, activityId });
    expect({
      cursor: test.store.cursor(),
      review: test.store.review(review.id),
      history: test.store.reviewHistory(review.id),
    }).toEqual(before);
  });

  it("streams opt-in activity independently of durable cursors and checks review access", async () => {
    const test = await fixture(undefined, true);
    const review = await createReview(test);
    const other = await createReview(test);
    const cursor = test.store.cursor();
    const base = `${test.baseUrl}/v1/workspaces/${test.store.workspaceId}/events?after=${encodeURIComponent(cursor)}`;
    const controller = new AbortController();
    const response = await fetch(`${base}&reviewId=${review.id}&activity=1`, {
      headers: test.headers,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffered = "";
    async function frameContaining(text: string) {
      while (true) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (frame.includes(text)) return frame;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Stream ended before activity frame");
          buffered += new TextDecoder().decode(chunk.value);
        }
      }
    }
    const initial = await frameContaining("authoring.activity");
    expect(initial).toContain('"workingCount":0');
    expect(initial).not.toMatch(/^id:/m);
    const activityId = randomUUID();
    await test.command("authoring.begin", { reviewId: review.id, activityId });
    expect(await frameContaining("authoring.activity")).toContain(
      '"workingCount":1',
    );
    await test.command("authoring.end", { reviewId: review.id, activityId });
    expect(await frameContaining("authoring.activity")).toContain(
      '"workingCount":0',
    );
    expect(test.store.cursor()).toBe(cursor);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(
      (await fetch(`${base}&activity=1`, { headers: test.headers })).status,
    ).toBe(400);
    const access = test.credentials.authenticate(test.credentials.agentToken)!;
    test.credentials.add("scoped-activity", {
      ...access,
      permissions: new Set(["read"]),
      reviewIds: new Set([review.id]),
    });
    expect(
      (
        await fetch(`${base}&reviewId=${other.id}&activity=1`, {
          headers: { ...test.headers, "x-review-token": "scoped-activity" },
        })
      ).status,
    ).toBe(404);
  });

  it("reports only the human-selected JSON version and consented attachments", async () => {
    let uploaded: unknown;
    const upload = vi.fn<typeof fetch>(async (_url, init) => {
      if (!(init?.body instanceof FormData))
        throw new Error("Expected compressed multipart report");
      const payload = init.body.get("payload");
      if (!(payload instanceof Blob)) throw new Error("Expected payload blob");
      uploaded = JSON.parse(
        gunzipSync(Buffer.from(await payload.arrayBuffer())).toString("utf8"),
      );
      return Response.json({
        ok: true,
        report_id: "00000000-0000-4000-8000-000000000000",
        short_id: "123456789012",
      });
    });
    const test = await fixture(upload);
    const review = await createReview(test);
    await test.command("document.mutate", {
      reviewId: review.id,
      expectedReviewVersion: review.latestReviewVersion,
      operations: [
        {
          op: "node.insert",
          node: {
            id: "new",
            type: "markdown",
            markdown: "A later edit must not enter the earlier report",
          },
          placement: { parentId: null, position: { kind: "end" } },
        },
      ],
    });
    const url = `${test.baseUrl}/v1/workspaces/${test.store.workspaceId}/reviews/${review.id}/bug-report`;
    const report = {
      description: "The selected review has a layout bug",
      include_review: true,
      include_map: false,
      include_diff: false,
      app_session_id: "desktop-bug-report-test",
      app_version: "development",
    };
    const submit = (token: string, body: JsonValue = report) =>
      fetch(url, {
        method: "POST",
        headers: {
          "x-review-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reviewVersion: review.latestReviewVersion,
          report: body,
        }),
      });
    const denied = await submit(test.credentials.agentToken);
    expect(denied.status).toBe(403);
    expect(
      HostBugReportResponseSchema.parse(await denied.json()),
    ).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", retryable: false },
    });
    expect(uploaded).toBeUndefined();
    const response = await submit(test.desktopToken);
    expect(response.status).toBe(200);
    expect(
      HostBugReportResponseSchema.parse(await response.json()),
    ).toMatchObject({
      ok: true,
      data: { shortId: "123456789012", warnings: [] },
    });
    expect(uploaded).toMatchObject({
      review: { "document.json": expect.any(String) },
      description: report.description,
    });
    expect(JSON.stringify(uploaded)).not.toContain("A later edit");
    expect(uploaded).not.toHaveProperty("map");
    expect(uploaded).not.toHaveProperty("diff");
    expect(uploaded).not.toHaveProperty("trace");
    uploaded = undefined;
    expect(
      (await submit(test.desktopToken, { ...report, include_review: false }))
        .status,
    ).toBe(200);
    expect(uploaded).not.toHaveProperty("review");
    uploaded = undefined;
    expect(
      (await submit(test.desktopToken, { ...report, include_trace: true }))
        .status,
    ).toBe(400);
    expect(uploaded).toBeUndefined();
  });

  it("counts actual bytes and reserves the larger request bound for image uploads", async () => {
    const test = await fixture();
    const review = await createReview(test);
    const padding = " ".repeat(HOST_LIMITS.commandBytes);
    const post = <K extends HostCommandName>(
      type: K,
      input: HostCommandInputs[K],
    ) =>
      fetch(test.commandsUrl, {
        method: "POST",
        headers: test.headers,
        body:
          padding +
          JSON.stringify({
            ...test.envelope,
            commandId: randomUUID(),
            type,
            input,
          }),
      });
    const rejected = await post("review.update", {
      reviewId: review.id,
      expectedReviewVersion: 0,
      title: "Padded request",
      description: "",
      labels: [],
    });
    expect(rejected.status).toBe(413);
    expect(test.store.reviewSnapshot(review.id).title).toBe("HTTP review");
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "#aabbcc" },
    })
      .png()
      .toBuffer();
    const accepted = await post("asset.upload", {
      reviewId: review.id,
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    expect(accepted.status).toBe(200);
    const parsed = hostCommandResponseSchema("asset.upload").parse(
      await accepted.json(),
    );
    expect(parsed).toMatchObject({ ok: true, data: { result: { width: 1 } } });
  });

  it("creates and mutates through the authenticated command contract and retains a retry receipt", async () => {
    const test = await fixture();
    const review = await createReview(test);
    const request = {
      ...test.envelope,
      type: "document.mutate",
      commandId: randomUUID(),
      input: {
        reviewId: review.id,
        expectedReviewVersion: 0,
        operations: [
          {
            op: "node.insert",
            node: { id: "intro", type: "markdown", markdown: "Live content" },
            placement: { parentId: null, position: { kind: "start" } },
          },
        ],
      },
    };
    const post = () =>
      fetch(test.commandsUrl, {
        method: "POST",
        headers: test.headers,
        body: JSON.stringify(request),
      });
    const accepted = hostCommandResponseSchema("document.mutate").parse(
      await (await post()).json(),
    );
    const duplicate = hostCommandResponseSchema("document.mutate").parse(
      await (await post()).json(),
    );
    expect(accepted.ok).toBe(true);
    expect(duplicate).toEqual(accepted);
    expect(test.store.document(review.id).reviewVersion).toBe(1);
    expect(test.store.reviewHistory(review.id)).toHaveLength(2);
  });

  it("rejects missing credentials, query-string tokens, hostile Host and Origin", async () => {
    const test = await fixture();
    const url = `${test.baseUrl}/v1/connection`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(`${url}?token=${test.credentials.agentToken}`)).status,
    ).toBe(401);
    // fetch owns the Host header; raw HTTP is needed to exercise rebinding.
    const hostileHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          url,
          { headers: { ...test.headers, host: "attacker.example" } },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    expect(hostileHostStatus).toBe(403);
    expect(
      (
        await fetch(url, {
          headers: { ...test.headers, origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          headers: { ...test.headers, origin: "vscode-file://vscode-app" },
        })
      ).status,
    ).toBe(200);
  });

  it("derives human authority from the credential and rejects payload impersonation", async () => {
    const test = await fixture();
    const review = await createReview(test);
    expect(test.store.review(review.id).createdBy).not.toBe(
      test.credentials.authenticate(test.desktopToken)!.principal.id,
    );
    await expect(
      test.command("review.close", {
        reviewId: review.id,
        expectedStateVersion: 0,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await test.command(
      "review.close",
      { reviewId: review.id, expectedStateVersion: 0 },
      test.desktopToken,
    );
    expect(test.store.review(review.id).state).toBe("closed");
    const response = await fetch(test.commandsUrl, {
      method: "POST",
      headers: test.headers,
      body: JSON.stringify({
        ...test.envelope,
        commandId: randomUUID(),
        type: "review.create",
        input: {
          repositoryId: review.repositoryId,
          change: { kind: "snapshot", ref: "HEAD" },
          title: "Spoof",
          createdBy: randomUUID(),
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(test.store.reviews()).toHaveLength(1);
  });

  it("rejects cross-workspace requests before touching state and does not report validation rejection as HTTP success", async () => {
    const test = await fixture();
    const review = await createReview(test);
    const query = HostQueryBodySchema.parse({
      ...test.envelope,
      type: "document.get",
      input: { reviewId: review.id },
    });
    const wrongWorkspace = await fetch(
      `${test.baseUrl}/v1/workspaces/${randomUUID()}/queries`,
      {
        method: "POST",
        headers: test.headers,
        body: JSON.stringify(query),
      },
    );
    expect(wrongWorkspace.status).toBe(404);
    const response = await fetch(test.commandsUrl, {
      method: "POST",
      headers: test.headers,
      body: JSON.stringify({
        ...test.envelope,
        commandId: randomUUID(),
        type: "document.mutate",
        input: {
          reviewId: review.id,
          expectedReviewVersion: 0,
          operations: [
            {
              op: "node.insert",
              node: {
                id: "bad",
                type: "markdown",
                markdown: "<script>unsafe</script>",
              },
              placement: { parentId: null, position: { kind: "start" } },
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(422);
    expect(test.store.document(review.id).reviewVersion).toBe(0);
  });

  it("replays events between snapshot and subscription, filters reviews, and rejects stale cursors before streaming", async () => {
    const test = await fixture();
    const review = await createReview(test);
    const snapshotResponse = await fetch(test.queriesUrl, {
      method: "POST",
      headers: test.headers,
      body: JSON.stringify({
        ...test.envelope,
        type: "document.get",
        input: { reviewId: review.id },
      }),
    });
    const snapshot = hostQueryResponseSchema("document.get").parse(
      await snapshotResponse.json(),
    );
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    await test.command("document.mutate", {
      reviewId: review.id,
      expectedReviewVersion: 0,
      operations: [
        {
          op: "node.insert",
          node: { id: "between", type: "divider" },
          placement: { parentId: null, position: { kind: "start" } },
        },
      ],
    });
    const other = await createReview(test);
    await test.command("document.mutate", {
      reviewId: other.id,
      expectedReviewVersion: 0,
      operations: [
        {
          op: "node.insert",
          node: { id: "unrelated", type: "divider" },
          placement: { parentId: null, position: { kind: "start" } },
        },
      ],
    });
    const controller = new AbortController();
    const response = await fetch(
      `${test.baseUrl}/v1/workspaces/${test.store.workspaceId}/events?after=${encodeURIComponent(snapshot.data.eventCursor)}&reviewId=${review.id}`,
      { headers: test.headers, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"review.committed"');
    expect(first).toContain('"between"');
    expect(first).not.toContain('"unrelated"');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const invalid = await fetch(
      `${test.baseUrl}/v1/workspaces/${test.store.workspaceId}/events?after=invalid&reviewId=${review.id}`,
      { headers: test.headers },
    );
    expect(invalid.status).toBe(409);
    expect(invalid.headers.get("content-type")).toContain("application/json");
  });

  it("limits an Ask credential to its review and keeps native window control separate", async () => {
    const test = await fixture();
    const review = await createReview(test);
    const other = await createReview(test);
    const principal: HostPrincipal = {
      id: randomUUID(),
      kind: "agent",
      displayName: "Question assistant",
    };
    test.credentials.add("ask-test-token", {
      principal,
      permissions: new Set(["read"]),
      reviewIds: new Set([review.id]),
    });
    const headers = { ...test.headers, "x-review-token": "ask-test-token" };
    const get = (reviewId: string) =>
      fetch(test.queriesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...test.envelope,
          type: "document.get",
          input: { reviewId },
        }),
      });
    expect((await get(review.id)).status).toBe(200);
    expect((await get(other.id)).status).toBe(404);
    const native = `${test.baseUrl}/v1/app/open`;
    expect(
      (
        await fetch(native, {
          method: "POST",
          headers,
          body: JSON.stringify({ reviewId: review.id }),
        })
      ).status,
    ).toBe(403);
    expect(test.openReview).not.toHaveBeenCalled();
    expect(
      (
        await fetch(native, {
          method: "POST",
          headers: test.headers,
          body: JSON.stringify({ reviewId: review.id }),
        })
      ).status,
    ).toBe(200);
    expect(test.openReview).toHaveBeenCalledWith(review.id, undefined);
  });
});
