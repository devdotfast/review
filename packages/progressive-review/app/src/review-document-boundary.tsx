import { Component, type ErrorInfo, type ReactNode } from "react";

import type { ReviewSession } from "./host/review-session";
import { ReviewCanvasLoading } from "./review-canvas-loading";
import { captureClientError } from "./ui-telemetry";

interface ReviewDocumentBoundaryProps {
  session: ReviewSession;
  revision: string;
  onError: (revision: string, error: unknown) => void;
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

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (this.reported) return;
    this.reported = true;
    captureClientError(this.props.session, "render", error);
    this.props.onError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ReviewCanvasLoading
          message="Your coding agent is writing the canvas now…"
          note={
            <>
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
