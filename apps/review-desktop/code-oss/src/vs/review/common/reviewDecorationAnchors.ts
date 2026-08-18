/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewThreadAnchorWire } from "./reviewProtocol.js";

export class ReviewDecorationAnchors {
  private readonly anchorsBySessionPath = new Map<
    string,
    ReviewThreadAnchorWire[]
  >();

  set(sessionId: string, path: string, anchors: ReviewThreadAnchorWire[]): void {
    this.anchorsBySessionPath.set(
      reviewDecorationAnchorsKey(sessionId, path),
      anchors,
    );
  }

  get(sessionId: string, path: string): ReviewThreadAnchorWire[] | undefined {
    return this.anchorsBySessionPath.get(
      reviewDecorationAnchorsKey(sessionId, path),
    );
  }

  clear(sessionId: string, path?: string): void {
    if (path) {
      this.anchorsBySessionPath.delete(
        reviewDecorationAnchorsKey(sessionId, path),
      );
      return;
    }
    const prefix = `${sessionId}\u0000`;
    for (const key of this.anchorsBySessionPath.keys()) {
      if (key.startsWith(prefix)) this.anchorsBySessionPath.delete(key);
    }
  }

  clearAll(): void {
    this.anchorsBySessionPath.clear();
  }
}

export function reviewDecorationAnchorsKey(
  sessionId: string,
  path: string,
): string {
  return `${sessionId}\u0000${path}`;
}

export function reviewDecorationSessionId(
  requestSessionId: string | undefined,
  currentSessionId: string | undefined,
): string {
  return requestSessionId ?? currentSessionId ?? "";
}
