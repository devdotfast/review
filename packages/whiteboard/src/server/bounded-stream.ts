export class StreamLimitError extends Error {
  constructor() {
    super("Stream exceeds its byte limit.");
  }
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new StreamLimitError();
      }

      parts.push(value);
    }

    return Buffer.concat(parts, size);
  } finally {
    reader.releaseLock();
  }
}
