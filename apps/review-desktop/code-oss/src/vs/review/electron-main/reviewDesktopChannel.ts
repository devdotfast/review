/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../base/common/event.js";
import { IServerChannel } from "../../base/parts/ipc/common/ipc.js";
import type { ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import type { ReviewDesktopHost } from "./reviewDesktopHost.js";

export { REVIEW_DESKTOP_CHANNEL } from "../common/reviewDesktopBootstrap.js";

/**
 * Hands the renderer the endpoint the main process validated. Bootstrap details
 * deliberately do not travel through the window configuration or the process
 * environment: the main process is the only owner of the server credentials.
 */
export class ReviewDesktopChannel implements IServerChannel {
  constructor(private readonly host: ReviewDesktopHost) {}

  listen<T>(): Event<T> {
    return Event.None as Event<T>;
  }

  async call<T>(_context: string, command: string): Promise<T> {
    if (command === "getConnection") {
      const connection: ReviewDesktopConnection = await this.host.whenConnected();
      return connection as T;
    }
    if (command === "stageRustAnalyzer") {
      this.host.stageRustAnalyzer();
      return undefined as T;
    }
    throw new Error(`Unknown Review Desktop channel call: ${command}`);
  }
}
