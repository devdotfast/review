import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_LIMITS,
  HOST_RESOURCE_LIMITS,
  type HostAsset,
  HostAssetSchema,
  HostDocumentStateSchema,
  HostRepositorySchema,
  HostReviewStateSchema,
  isObjectValue,
} from "@dev.fast/review-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type ReviewHonoEnv,
  createNodeRequestListener,
} from "../server/hono-http";
import { HostCredentials } from "./host-credentials";
import {
  type HostDiscovery,
  LocalHostClient,
  hostDiscoveryPath,
  readHostDiscovery,
} from "./host-discovery";
import { createHostHttp } from "./host-http";
import { ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

const cliEntry = fileURLToPath(new URL("../cli.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("thin local host discovery", () => {
  it("uses a private agent discovery record and returns no credential in its connection", async () => {
    const test = await fixture();
    await expect(readHostDiscovery(test.env)).resolves.toEqual(test.discovery);
    const connection = await new LocalHostClient({
      env: test.env,
    }).connection();
    expect(connection).toMatchObject({
      hostId: test.store.hostId,
      workspaceId: test.store.workspaceId,
      principal: { kind: "agent" },
    });
    expect(JSON.stringify(connection)).not.toContain(test.discovery.token);
    expect(JSON.stringify(connection)).not.toContain(test.directory);
  });

  it("rejects a public discovery file and a non-loopback destination before sending a token", async () => {
    const test = await fixture();
    chmodSync(hostDiscoveryPath(test.env), 0o644);
    await expect(readHostDiscovery(test.env)).rejects.toMatchObject({
      detail: { code: "FORBIDDEN" },
    });
    test.writeDiscovery({ url: "https://example.com/" });
    const request = vi.fn<typeof fetch>();
    await expect(
      new LocalHostClient({ env: test.env, fetch: request }).connection(),
    ).rejects.toThrow("JSON host is unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses stale desktop instances and mismatched host connections", async () => {
    const test = await fixture();
    test.writeDiscovery({ instanceId: "stale-instance" });
    await expect(
      new LocalHostClient({ env: test.env }).query("reviews.list", {}),
    ).rejects.toMatchObject({ detail: { code: "DEPENDENCY_UNAVAILABLE" } });
    test.writeDiscovery({ instanceId: test.instanceId });
    const request: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/v1/connection")) {
        const connection = z
          .record(z.string(), z.json())
          .parse(await response.json());
        return Response.json({
          ...connection,
          data: {
            ...z.record(z.string(), z.json()).parse(connection.data),
            hostId: randomUUID(),
          },
        });
      }
      return response;
    };
    await expect(
      new LocalHostClient({ env: test.env, fetch: request }).connection(),
    ).rejects.toMatchObject({ detail: { code: "INTEGRITY_ERROR" } });
  });

  it("rediscovers after a lost response and reuses receipts across client process lifetimes", async () => {
    const test = await fixture();
    const registration = await new LocalHostClient({ env: test.env }).command(
      "repository.register",
      { path: test.repository },
      { commandId: randomUUID() },
    );
    let loseResponse = true;
    const request: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (loseResponse && String(input).endsWith("/commands")) {
        loseResponse = false;
        await response.text();
        const token = "replacement-private-agent-token";
        test.credentials.add(
          token,
          test.credentials.authenticate(test.discovery.token)!,
        );
        test.writeDiscovery({ token });
        throw new TypeError("simulated connection loss");
      }
      return response;
    };
    const commandId = randomUUID();
    const input = {
      repositoryId: registration.result.id,
      title: "A single review",
      change: { kind: "snapshot" as const, ref: "HEAD" },
    };
    const result = await new LocalHostClient({
      env: test.env,
      fetch: request,
    }).command("review.create", input, { commandId });
    const retried = await new LocalHostClient({ env: test.env }).command(
      "review.create",
      input,
      { commandId },
    );
    expect(retried).toEqual(result);
    expect(test.store.reviews()).toHaveLength(1);
  });

  it("does not replay a request into a different host after discovery changes", async () => {
    const test = await fixture();
    const client = new LocalHostClient({ env: test.env });
    await client.connection();
    test.writeDiscovery({ hostId: randomUUID() });
    await expect(
      client.command(
        "repository.register",
        { path: test.repository },
        { commandId: randomUUID() },
      ),
    ).rejects.toMatchObject({ detail: { code: "INTEGRITY_ERROR" } });
    expect(test.store.repositories()).toHaveLength(0);
  });

  it("keeps explicit question credentials scoped and never falls back to author discovery", async () => {
    const test = await fixture();
    const token = "scoped-question-read-only-token";
    test.credentials.add(token, {
      principal: {
        id: randomUUID(),
        kind: "agent",
        displayName: "Question assistant",
      },
      permissions: new Set(["read"]),
    });
    const env = {
      ...test.env,
      DEV_REVIEW_HOST_URL: test.discovery.url,
      DEV_REVIEW_HOST_TOKEN: token,
      DEV_REVIEW_HOST_ID: test.store.hostId,
      DEV_REVIEW_WORKSPACE_ID: test.store.workspaceId,
      DEV_REVIEW_HOST_CLIENT_ID: randomUUID(),
    };
    const client = new LocalHostClient({ env });
    expect((await client.connection()).principal.displayName).toBe(
      "Question assistant",
    );
    await expect(
      client.command(
        "repository.register",
        { path: test.repository },
        { commandId: randomUUID() },
      ),
    ).rejects.toMatchObject({ detail: { code: "FORBIDDEN" } });
    await expect(
      new LocalHostClient({
        env: { ...env, DEV_REVIEW_HOST_TOKEN: "expired-scoped-question-token" },
      }).query("capabilities", {}),
    ).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    await expect(
      new LocalHostClient({
        env: { ...env, DEV_REVIEW_WORKSPACE_ID: undefined },
      }).connection(),
    ).rejects.toMatchObject({ detail: { code: "INVALID_REQUEST" } });
    rmSync(hostDiscoveryPath(test.env));
    expect(
      (await client.query("capabilities", {})).result.commands,
    ).not.toContain("document.mutate");
    const mcp = new Client({ name: "scoped-question", version: "1.0.0" });
    cleanup.push(async () => {
      await mcp.close();
    });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", cliEntry, "mcp"],
        env: processEnv(env),
        stderr: "pipe",
      }),
    );
    const visibleTools = await mcp.listTools();
    expect(visibleTools.tools.some((tool) => tool.name === "review_open")).toBe(
      false,
    );
    expect(
      visibleTools.tools.some((tool) => tool.name === "review_document_get"),
    ).toBe(true);
    const deniedOpen = await mcp.callTool({
      name: "review_open",
      arguments: { reviewId: randomUUID() },
    });
    expect(deniedOpen.isError).toBe(true);
    expect(test.openReview).not.toHaveBeenCalled();
    expect(test.store.repositories()).toHaveLength(0);
  });
});

