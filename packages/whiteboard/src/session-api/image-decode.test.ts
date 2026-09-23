import { afterEach, expect, it, vi } from "vitest";

import { decodeImage } from "./image-decode.js";

afterEach(() => vi.unstubAllGlobals());

it("rejects image ingestion before loading Sharp in Linux Electron", async () => {
  vi.stubGlobal("process", {
    ...process,
    platform: "linux",
    versions: { ...process.versions, electron: "42.10.0" },
  });

  await expect(decodeImage(new Uint8Array())).rejects.toThrow(
    "Image uploads and imports are unavailable in Whiteboard on Linux.",
  );
});
