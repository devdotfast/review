import { z } from "zod";

import {
  type ReviewSessionAgent,
  SESSION_AGENT_KIND,
} from "../ui-telemetry-events.js";

/**
 * Headers the agent CLI sets so the server can say where a review came from.
 * Both are telemetry only and parse to closed enums: anything else a caller
 * sends becomes "other".
 */
export const REVIEW_VIA_HEADER = "x-review-via";

export const REVIEW_AGENT_HEADER = "x-review-agent";

export type ReviewRequestVia = "api" | "mcp" | "other";

const viaSchema = z.enum(["api", "mcp", "other"]).catch("other");

const agentSchema = z.enum(SESSION_AGENT_KIND).optional().catch("other");

export function reviewRequestOrigin(headers: Headers): {
  via: ReviewRequestVia;
  agentKind?: ReviewSessionAgent;
} {
  const via = viaSchema.parse(headers.get(REVIEW_VIA_HEADER));

  const agentKind = agentSchema.parse(
    headers.get(REVIEW_AGENT_HEADER) ?? undefined,
  );

  return agentKind ? { via, agentKind } : { via };
}