describe("checkout CLI host entry", () => {
  it("creates and authors through the live HTTP contract with replayable command IDs", async () => {
    const test = await fixture();
    const registerId = randomUUID();
    const registrationArgs = [
      "host",
      "command",
      "repository.register",
      "--command-id",
      registerId,
      "--input",
      JSON.stringify({ path: test.repository }),
    ];
    const registration = await cli(test.env, registrationArgs);
    expect(registration.code).toBe(0);
    const repository = HostRepositorySchema.parse(
      responseData(registration.stdout).result,
    );
    expect(await cli(test.env, registrationArgs)).toEqual(registration);
    const creation = await cli(test.env, [
      "host",
      "command",
      "review.create",
      "--command-id",
      randomUUID(),
      "--input",
      JSON.stringify({
        repositoryId: repository.id,
        change: { kind: "snapshot", ref: "HEAD" },
        title: "CLI authored",
      }),
    ]);
    const created = z
      .object({ review: HostReviewStateSchema })
      .parse(responseData(creation.stdout).result);
    const mutation = await cli(
      test.env,
      [
        "host",
        "command",
        "document.mutate",
        "--command-id",
        randomUUID(),
        "--input",
        "-",
      ],
      JSON.stringify({
        reviewId: created.review.id,
        expectedReviewVersion: 0,
        operations: [
          {
            op: "node.insert",
            node: {
              id: "intro",
              type: "markdown",
              markdown: "Written by the CLI",
            },
            placement: { parentId: null, position: { kind: "start" } },
          },
        ],
      }),
    );
    expect(mutation.code).toBe(0);
    const read = await cli(test.env, [
      "host",
      "query",
      "document.get",
      "--input",
      JSON.stringify({ reviewId: created.review.id }),
    ]);
    const document = HostDocumentStateSchema.parse(
      responseData(read.stdout).result,
    );
    expect(document.nodes.intro).toMatchObject({
      markdown: "Written by the CLI",
    });
    const opened = await cli(test.env, [
      "host",
      "open",
      "--review",
      created.review.id,
    ]);
    expect(opened.code).toBe(0);
    expect(test.openReview).toHaveBeenCalledWith(created.review.id, undefined);
    expect(registration.stdout + creation.stdout + read.stdout).not.toContain(
      test.discovery.token,
    );
  });

  it("requires receipt IDs and reports invalid/oversized input without local fallback", async () => {
    const test = await fixture();
    const noReceipt = await cli(test.env, [
      "host",
      "command",
      "review.create",
      "--input",
      "{}",
    ]);
    expect(noReceipt.code).toBe(1);
    expect(noReceipt.stderr).toContain("--command-id");
    const invalidJson = await cli(test.env, [
      "host",
      "query",
      "reviews.list",
      "--input",
      "{",
    ]);
    expect(invalidJson.code).toBe(1);
    expect(invalidJson.stderr).toContain("valid JSON");
    const invalidVersion = await cli(test.env, [
      "host",
      "query",
      "document.get",
      "--input",
      JSON.stringify({ reviewId: randomUUID(), reviewVersion: -1 }),
    ]);
    expect(invalidVersion.code).toBe(1);
    expect(JSON.parse(invalidVersion.stderr).error.diagnostics).toContainEqual(
      expect.objectContaining({ path: "/input/reviewVersion" }),
    );
    const oversized = await cli(
      test.env,
      ["host", "query", "reviews.list", "--input", "-"],
      " ".repeat(HOST_LIMITS.commandBytes + 1),
    );
    expect(oversized.code).toBe(1);
    expect(oversized.stderr).toContain("byte limit");
    rmSync(hostDiscoveryPath(test.env));
    const unavailable = await cli(test.env, ["host", "capabilities"]);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain("No app was launched");
    expect(unavailable.stderr).not.toContain(test.directory);
    expect(test.store.reviews()).toHaveLength(0);
  });
});

