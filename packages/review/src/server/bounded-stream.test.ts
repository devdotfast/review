import { expect, it } from "vitest";

import { StreamLimitError, readBoundedStream } from "./bounded-stream.js";

it("reads chunks exactly up to the limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abc"));
      controller.enqueue(new TextEncoder().encode("de"));
      controller.close();
    },
  });

  expect((await readBoundedStream(stream, 5)).toString()).toBe("abcde");
});

it("cancels an oversized stream without masking the size error", async () => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
      throw new Error("cancel failed");
    },
  });

  await expect(readBoundedStream(stream, 8)).rejects.toBeInstanceOf(
    StreamLimitError,
  );
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
