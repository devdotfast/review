import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { writeFileAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

import { devReviewHome } from "./review-home-paths";
import { reviewTelemetryChannel } from "./telemetry-config";

/**
 * A review session the Desktop opened and has not yet reported as ended. The
 * next launch turns any survivor into `review_session_ended{outcome:abnormal}`,
 * which is the floor under crash and hang counts.
 */
export interface OpenSessionMarker {
  presentationSessionId: string;
  reviewUuid: string;
  startedAt: number;
  appSessionId?: string;
  /**
   * The process that owns the session: the Desktop's Electron main for its
   * server. A live owner means the session is still open, whichever launch
   * reconciles.
   */
  ownerPid?: number;
}

const markersSchema = z.array(
  z.object({
    presentationSessionId: z.string().min(1),
    reviewUuid: z.string().min(1),
    startedAt: z.number(),
    appSessionId: z.string().min(1).optional(),
    ownerPid: z.number().int().positive().optional(),
  }),
);

/** Per channel, like the telemetry config: each channel has its own identity. */
export function openSessionMarkersPath(env: NodeJS.ProcessEnv): string {
  return path.join(
    devReviewHome(env),
    "telemetry",
    reviewTelemetryChannel(env) === "preview"
      ? "open-sessions.preview.json"
      : "open-sessions.json",
  );
}

function readMarkers(file: string): OpenSessionMarker[] {
  try {
    const parsed = markersSchema.safeParse(
      parseJsonText(readFileSync(file, "utf8")),
    );

    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function writeMarkers(file: string, markers: OpenSessionMarker[]): void {
  writeFileAtomic(file, `${JSON.stringify(markers)}\n`, "utf8");
}

export function recordOpenSession(
  file: string,
  marker: OpenSessionMarker,
): void {
  const others = readMarkers(file).filter(
    (existing) =>
      existing.presentationSessionId !== marker.presentationSessionId,
  );

  writeMarkers(file, [...others, marker]);
}

export function clearOpenSession(
  file: string,
  presentationSessionId: string,
): void {
  if (!existsSync(file)) return;
  writeMarkers(
    file,
    readMarkers(file).filter(
      (marker) => marker.presentationSessionId !== presentationSessionId,
    ),
  );
}

/** Reads every marker and deletes the file. */
export function takeOpenSessions(file: string): OpenSessionMarker[] {
  const markers = readMarkers(file);
  rmSync(file, { force: true });

  return markers;
}
