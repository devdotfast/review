import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWhiteboardAgentCli } from "./agent-cli.js";
import * as agentClient from "./agent-client.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { authoringTools } from "./authoring-tools.js";
import { SessionApiClient } from "./client.js";
import { createSessionApi } from "./http.js";
import {
  INSTRUCTION_TOPICS,
  instructionsQuerySchema,
  renderInstructions,
} from "./instructions.js";
import { mcpServerInstructions, serveWhiteboardMcp } from "./mcp.js";
import { SessionStore } from "./store.js";

const live = {
  desktopAvailable: true,
  scratchpadEnabled: true,
  traceEnabled: true,
};

describe("renderInstructions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "whiteboard-instructions-"));
    await mkdir(path.join(root, "instructions"));
    await Promise.all(
      Object.entries({
        authoring: "AUTHORING_WORKFLOW",
        "file-lenses": "LENS_GUIDANCE",
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
        /\]\((?!https?:\/\/|whiteboard-source:|#)[^)]+\.md(?:#[^)]*)?\)/,
      );
    }
  });

  it("serves the authoring workflow with the other topics listed", async () => {
    const authoring = await renderInstructions("authoring", live, root);

    expect(authoring.startsWith("AUTHORING_WORKFLOW")).toBe(true);
    expect(authoring).toContain('topic:"trace-archaeology"');
  });

  it("advertises the scratchpad only when Desktop has it enabled", async () => {
    expect(await renderInstructions("authoring", live, root)).toContain(
      'topic:"scratchpad"',
    );

    for (const context of [
      { ...live, scratchpadEnabled: false },
      { ...live, desktopAvailable: false },
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

  it("serves other fixed topics without Desktop", async () => {
    const context = { ...live, desktopAvailable: false };

    for (const [topic, marker] of [
      ["file-lenses", "LENS_GUIDANCE"],
      ["trace-archaeology", "TRACE_GUIDANCE"],
    ] as const) {
      expect(await renderInstructions(topic, context, root)).toBe(marker);
    }
  });

  describe("trace-archaeology gating", () => {
    const off = {
      desktopAvailable: true,
      scratchpadEnabled: false,
      traceEnabled: false,
    };

    const on = { ...off, traceEnabled: true };

    it("omits trace guidance from authoring when capture is off", async () => {
      const text = await renderInstructions("authoring", off, root);
      expect(text).not.toContain("trace-archaeology");
      expect(text).not.toContain("check if traces are available");
    });

    it("includes trace guidance when capture is on", async () => {
      const text = await renderInstructions("authoring", on, root);
      expect(text).toContain(
        'session_get_instructions({topic:"trace-archaeology"})',
      );
      expect(text).toContain("check if traces are available");
    });

    it("answers the trace-archaeology topic with an off message when capture is off", async () => {
      expect(await renderInstructions("trace-archaeology", off, root)).toBe(
        "Trace capture is off on this machine, so no agent traces are available. It can be turned on in Whiteboard Desktop Settings under Experimental Features.",
      );
    });
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

describe("tool and server descriptions", () => {
  it("mention trace-archaeology only when capture is on", () => {
    const off = authoringTools(false, false).find(
      (tool) => tool.name === "session_get_instructions",
    );

    const on = authoringTools(false, true).find(
      (tool) => tool.name === "session_get_instructions",
    );

    expect(off?.description).not.toContain("trace-archaeology");
    expect(on?.description).toContain("trace-archaeology");
    expect(
      mcpServerInstructions({
        scratchpadAvailable: false,
        traceEnabled: false,
      }),
    ).not.toContain("trace-archaeology");
    expect(
      mcpServerInstructions({ scratchpadAvailable: false, traceEnabled: true }),
    ).toContain("trace-archaeology");
  });
});

describe("session_get_instructions", () => {
  const stores: SessionStore[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores.length = 0;
  });

  const api = (desktopAvailable = false, scratchpadEnabled = false) => {
    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    stores.push(store);

    const app = createSessionApi(
      store,
      undefined,
      desktopAvailable
        ? async () => ({ softwareMapEnabled: false })
        : undefined,
      undefined,
      () => ({ desktopAvailable, softwareMapEnabled: false }),
      () => scratchpadEnabled,
    );

    const client = new SessionApiClient(
      {
        serverUrl: "http://whiteboard.test",
        token: "test",
        apiPath: "/sessions-api",
      },
      async (url, init) => app.request(url.replace("/sessions-api", ""), init),
    );

    return { app, client };
  };

  it("offers the tool and exposes the scratchpad prompt only when Desktop has it enabled", async () => {
    const tool = authoringTools().find(
      (entry) => entry.name === "session_get_instructions",
    );

    expect(tool).toMatchObject({ method: "GET", path: "/instructions" });
    expect(tool?.description).not.toContain('topic:"scratchpad"');

    for (const [desktopAvailable, scratchpadEnabled, expected] of [
      [true, true, true],
      [false, true, false],
      [true, false, false],
    ] as const) {
      const { client } = api(desktopAvailable, scratchpadEnabled);

      const catalog =
        await client.read<ReturnType<typeof authoringTools>>("/authoring");

      const tool = catalog.find(
        (entry) => entry.name === "session_get_instructions",
      );

      expect(tool).toBeDefined();
      expect(tool!.description.includes('topic:"scratchpad"')).toBe(expected);
    }
  });

  it("serves the workflow and rejects invalid or extra query fields with 400", async () => {
    const { app, client } = api();

    const catalog = await client.read<AuthoringTool[]>("/authoring");

    const tool = catalog.find(
      (entry) => entry.name === "session_get_instructions",
    )!;

    const guidance = await callAuthoringTool(client, tool, {});

    expect(guidance).toBe(
      await renderInstructions("authoring", {
        desktopAvailable: false,
        scratchpadEnabled: false,
        traceEnabled: false,
      }),
    );
    expect(guidance).toBe(await client.read("/instructions"));
    expect(guidance).toBe(await client.read("/instructions?topic=authoring"));
    expect(
      await callAuthoringTool(client, tool, { topic: "file-lenses" }),
    ).toBe(await client.read("/instructions?topic=file-lenses"));

    for (const query of [
      "topic=../../etc/passwd",
      "topic=authoring&file=secret.md",
    ]) {
      const response = await app.request(`/instructions?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("prints CLI guidance as raw text and reports offline recovery on stderr", async () => {
    const { client } = api();
    const connection = vi.spyOn(agentClient, "connectSessionApi");
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
        await runWhiteboardAgentCli({
          argv: ["api", "session_get_instructions", "{}"],
          stdout: output,
          stderr: errors,
        }),
      ).toBe(0);
      expect(stdout).toContain("rfc-style whiteboard");
      expect(stdout).not.toMatch(/^"/);

      connection.mockRejectedValueOnce(new Error("Desktop is down"));
      expect(
        await runWhiteboardAgentCli({
          argv: ["api", "session_get_instructions", "{}"],
          stdout: output,
          stderr: errors,
        }),
      ).toBe(1);
      expect(stderr).toMatch(/^Whiteboard is not running/);
    } finally {
      connection.mockRestore();
    }
  });

  it("lists tools and serves instructions without querying renderer capabilities", async () => {
    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    try {
      const app = createSessionApi(
        store,
        undefined,
        async () => ({ softwareMapEnabled: false }),
        undefined,
        async () => {
          throw new Error("renderer unavailable");
        },
        () => true,
      );

      const response = await app.request("/authoring");
      expect(response.status).toBe(200);
      expect(
        (await response.json()).find(
          (tool: AuthoringTool) => tool.name === "session_get_instructions",
        ).description,
      ).toContain('topic:"scratchpad"');

      for (const topic of ["authoring", "scratchpad", "trace-archaeology"]) {
        const instructions = await app.request(`/instructions?topic=${topic}`);
        expect(instructions.status).toBe(200);
      }

      expect(
        await (await app.request("/instructions?topic=scratchpad")).json(),
      ).toContain("# Scratchpad");
    } finally {
      store.close();
    }
  });

  it("reads the trace gate on every request", async () => {
    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    let capture = false;

    try {
      const app = createSessionApi(
        store,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
        async () => capture,
      );

      const traces = async () =>
        (await app.request("/instructions?topic=trace-archaeology")).json();

      expect(await traces()).toMatch(/^Trace capture is off/);

      capture = true;

      expect(await traces()).not.toMatch(/^Trace capture is off/);
      expect(
        (await (await app.request("/authoring")).json()).find(
          (tool: AuthoringTool) => tool.name === "session_get_instructions",
        ).description,
      ).toContain('topic:"trace-archaeology"');
    } finally {
      store.close();
    }
  });
});

async function startMcp(connect: () => Promise<SessionApiClient>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const server = await serveWhiteboardMcp(connect, stdin, stdout, stderr, true);
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

describe("whiteboard mcp instructions", () => {
  it("lists and answers while down, then serves guidance through a restart", async () => {
    let up = false;
    let connections = 0;

    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const app = createSessionApi(store);

    const client = new SessionApiClient(
      {
        serverUrl: "http://whiteboard.test",
        token: "test",
        apiPath: "/sessions-api",
      },
      async (url, init) => app.request(url.replace("/sessions-api", ""), init),
    );

    const mcp = await startMcp(async () => {
      connections++;

      if (!up) throw new Error("No Whiteboard Desktop server is ready.");

      return client;
    });

    try {
      expect(connections).toBe(0);

      const init = await mcp.request(1, "initialize", initialize);
      expect(init.result.instructions).toContain("session_get_instructions");
      expect(init.result.instructions).toContain("trace-archaeology");
      expect(init.result.instructions).toContain('topic:"scratchpad"');
      const list = await mcp.request(2, "tools/list", {});
      expect(
        list.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["session_get_instructions"]);
      expect(list.result.tools[0].description).not.toContain("scratchpad");

      const down = await mcp.request(3, "tools/call", {
        name: "session_get_instructions",
        arguments: {},
      });

      expect(down.result.isError).toBeFalsy();
      expect(down.result.content[0].text).toMatch(/^Whiteboard is not running/);

      up = true;

      const live = await mcp.request(4, "tools/call", {
        name: "session_get_instructions",
        arguments: {},
      });

      expect(live.result.content[0].text).toContain("rfc-style whiteboard");
      const liveList = await mcp.request(5, "tools/list", {});
      expect(liveList.result.tools[0].name).toBe("session_get_instructions");
      expect(
        liveList.result.tools.filter(
          (tool: { name: string }) => tool.name === "session_get_instructions",
        ),
      ).toHaveLength(1);

      up = false;

      const restartedDown = await mcp.request(6, "tools/call", {
        name: "session_get_instructions",
        arguments: {},
      });

      expect(restartedDown.result.content[0].text).toMatch(
        /^Whiteboard is not running/,
      );
      up = true;

      const restarted = await mcp.request(7, "tools/call", {
        name: "session_get_instructions",
        arguments: { topic: "trace-archaeology" },
      });

      expect(restarted.result.content[0].text).toContain("trace");
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it("tells a session that listed tools while down to reload them", async () => {
    let up = false;

    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const app = createSessionApi(store);

    const client = new SessionApiClient(
      {
        serverUrl: "http://whiteboard.test",
        token: "test",
        apiPath: "/sessions-api",
      },
      async (url, init) => app.request(url.replace("/sessions-api", ""), init),
    );

    const mcp = await startMcp(async () => {
      if (!up) throw new Error("No Whiteboard Desktop server is ready.");

      return client;
    });

    const instructions = async (id: number) =>
      (
        await mcp.request(id, "tools/call", {
          name: "session_get_instructions",
          arguments: {},
        })
      ).result.content[0].text as string;

    try {
      await mcp.request(1, "initialize", initialize);
      await mcp.request(2, "tools/list", {});

      up = true;

      const stale = await instructions(3);
      expect(stale).toMatch(/^Whiteboard is running now/);
      expect(stale).toContain("reload");
      expect(stale).toContain("rfc-style whiteboard");

      await mcp.request(4, "tools/list", {});

      expect(await instructions(5)).not.toMatch(/^Whiteboard is running now/);
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it("uses the live scratchpad catalog description and preserves tool errors", async () => {
    const store = new SessionStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const app = createSessionApi(
      store,
      undefined,
      async () => ({ softwareMapEnabled: false }),
      undefined,
      () => ({ desktopAvailable: true, softwareMapEnabled: false }),
      () => true,
    );

    let failInstruction = false;

    const client = new SessionApiClient(
      {
        serverUrl: "http://whiteboard.test",
        token: "test",
        apiPath: "/sessions-api",
      },
      async (url, init) => {
        if (failInstruction && url.includes("/instructions"))
          return new Response(JSON.stringify({ error: "server failed" }), {
            status: 500,
          });

        return app.request(url.replace("/sessions-api", ""), init);
      },
    );

    const mcp = await startMcp(async () => client);

    try {
      await mcp.request(1, "initialize", initialize);

      const list = await mcp.request(2, "tools/list", {});
      expect(list.result.tools[0].description).toContain('topic:"scratchpad"');

      const invalid = await mcp.request(3, "tools/call", {
        name: "session_get_instructions",
        arguments: { topic: "../secrets" },
      });

      expect(invalid.result.isError).toBe(true);
      expect(invalid.result.content[0].text).not.toMatch(
        /^Whiteboard is not running/,
      );

      failInstruction = true;

      const failed = await mcp.request(4, "tools/call", {
        name: "session_get_instructions",
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
