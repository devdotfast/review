import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";
import type { loadReviewAgentTrace } from "@dev.fast/trace-core";

import type { ReviewSoftwareMapBundle } from "../software-map-bundle";
import {
  hydrateSoftwareModel,
  softwareModelDataSchema,
} from "../software-map-model";

type LoadedTrace = NonNullable<
  Awaited<ReturnType<typeof loadReviewAgentTrace>>
>;

export interface TraceResourceEvent {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface TraceResource {
  label: string;
  events: TraceResourceEvent[];
}

/** A parsed agent trace as the `trace` resource the JSON store keeps for
 * quotes: one flat event list with positional ids. */
export function traceResourceFromLoaded(loaded: LoadedTrace): TraceResource {
  const events: TraceResourceEvent[] = [];

  for (const event of loaded.trace.events) {
    const id = String(events.length);

    switch (event.kind) {
      case "user":
        events.push({ id, role: "user", text: event.text });
        break;
      case "assistant":
        events.push({ id, role: "assistant", text: event.markdown });
        break;
      case "tool":
        events.push({
          id,
          role: "tool",
          text: [event.tool, event.verb, event.title].filter(Boolean).join(" "),
        });
        break;
      default:
        // Separators carry no quotable text.
        break;
    }
  }

  return { label: loaded.trace.title ?? loaded.descriptor.sessionId, events };
}

export interface MapResourcePayload {
  side: "base" | "head";
  commit: string;
  json: string;
}

/** The two sides of a presented software map bundle as `map` resources in
 * the shape `LocalReviewData.map` reads back. */
export function mapResourcesFromBundle(
  bundle: ReviewSoftwareMapBundle,
): MapResourcePayload[] {
  const one = (
    side: "base" | "head",
    json: string,
    commit: string,
  ): MapResourcePayload => {
    // The bundle file wraps the model data with its format tag.
    const { format: _format, ...data } = jsonObject(parseJsonText(json)) ?? {};

    const model = hydrateSoftwareModel(softwareModelDataSchema.parse(data));

    return {
      side,
      commit,
      json: JSON.stringify({
        commit,
        side,
        elements: model.elements,
        relationships: model.relationships,
      }),
    };
  };

  return [
    one("base", bundle.baseJson, bundle.baseCommit),
    one("head", bundle.headJson, bundle.headCommit),
  ];
}