describe("checkout MCP stdio adapter", () => {
  it.each(["CLI", "MCP"] as const)(
    "accepts a valid image upload over 2 MiB through %s while other operations stay bounded",
    async (channel) => {
      const test = await fixture();
      const author = new LocalHostClient({ env: test.env });
      const repository = await author.command(
        "repository.register",
        { path: test.repository },
        { commandId: randomUUID() },
      );
      const review = await author.command(
        "review.create",
        {
          repositoryId: repository.result.id,
          title: "Image review",
          change: { kind: "snapshot", ref: "HEAD" },
        },
        { commandId: randomUUID() },
      );
      const bytes = await sharp({
        create: {
          width: 1100,
          height: 1100,
          channels: 3,
          background: { r: 10, g: 50, b: 90 },
        },
      })
        .png({ compressionLevel: 0 })
        .toBuffer();
      const input = {
        reviewId: review.result.review.id,
        mimeType: "image/png" as const,
        base64: bytes.toString("base64"),
      };
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(
        HOST_LIMITS.commandBytes,
      );
      let asset: HostAsset;
      if (channel === "CLI") {
        const upload = await cli(
          test.env,
          [
            "host",
            "command",
            "asset.upload",
            "--command-id",
            randomUUID(),
            "--input",
            "-",
          ],
          JSON.stringify(input),
        );
        if (upload.code !== 0) throw new Error(upload.stderr);
        asset = HostAssetSchema.parse(responseData(upload.stdout).result);
      } else {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ["--import", "tsx", cliEntry, "mcp"],
          env: processEnv(test.env),
          stderr: "pipe",
        });
        const client = new Client({ name: "image-test", version: "1.0.0" });
        cleanup.push(async () => {
          await client.close();
        });
        await client.connect(transport);
        const upload = await client.callTool({
          name: "review_asset_upload",
          arguments: { ...input, commandId: randomUUID() },
        });
        if (upload.isError) throw new Error(JSON.stringify(upload.content));
        asset = HostAssetSchema.parse(upload.structuredContent);
      }
      expect(asset).toMatchObject({ width: 1100, height: 1100 });
    },
  );

  it("initializes, advertises generated authorized tools and authors through the same host", async () => {
    const test = await fixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cliEntry, "mcp"],
      env: processEnv(test.env),
      stderr: "pipe",
    });
    const client = new Client({
      name: "review-integration-test",
      version: "1.0.0",
    });
    cleanup.push(async () => {
      await client.close();
    });
    await client.connect(transport);
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    const listed = await client.listTools();
    const mutate = listed.tools.find(
      (tool) => tool.name === "review_document_mutate",
    );
    expect(mutate?.inputSchema.required).toContain("commandId");
    expect(listed.tools.some((tool) => tool.name === "review_close")).toBe(
      false,
    );
    const registerId = randomUUID();
    const registration = await client.callTool({
      name: "review_repository_register",
      arguments: { path: test.repository, commandId: registerId },
    });
    const repository = HostRepositorySchema.parse(
      registration.structuredContent,
    );
    const creation = await client.callTool({
      name: "review_create",
      arguments: {
        repositoryId: repository.id,
        change: { kind: "snapshot", ref: "HEAD" },
        title: "MCP authored",
        commandId: randomUUID(),
      },
    });
    const created = z
      .object({ review: HostReviewStateSchema })
      .parse(creation.structuredContent);
    const args = {
      reviewId: created.review.id,
      expectedReviewVersion: 0,
      commandId: randomUUID(),
      operations: [
        {
          op: "node.insert",
          node: { id: "intro", type: "markdown", markdown: "Live MCP content" },
          placement: { parentId: null, position: { kind: "start" } },
        },
      ],
    };
    const mutation = await client.callTool({
      name: "review_document_mutate",
      arguments: args,
    });
    expect(mutation.isError).not.toBe(true);
    expect(
      await client.callTool({
        name: "review_document_mutate",
        arguments: args,
      }),
    ).toEqual(mutation);
    expect(test.store.document(created.review.id).reviewVersion).toBe(1);
    expect(test.store.document(created.review.id).nodes.intro).toMatchObject({
      markdown: "Live MCP content",
    });
    const invalid = await client.callTool({
      name: "review_document_mutate",
      arguments: { ...args, commandId: undefined },
    });
    expect(invalid.isError).toBe(true);
    const opened = await client.callTool({
      name: "review_open",
      arguments: { reviewId: created.review.id },
    });
    expect(opened.structuredContent).toEqual({ opened: true });
    await expect(
      client.callTool({
        name: "review_document_replace",
        arguments: {
          filler: "x".repeat(5 * 1024 * 1024 + 1),
          commandId: randomUUID(),
        },
      }),
    ).rejects.toThrow("byte limit");
    expect(JSON.stringify(listed) + JSON.stringify(mutation)).not.toContain(
      test.discovery.token,
    );
  });

  it("bounds malformed stdio input and exits without echoing private data", async () => {
    const test = await fixture();
    const result = await cli(
      test.env,
      ["mcp"],
      `private-${"x".repeat(HOST_RESOURCE_LIMITS.assetUploadRequestBytes + 128 * 1024)}`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid or oversized protocol message");
    expect(result.stderr).not.toContain("private-");
  });
});

