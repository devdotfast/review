// Keep this compatibility module because the review server and app import it.
// The implementation lives in one place so CLI and UI telemetry share the
// same install state, privacy checks, queue, and transport.
export {
  ProgressiveReviewTelemetry,
  createLogger,
  isTelemetryOptedOut,
  type Logger,
  type ReviewTabTelemetryEvent,
  type ReviewTabTelemetryReason,
  type ReviewTelemetryTab,
  type ProgressiveReviewTelemetryContext,
} from "./progressive-review-telemetry";
