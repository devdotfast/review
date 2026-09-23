// Developer-only telemetry sink. When DEV_FAST_WHITEBOARD_TELEMETRY_DEBUG is `1`
// or `true`, Whiteboard prints each event to stderr and sends nothing to PostHog.
// The switch is an environment variable, not a CLI flag, because the CLI, the
// local server, and the Desktop server host each build their own telemetry
// instance, and most events reach the server process, not the CLI.
import type { PostHogCaptureInput } from "./posthog-capture-client";
import type { WhiteboardTelemetryCaptureClient } from "./whiteboard-telemetry";

/**
 * The debug sink, or `undefined` when the switch is off. The sink replaces the
 * PostHog client: a developer run never reaches the production project.
 */
export function createTelemetryDebugSink(
  env: NodeJS.ProcessEnv,
  output: NodeJS.WritableStream = process.stderr,
): WhiteboardTelemetryCaptureClient | undefined {
  if (!isEnabledEnvValue(env.DEV_FAST_WHITEBOARD_TELEMETRY_DEBUG))
    return undefined;

  return {
    enabled: true,
    // Printing is not sending, so the sink prints events that the opt-out
    // would otherwise drop.
    ignoresOptOut: true,
    capture(input: PostHogCaptureInput): Promise<void> {
      try {
        output.write(`[review-telemetry] ${JSON.stringify(input)}\n`);
      } catch {
        // The sink is a developer aid and must never affect Review behavior.
      }

      return Promise.resolve();
    },
  };
}

function isEnabledEnvValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
