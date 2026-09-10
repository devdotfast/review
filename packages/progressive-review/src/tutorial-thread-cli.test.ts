import { type RequestListener, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runReviewCli } from "./cli-routing";

const servers: Server[] = [];
const token = "attached-tutorial-token";
const threadId = "tutorial-question-1";
const payload = {
  tutorial: true,
  review: "bundled-tutorial",
  state: "draft",
  comment: {
    threadId,
    target: { kind: "document" },
    status: "open",
    messages: [
      {
        id: "question",
        by: "Reviewer",
        at: "2026-09-10T12:00:00.000Z",
        body: "Why is this line changed?",
        role: "reviewer",
        format: "plain",
        agentInput: true,
      },
      {
        id: "answer",
        by: "Agent",
        at: "2026-09-10T12:00:10.000Z",
        body: "It handles empty input.",
        role: "agent",
        format: "markdown",
        agentInput: false,
      },
    ],
  },
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("attached tutorial question CLI", () => {
  it("reads the complete attached tutorial thread through the public entry", async () => {
    const requests: {
      url: string | undefined;
      token: string | string[] | undefined;
    }[] = [];
    const baseUrl = await serve((request, response) => {
      requests.push({
        url: request.url,
        token: request.headers["x-review-token"],
      });
      response.end(JSON.stringify(payload));
    });
    const result = await run(["internal-thread", threadId], attached(baseUrl));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual(payload);
    expect(requests).toEqual([
      { url: `/agent-threads/${threadId}?scope=tutorial`, token },
    ]);
  });

  it("does not discover an author connection when tutorial credentials are absent", async () => {
    const result = await run(["internal-thread", threadId], {
      DEV_REVIEW_HOST_URL: "http://127.0.0.1:1",
      DEV_REVIEW_HOST_TOKEN: "author-connection",
      DEV_REVIEW_HOME: "/does-not-exist",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("requires an attached");
    expect(result.output).not.toContain("author-connection");
  });

  it.each([false, undefined])(
    "refuses a non-tutorial response (%s)",
    async (tutorial) => {
      const baseUrl = await serve((_request, response) => {
        response.end(JSON.stringify({ ...payload, tutorial }));
      });
      const result = await run(
        ["internal-thread", threadId],
        attached(baseUrl),
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain("invalid tutorial question");
      expect(result.output).not.toContain("Why is this line changed?");
    },
  );

  it("refuses a different thread returned by the server", async () => {
    const baseUrl = await serve((_request, response) => {
      response.end(
        JSON.stringify({
          ...payload,
          comment: { ...payload.comment, threadId: "other" },
        }),
      );
    });
    const result = await run(["internal-thread", threadId], attached(baseUrl));
    expect(result.code).toBe(1);
    expect(result.output).toContain("invalid tutorial question");
  });

  it("does not expose server failure text or credentials", async () => {
    const baseUrl = await serve((_request, response) => {
      response.statusCode = 403;
      response.end(`private server stack /Users/private/data ${token}`);
    });
    const result = await run(["internal-thread", threadId], attached(baseUrl));
    expect(result.code).toBe(1);
    expect(result.output).toContain("did not authorize or find");
    expect(result.output).not.toContain("private");
    expect(result.output).not.toContain(token);
  });

  it("never follows a redirect carrying the attached credential", async () => {
    let redirectedRequests = 0;
    const destination = await serve((_request, response) => {
      redirectedRequests++;
      response.end(JSON.stringify(payload));
    });
    const baseUrl = await serve((_request, response) => {
      response.writeHead(302, {
        Location: `${destination}/agent-threads/${threadId}`,
      });
      response.end();
    });
    const result = await run(["internal-thread", threadId], attached(baseUrl));
    expect(result.code).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(result.output).not.toContain(token);
  });

  it.each([
    "https://127.0.0.1/agent-threads",
    "http://example.com/agent-threads",
    "http://127.0.0.1/agent-threads?scope=all",
    "http://127.0.0.1/other",
  ])("refuses an invalid attached destination %s", async (url) => {
    const result = await run(["internal-thread", threadId], {
      DEV_FAST_REVIEW_AGENT_THREAD_URL: url,
      DEV_FAST_REVIEW_AGENT_THREAD_TOKEN: token,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Invalid attached tutorial connection");
  });

  it("bounds the complete response before parsing", async () => {
    const baseUrl = await serve((_request, response) => {
      response.end(" ".repeat(2 * 1024 * 1024 + 1));
    });
    const result = await run(["internal-thread", threadId], attached(baseUrl));
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not read");
  });

  it("keeps normal legacy commands disabled even in an attached tutorial", async () => {
    let requests = 0;
    const baseUrl = await serve((_request, response) => {
      requests++;
      response.end(JSON.stringify(payload));
    });
    const result = await run(["threads", "get", threadId], attached(baseUrl));
    expect(result.code).toBe(1);
    expect(result.output).toContain("retired");
    expect(requests).toBe(0);
  });
});

function attached(baseUrl: string): NodeJS.ProcessEnv {
  return {
    DEV_FAST_REVIEW_AGENT_THREAD_URL: `${baseUrl}/agent-threads`,
    DEV_FAST_REVIEW_AGENT_THREAD_TOKEN: token,
    NO_PROXY: "*",
  };
}

async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => (output += String(chunk)));
  const code = await runReviewCli({
    argv,
    env,
    stdout,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
  });
  return { code, output };
}

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
