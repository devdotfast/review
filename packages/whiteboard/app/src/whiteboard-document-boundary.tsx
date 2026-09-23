import { Component, type ErrorInfo, type ReactNode } from "react";

import type { WhiteboardSession } from "./host/whiteboard-session";
import { captureClientError } from "./ui-telemetry";
import { WhiteboardUnavailable } from "./whiteboard-empty-state";

interface WhiteboardDocumentBoundaryProps {
  session: WhiteboardSession;
  revision: string;
  onError: (revision: string, error: Error) => void;
  children: ReactNode;
}

interface WhiteboardDocumentBoundaryState {
  hasError: boolean;
  revision: string;
}

export class WhiteboardDocumentBoundary extends Component<
  WhiteboardDocumentBoundaryProps,
  WhiteboardDocumentBoundaryState
> {
  state: WhiteboardDocumentBoundaryState = {
    hasError: false,
    revision: this.props.revision,
  };
  private reportedRevision: string | undefined;

  static getDerivedStateFromError(): Pick<
    WhiteboardDocumentBoundaryState,
    "hasError"
  > {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: WhiteboardDocumentBoundaryProps,
    state: WhiteboardDocumentBoundaryState,
  ): WhiteboardDocumentBoundaryState | null {
    // New content gets a fresh render; the last failure was for the old revision.
    return props.revision === state.revision
      ? null
      : { hasError: false, revision: props.revision };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (this.reportedRevision === this.props.revision) return;
    this.reportedRevision = this.props.revision;
    captureClientError(this.props.session, "render", error);
    this.props.onError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <WhiteboardUnavailable
          role="status"
          message={
            <>
              Your coding agent is writing the canvas now…
              <br />
              Edit the review through the Whiteboard MCP tools or{" "}
              <code>whiteboard api</code> to replace the failing block.
            </>
          }
        />
      );
    }

    return this.props.children;
  }
}
