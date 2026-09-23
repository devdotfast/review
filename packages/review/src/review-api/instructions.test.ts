import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runReviewAgentCli } from "./agent-cli.js";
import * as agentClient from "./agent-client.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import {
  INSTRUCTION_TOPICS,
  instructionsQuerySchema,
  renderInstructions,
} from "./instructions.js";
import { serveReviewMcp } from "./mcp.js";
import { ReviewStore } from "./store.js";

const live = {
  authoringMode: "interactive" as const,
  desktopAvailable: true,
  scratchpadEnabled: true,
};

describe("renderInstructions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "review-instructions-"));
    await mkdir(path.join(root, "instructions"));
    await Promise.all(
      Object.entries({
        "authoring-live": "LIVE_WORKFLOW",
        "authoring-batch": "BATCH_WORKFLOW",
        "document-authoring": "DOCUMENT_GUIDANCE",
        headless: "HEADLESS_GUIDANCE",
        "prepared-worktrees": "WORKTREE_GUIDANCE",
        scratchpad: "SCRATCHPAD_GUIDANCE",
        "trace-archaeology": "TRACE_GUIDANCE",
      }).map(([name, content]) =>
        writeFile(path.join(root, "instructions", `${name}.md`), content),
      ),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads every packaged topic as standalone guidance", async () => {
    for (const topic of INSTRUCTION_TOPICS) {
      const guidance = await renderInstructions(topic, live);

      expect(guidance.trim().length).toBeGreaterThan(0);
      expect(guidance.trimStart().startsWith("---")).toBe(false);
      expect(guidance).not.toMatch(
        /\]\((?!https?:\/\/|review-source:|#)[^)]+\.md(?:#[^)]*)?\)/,
      );
    }
  });

  it("selects the server's authoring mode and includes shared guidance", async () => {
    const interactive = await renderInstructions("authoring", live, root);

    const batch = await renderInstructions(
      "authoring",
      { ...live, authoringMode: "batch" },
      root,
    );

    expect(interactive).toContain("LIVE_WORKFLOW\n\nDOCUMENT_GUIDANCE");
    expect(interactive).not.toContain("BATCH_WORKFLOW");
    expect(batch).toContain("BATCH_WORKFLOW");
    expect(batch).toContain("DOCUMENT_GUIDANCE");
    expect(batch).not.toContain("LIVE_WORKFLOW");
  });

  it("advertises the scratchpad only when interactive Desktop access is available", async () => {
    expect(await renderInstructions("authoring", live, root)).toContain(
      'topic:"scratchpad"',
    );

    for (const context of [
      { ...live, scratchpadEnabled: false },
      { ...live, desktopAvailable: false },
      { ...live, authoringMode: "batch" as const },
    ]) {
      expect(
        await renderInstructions("authoring", context, root),
      ).not.toContain('topic:"scratchpad"');
    }

    expect(
      await renderInstructions(
        "scratchpad",
        { ...live, scratchpadEnabled: false },
        root,
      ),
    ).not.toContain("SCRATCHPAD_GUIDANCE");
  });

  it("serves other fixed topics independently of authoring mode and Desktop", async () => {
    const context = {
      ...live,
      authoringMode: "batch" as const,
      desktopAvailable: false,
    };

    for (const [topic, marker] of [
      ["headless", "HEADLESS_GUIDANCE"],
      ["prepared-worktrees", "WORKTREE_GUIDANCE"],
      ["trace-archaeology", "TRACE_GUIDANCE"],
    ] as const) {
      expect(await renderInstructions(topic, context, root)).toBe(marker);
    }
  });

  it("accepts only named topics, defaulting to authoring", () => {
    expect(instructionsQuerySchema.parse({})).toEqual({ topic: "authoring" });

    for (const topic of INSTRUCTION_TOPICS) {
      expect(instructionsQuerySchema.parse({ topic })).toEqual({ topic });
    }

    expect(
      instructionsQuerySchema.safeParse({ topic: "../secrets" }).success,
    ).toBe(false);
    expect(
      instructionsQuerySchema.safeParse({
        topic: "authoring",
        file: "secret.md",
      }).success,
    ).toBe(false);
  });
});

