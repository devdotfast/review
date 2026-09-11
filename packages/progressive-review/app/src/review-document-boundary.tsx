import { Component, type ErrorInfo, type ReactNode } from "react";

import type { ReviewSession } from "./host/review-session";
import { ReviewUnavailable } from "./review-empty-state";
import { captureClientError } from "./ui-telemetry";

interface ReviewDocumentBoundaryProps {
  session: ReviewSession;
  revision: string;
  onError: (revision: string, error: Error) => void;
  children: ReactNode;
}

interface ReviewDocumentBoundaryState {
  hasError: boolean;
}

export class ReviewDocumentBoundary extends Component<
  ReviewDocumentBoundaryProps,
  ReviewDocumentBoundaryState
> {
  state: ReviewDocumentBoundaryState = { hasError: false };
  private reported = false;

  static getDerivedStateFromError(): ReviewDocumentBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (this.reported) return;
    this.reported = true;
    captureClientError(this.props.session, "render", error);
    this.props.onError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ReviewUnavailable
          role="status"
          message={
            <>
              Your coding agent is writing the canvas now…
              <br />
              Your agent is debugging the canvas candidate from{" "}
              <code>review publish</code>.
            </>
          }
        />
      );
    }
    return this.props.children;
  }
}
