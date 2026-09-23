import { SessionInputError } from "./document.js";

/** The one decoder for images entering the store, whether uploaded by a client
 * or read from a legacy review: bounded, single frame, re-encoded as PNG. */
export async function decodeImage(bytes: Uint8Array): Promise<Buffer> {
  // Electron's Linux GLib conflicts with Sharp's bundled native library.
  if (process.platform === "linux" && process.versions.electron)
    throw new SessionInputError(
      "Image uploads and imports are unavailable in Whiteboard on Linux.",
    );

  // Load the native decoder only here, so a missing platform binary fails one upload, not host startup.
  const { default: sharp } = await import("sharp");

  try {
    const decoder = sharp(Buffer.from(bytes), {
      limitInputPixels: 20_000_000,
      failOn: "warning",
    });

    const metadata = await decoder.metadata();

    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error("Unsupported image");

    // One bounded full decode; retain a safe raster format, not the original file.
    return await decoder.png().toBuffer();
  } catch {
    throw new SessionInputError(
      "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels).",
    );
  }
}