describe("review_get_instructions", () => {
  const stores: ReviewStore[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  const api = (
    mode: "interactive" | "batch",
    desktopAvailable = false,
    scratchpadEnabled = false,
  ) => {
    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    stores.push(store);

    const app = createReviewApi(
      store,
      undefined,
      desktopAvailable
        ? async () => ({ softwareMapEnabled: false })
        : undefined,
      undefined,
      () => ({ desktopAvailable, softwareMapEnabled: false }),
      mode,
      () => scratchpadEnabled,
    );

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => app.request(url.replace("/reviews-api", ""), init),
    );

    return { app, client };
  };

  it("offers the tool in both modes and exposes the scratchpad prompt only for enabled interactive Desktop", async () => {
    for (const mode of ["interactive", "batch"] as const) {
      const tool = authoringTools(mode).find(
        (entry) => entry.name === "review_get_instructions",
      );

      expect(tool).toMatchObject({ method: "GET", path: "/instructions" });
      expect(tool?.description).not.toContain("scratchpad");
    }

    for (const [mode, desktopAvailable, scratchpadEnabled, expected] of [
      ["interactive", true, true, true],
      ["interactive", false, true, false],
      ["interactive", true, false, false],
      ["batch", true, true, false],
    ] as const) {
      const { client } = api(mode, desktopAvailable, scratchpadEnabled);

      const catalog =
        await client.read<ReturnType<typeof authoringTools>>("/authoring");

      const tool = catalog.find(
        (entry) => entry.name === "review_get_instructions",
      );

      expect(tool).toBeDefined();
      expect(tool!.description.includes("scratchpad")).toBe(expected);
    }
  });

  it("serves the server's workflow and rejects invalid or extra query fields with 400", async () => {
    const { app, client } = api("batch");

    const catalog = await client.read<AuthoringTool[]>("/authoring");

    const tool = catalog.find(
      (entry) => entry.name === "review_get_instructions",
    )!;

    const guidance = await callAuthoringTool(client, tool, {});

    expect(guidance).toBe(
      await renderInstructions("authoring", {
        authoringMode: "batch",
        desktopAvailable: false,
        scratchpadEnabled: false,
      }),
    );
    expect(guidance).toBe(await client.read("/instructions"));
    expect(guidance).toBe(await client.read("/instructions?topic=authoring"));
    expect(await callAuthoringTool(client, tool, { topic: "headless" })).toBe(
      await client.read("/instructions?topic=headless"),
    );

    for (const query of [
      "topic=../../etc/passwd",
      "topic=authoring&file=secret.md",
    ]) {
      const response = await app.request(`/instructions?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("prints CLI guidance as raw text and reports offline recovery on stderr", async () => {
    const { client } = api("interactive");
    const connection = vi.spyOn(agentClient, "connectReviewApi");
    let stdout = "";
    let stderr = "";

    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk;
        done();
      },
    });

    const errors = new Writable({
      write(chunk, _encoding, done) {
        stderr += chunk;
        done();
      },
    });

    try {
      connection.mockResolvedValueOnce(client);
      expect(
        await runReviewAgentCli({
          argv: ["api", "review_get_instructions", "{}"],
          stdout: output,
          stderr: errors,
        }),
      ).toBe(0);
      expect(stdout).toContain("## Self-review before completion");
      expect(stdout).not.toMatch(/^"/);

      connection.mockRejectedValueOnce(new Error("Desktop is down"));
      expect(
        await runReviewAgentCli({
          argv: ["api", "review_get_instructions", "{}"],
          stdout: output,
          stderr: errors,
        }),
      ).toBe(1);
      expect(stderr).toMatch(/^Review is not running/);
    } finally {
      connection.mockRestore();
    }
  });

  it("builds the catalog without querying renderer capabilities", async () => {
    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    try {
      const app = createReviewApi(
        store,
        undefined,
        async () => ({ softwareMapEnabled: false }),
        undefined,
        async () => {
          throw new Error("renderer unavailable");
        },
        "interactive",
        () => true,
      );

      const response = await app.request("/authoring");
      expect(response.status).toBe(200);
      expect(
        (await response.json()).find(
          (tool: AuthoringTool) => tool.name === "review_get_instructions",
        ).description,
      ).toContain('topic:"scratchpad"');
    } finally {
      store.close();
    }
  });
});

async function startMcp(connect: () => Promise<ReviewApiClient>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const server = await serveReviewMcp(connect, stdin, stdout, stderr);
  let output = "";

  stdout.on("data", (chunk) => {
    output += chunk;
  });

  const request = async <Params>(
    id: number,
    method: string,
    params: Params,
  ) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect
      .poll(() =>
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((reply) => reply.id === id),
      )
      .toBeTruthy();

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((reply) => reply.id === id);
  };

  return { request, close: () => server.close() };
}

const initialize = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
};

describe("review mcp instructions", () => {
  it("lists and answers while down, then serves guidance through a restart", async () => {
    let up = false;

    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const app = createReviewApi(store);

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => app.request(url.replace("/reviews-api", ""), init),
    );

    const mcp = await startMcp(async () => {
      if (!up) throw new Error("No Review Desktop server is ready.");

      return client;
    });

    try {
      const init = await mcp.request(1, "initialize", initialize);
      expect(init.result.instructions).toContain("review_get_instructions");
      expect(init.result.instructions).toContain("trace-archaeology");
      expect(init.result.instructions).not.toContain('topic:"scratchpad"');
      const list = await mcp.request(2, "tools/list", {});
      expect(
        list.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["review_get_instructions"]);

      const down = await mcp.request(3, "tools/call", {
        name: "review_get_instructions",
        arguments: {},
      });

      expect(down.result.isError).toBeFalsy();
      expect(down.result.content[0].text).toMatch(/^Review is not running/);

      up = true;

      const live = await mcp.request(4, "tools/call", {
        name: "review_get_instructions",
        arguments: {},
      });

      expect(live.result.content[0].text).toContain(
        "## Self-review before completion",
      );
      const liveList = await mcp.request(5, "tools/list", {});
      expect(liveList.result.tools[0].name).toBe("review_get_instructions");
      expect(
        liveList.result.tools.filter(
          (tool: { name: string }) => tool.name === "review_get_instructions",
        ),
      ).toHaveLength(1);

      up = false;

      const restartedDown = await mcp.request(6, "tools/call", {
        name: "review_get_instructions",
        arguments: {},
      });

      expect(restartedDown.result.content[0].text).toMatch(
        /^Review is not running/,
      );
      up = true;

      const restarted = await mcp.request(7, "tools/call", {
        name: "review_get_instructions",
        arguments: { topic: "trace-archaeology" },
      });

      expect(restarted.result.content[0].text).toContain("trace");
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it("uses the live scratchpad prompt and preserves tool errors", async () => {
    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const app = createReviewApi(
      store,
      undefined,
      async () => ({ softwareMapEnabled: false }),
      undefined,
      () => ({ desktopAvailable: true, softwareMapEnabled: false }),
      "interactive",
      () => true,
    );

    let failInstruction = false;

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => {
        if (failInstruction && url.includes("/instructions"))
          return new Response(JSON.stringify({ error: "server failed" }), {
            status: 500,
          });

        return app.request(url.replace("/reviews-api", ""), init);
      },
    );

    const mcp = await startMcp(async () => client);

    try {
      const init = await mcp.request(1, "initialize", initialize);
      expect(init.result.instructions).toContain('topic:"scratchpad"');

      const invalid = await mcp.request(2, "tools/call", {
        name: "review_get_instructions",
        arguments: { topic: "../secrets" },
      });

      expect(invalid.result.isError).toBe(true);
      expect(invalid.result.content[0].text).not.toMatch(
        /^Review is not running/,
      );

      failInstruction = true;

      const failed = await mcp.request(3, "tools/call", {
        name: "review_get_instructions",
        arguments: {},
      });

      expect(failed.result.isError).toBe(true);
      expect(failed.result.content[0].text).toBe("server failed");
    } finally {
      await mcp.close();
      store.close();
    }
  });
});
