import type { Writable } from "node:stream";

import {
  SessionApiClient,
  type SessionSummary,
} from "@dev.fast/whiteboard-protocol";

import {
  readWhiteboardDesktopDiscovery,
  requireHealthyWhiteboardDesktop,
} from "./desktop-discovery";
import { resolveWhiteboardRoot } from "./runtime";
import {
  focusWhiteboardDesktop,
  runWhiteboardAppLaunch,
} from "./whiteboard-app-launcher";
import { pickWhiteboard } from "./whiteboard-app-picker";

interface WhiteboardAppRuntime {
  launch: typeof runWhiteboardAppLaunch;
  readWhiteboardDesktopDiscovery: typeof readWhiteboardDesktopDiscovery;
  requireHealthyWhiteboardDesktop: typeof requireHealthyWhiteboardDesktop;
  resolveWhiteboardRoot: typeof resolveWhiteboardRoot;
  pickWhiteboard: typeof pickWhiteboard;
  fetch: typeof globalThis.fetch;
}

export interface RunWhiteboardAppInput {
  cwd: string;
  sessionId?: string;
  /** Bring Review Desktop forward. */
  focus?: boolean;
  stdin: NodeJS.ReadStream;
  stdout: Writable;
}

export interface WhiteboardAppEvent {
  event: "app";
  action: "pick";
  sessionId: string;
  title: string;
  cancelled?: boolean;
}

export async function runWhiteboardAppPick(
  input: RunWhiteboardAppInput,
  overrides: Partial<WhiteboardAppRuntime> = {},
): Promise<WhiteboardAppEvent | null> {
  const runtime = {
    launch: runWhiteboardAppLaunch,
    readWhiteboardDesktopDiscovery,
    requireHealthyWhiteboardDesktop,
    resolveWhiteboardRoot,
    pickWhiteboard,
    fetch: globalThis.fetch,
    ...overrides,
  };

  // Only `whiteboard app launch` may recover a stale or incompatible pointer; the
  // other verbs report the diagnosis rather than start a second Desktop. A null
  // read means nothing is running, which launching does fix.
  let launched = false;

  if (!(await runtime.readWhiteboardDesktopDiscovery())) {
    await runtime.launch({ focus: input.focus });
    launched = true;
  }

  const discovery = await runtime.requireHealthyWhiteboardDesktop(
    "whiteboard app pick",
    {
      readDiscovery: runtime.readWhiteboardDesktopDiscovery,
      fetch: runtime.fetch,
    },
  );

  const client = new SessionApiClient(
    {
      serverUrl: discovery.url,
      apiPath: "/sessions-api",

      token: discovery.token,
    },
    runtime.fetch,
  );

  let review: Pick<SessionSummary, "sessionId" | "title">;

  if (input.sessionId) {
    // Without `full`, GET /sessions-api/:id answers inspectSnapshot(): block
    // descriptors with no sessionId or title.
    review = await client.read(
      `/${encodeURIComponent(input.sessionId)}?full=true`,
    );
  } else {
    if (!input.stdin.isTTY)
      throw new Error(
        "whiteboard app pick needs a terminal without --session. Pass --session <uuid> or run it in a terminal.",
      );
    const root = await runtime.resolveWhiteboardRoot(input.cwd);

    const reviews = (await client.read<SessionSummary[]>(""))
      .filter((review) => review.repositoryPath === root && !review.dismissedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (!reviews.length) throw new Error("No session to show.");

    const picked = await runtime.pickWhiteboard(
      reviews.map((review) => ({
        uuid: review.sessionId,
        title: review.title,
        status: review.viewedAt ? "viewed" : "new",
        lastPublishedAt: review.createdAt,
      })),
      input,
    );

    if (!picked) return null;
    review = { sessionId: picked.uuid, title: picked.title };
  }

  await client.post(`/${encodeURIComponent(review.sessionId)}/open`, {});

  // A focused fresh launch already came forward; a running one must be asked.
  if (input.focus && !launched)
    await focusWhiteboardDesktop(discovery, runtime.fetch);

  return {
    event: "app",
    action: "pick",
    sessionId: review.sessionId,
    title: review.title,
  };
}
