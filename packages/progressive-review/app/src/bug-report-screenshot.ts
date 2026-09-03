import {
  type ReviewCanvasBridge,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 1600;
const CAPTURE_TIMEOUT_MS = 1_500;
const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class ScreenshotTooLargeError extends Error {
  constructor() {
    super("Screenshot exceeds the 3 MiB attachment limit.");
    this.name = "ScreenshotTooLargeError";
  }
}

export async function normalizeScreenshot(
  source: Blob | string,
): Promise<string | null> {
  const blob = source instanceof Blob ? source : dataUrlBlob(source);
  if (!SUPPORTED_IMAGE_MIMES.has(blob.type.toLowerCase())) {
    throw new Error("Screenshot must be a PNG, JPEG, or WebP image.");
  }

  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width < 1 || bitmap.height < 1) return null;
    const scale = Math.min(
      1,
      MAX_SCREENSHOT_DIMENSION / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null;
    if (
      decodedBase64Bytes(dataUrl.split(",", 2)[1] ?? "") > MAX_SCREENSHOT_BYTES
    ) {
      throw new ScreenshotTooLargeError();
    }
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

export async function captureWindowScreenshot(
  bridge: Pick<ReviewCanvasBridge, "post">,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      bridge.post({ name: "captureScreenshot", args: {} }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) return null;
    const result = response.result;
    const dataUrl = isJsonObject(result)
      ? jsonString(result.dataUrl)
      : undefined;
    if (dataUrl === undefined) return null;
    return await normalizeScreenshot(dataUrl);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function imageFileFromDataTransfer(
  dataTransfer: DataTransfer,
): Blob | null {
  for (const item of dataTransfer.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  for (const file of dataTransfer.files) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

function dataUrlBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Screenshot data URL is invalid.");
  const mime = match[1]?.toLowerCase() ?? "";
  const binary = atob(match[2] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function decodedBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