function responseData(text: string) {
  return z
    .object({ ok: z.literal(true), data: z.object({ result: z.json() }) })
    .parse(JSON.parse(text)).data;
}

function processEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function cli(env: NodeJS.ProcessEnv, args: string[], input = "") {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    { env: processEnv(env), stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-host-clients-"));
  const repository = path.join(directory, "source");
  mkdirSync(repository);
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repository, stdio: "ignore" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(path.join(repository, "file.ts"), "export const value = 42;\n");
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const store = new ReviewHostStore(path.join(directory, "review.db"));
  const host = new ReviewHost(store);
  const credentials = new HostCredentials(
    store,
    "private-native-test-credential",
  );
  const instanceId = randomUUID();
  const openReview = vi.fn<(reviewId: string) => Promise<void>>(async () => {});
  let baseUrl = "";
  const router = createHostHttp({
    host,
    credentials,
    baseUrl: () => baseUrl,
    openReview,
  });
  const app = new Hono<ReviewHonoEnv>();
  app.get("/health", (context) =>
    context.json({ ok: true, instanceId, desktopAttached: true }),
  );
  app.route("/v1", router.app);
  const server = createServer(createNodeRequestListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!isObjectValue(address)) throw new Error("Expected a TCP listener.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const env = { DEV_REVIEW_HOME: directory };
  const discovery: HostDiscovery = {
    apiVersion: 1,
    appPid: process.pid,
    instanceId,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    url: baseUrl,
    token: credentials.agentToken,
  };
  mkdirSync(path.dirname(hostDiscoveryPath(env)), { mode: 0o700 });
  const writeDiscovery = (updates: Partial<HostDiscovery> = {}) => {
    Object.assign(discovery, updates);
    writeFileSync(hostDiscoveryPath(env), JSON.stringify(discovery), {
      mode: 0o600,
    });
    chmodSync(hostDiscoveryPath(env), 0o600);
  };
  writeDiscovery();
  cleanup.push(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    repository,
    store,
    credentials,
    env,
    instanceId,
    discovery,
    writeDiscovery,
    openReview,
  };
}
