/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createParser } from "eventsource-parser";

import { type JsonValue, parseJsonText } from "./reviewProtocol.js";

const DEFAULT_MAX_EVENT_CHARACTERS = 1024 * 1024;
const EVENT_BOUNDARY = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/g;

export interface ConsumeReviewEventStreamOptions {
  readonly maxEventCharacters?: number;
}

export async function consumeReviewEventStream(
  stream: ReadableStream<Uint8Array>,
  onValue: (value: JsonValue) => void | Promise<void>,
  signal: AbortSignal,
  options: ConsumeReviewEventStreamOptions = {},
): Promise<void> {
  const maxEventCharacters =
    options.maxEventCharacters ?? DEFAULT_MAX_EVENT_CHARACTERS;
  if (!Number.isSafeInteger(maxEventCharacters) || maxEventCharacters <= 0) {
    throw new Error("maxEventCharacters must be a positive safe integer.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sizeGuard = new IncompleteEventSizeGuard(maxEventCharacters);
  const pendingPayloads: string[] = [];
  const parser = createParser({
    onEvent: (event) => pendingPayloads.push(event.data),
    onError: (error) => console.error(error),
  });

  const feed = (chunk: string): void => {
    sizeGuard.push(chunk);
    parser.feed(chunk);
  };
  const drain = async (): Promise<void> => {
    while (pendingPayloads.length > 0) {
      const payload = pendingPayloads.shift();
      if (payload === undefined) continue;
      try {
        await onValue(parseJsonText(payload));
      } catch (error) {
        console.error(error);
      }
    }
  };
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        const trailing = decoder.decode();
        if (trailing) feed(trailing);
        feed("\n\n");
        parser.reset();
        await drain();
        return;
      }

      const decoded = decoder.decode(value, { stream: true });
      if (decoded) feed(decoded);
      await drain();
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
  }
}

class IncompleteEventSizeGuard {
  private unfinishedEvent = "";

  constructor(private readonly maximum: number) {}

  push(chunk: string): void {
    this.unfinishedEvent += chunk;
    EVENT_BOUNDARY.lastIndex = 0;

    let eventStart = 0;
    for (
      let match = EVENT_BOUNDARY.exec(this.unfinishedEvent);
      match;
      match = EVENT_BOUNDARY.exec(this.unfinishedEvent)
    ) {
      this.assertWithinLimit(match.index - eventStart);
      eventStart = EVENT_BOUNDARY.lastIndex;
    }

    this.unfinishedEvent = this.unfinishedEvent.slice(eventStart);
    this.assertWithinLimit(this.unfinishedEvent.length);
  }

  private assertWithinLimit(length: number): void {
    if (length <= this.maximum) return;
    throw new Error(
      `Review event exceeded ${this.maximum} characters before its terminator.`,
    );
  }
}
