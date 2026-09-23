// Keep this compatibility module because the review server and app import it.
// The implementation lives in one place so CLI and UI telemetry share the
// same install state, privacy checks, queue, and transport.
export {
  WhiteboardTelemetry,
  createLogger,
  isTelemetryOptedOut,
  type Logger,
  type WhiteboardTabTelemetryEvent,
  type WhiteboardTabTelemetryReason,
  type WhiteboardTelemetryTab,
  type WhiteboardTelemetryContext,
} from "./whiteboard-telemetry";
