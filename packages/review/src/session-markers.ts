import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { parseJsonText } from "@dev.fast/review-protocol";
import { writeFileAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

import type { PostHogCaptureProperties } from "./posthog-capture-client";
import { devReviewHome } from "./review-home-paths";
import { reviewTelemetryChannel, uuidV7Schema } from "./telemetry-config";

/**
 * The envelope fields of the launch that opened a session which a later
 * launch may not share. An abnormal end carries them so it counts against
 * the launch that died, not the one that reported it. Closed values only.
 */
const launchEnvelopeSchema = z.object({
  app_version: z.string().min(1).optional(),
  cli_version: z.string().min(1),
  version: z.string().min(1),
  channel: z.enum(["stable", "preview", "dev"]),
  environment: z.enum(["production", "ci", "internal", "e2e", "smoke"]),
  surface: z.enum(["desktop", "cli", "headless", "mcp", "api"]),
  node_major: z.number().int(),
  arch: z.string().min(1),
  os_version: z.string().min(1),
  ci: z.boolean(),
  internal: z.boolean(),
  $session_id: uuidV7Schema.optional(),
  install_age_days: z.number().int().nonnegative().optional(),
});

export type LaunchEnvelope = z.infer<typeof launchEnvelopeSchema>;

/** Picks the launch fields out of an event envelope; undefined if malformed. */
export function launchEnvelope(
  properties: PostHogCaptureProperties,
): LaunchEnvelope | undefined {
  return launchEnvelopeSchema.safeParse(properties).data;
}

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
  /** Absent on markers written before launches recorded their envelope. */
  envelope?: LaunchEnvelope;
}

const markersSchema = z.array(
  z.object({
    presentationSessionId: z.string().min(1),
    reviewUuid: z.string().min(1),
    startedAt: z.number(),
    appSessionId: z.string().min(1).optional(),
    ownerPid: z.number().int().positive().optional(),
    // A malformed envelope degrades to a legacy marker, not a lost one.
    envelope: launchEnvelopeSchema.optional().catch(undefined),
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
