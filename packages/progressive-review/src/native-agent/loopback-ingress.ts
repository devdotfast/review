import { randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface LoopbackIngressInput {
  /** First path segment every post must carry, e.g. the harness name. */
  scope: string;
  /** Handle one post for `/<scope>/<sessionId>`. Throw to answer 400. */
  onPost(sessionId: string, payload: JsonValue): void;
}

/**
 * A loopback HTTP listener that a native terminal reports to. Started on
 * first use; the token is per listener, so only terminals this server
 * launched can post.
 */
export class LoopbackIngress {
  readonly token = randomBytes(32).toString("base64url");
  readonly #input: LoopbackIngressInput;
  #listener: Promise<{ server: Server; url: string }> | undefined;

  constructor(input: LoopbackIngressInput) {
    this.#input = input;
  }

  /** Base URL of the listener, e.g. `http://127.0.0.1:12345`. */
  url(): Promise<string> {
    return this.#listen().then(({ url }) => url);
  }

  async close(): Promise<void> {
    if (!this.#listener) return;
    const { server } = await this.#listener;
    this.#listener = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #listen(): Promise<{ server: Server; url: string }> {
    this.#listener ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#handle(request)
          .then(({ status, body }) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          })
          .catch((cause: unknown) => {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: String(cause) }));
          });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        // SAFETY: a TCP listener bound to a port reports an AddressInfo, never a pipe path.
        const { port } = server.address() as AddressInfo;
        resolve({ server, url: `http://127.0.0.1:${port}` });
      });
    });
    return this.#listener;
  }

  async #handle(
    request: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    if (request.method !== "POST") {
      return { status: 405, body: { ok: false, error: "POST only." } };
    }
    if (request.headers["x-review-token"] !== this.token) {
      return { status: 401, body: { ok: false, error: "Unauthorized" } };
    }
    const match = /^\/([^/]+)\/([^/]+)$/u.exec(request.url ?? "");
    if (!match || match[1] !== this.#input.scope) {
      return { status: 404, body: { ok: false, error: "Unknown session." } };
    }
    const payload = await readJsonBody(request);
    try {
      this.#input.onPost(decodeURIComponent(match[2]!), payload);
    } catch (error) {
      return {
        status: 400,
        body: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return { status: 200, body: { ok: true } };
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Native agent payload is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? parseJsonText(text) : {};
}
