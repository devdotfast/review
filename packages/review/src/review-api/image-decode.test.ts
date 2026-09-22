import sharp from "sharp";
import { expect, it } from "vitest";

import { decodeImage } from "./image-decode.js";

it.each(["png", "jpeg", "webp"] as const)(
  "re-encodes %s as a PNG with the original dimensions",
  async (format) => {
    const input = await sharp({
      create: { width: 3, height: 2, channels: 4, background: "red" },
    })
      .toFormat(format)
      .toBuffer();

    const output = await decodeImage(input);
    expect(await sharp(output).metadata()).toMatchObject({
      format: "png",
      width: 3,
      height: 2,
    });

    const pixels = await sharp(output).removeAlpha().raw().toBuffer();

    for (let i = 0; i < pixels.length; i++)
      expect(
        Math.abs(pixels[i]! - (i % 3 === 0 ? 255 : 0)),
      ).toBeLessThanOrEqual(3);
  },
);

it("rejects invalid and truncated images", async () => {
  const png = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();

  for (const input of [Buffer.from("not an image"), png.subarray(0, 50)])
    await expect(decodeImage(input)).rejects.toThrow("Provide a valid single");
});

it("rejects images exceeding 20 megapixels", async () => {
  const input = await sharp({
    create: { width: 5001, height: 4000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();

  await expect(decodeImage(input)).rejects.toThrow("at most 20 megapixels");
});

it("rejects animated WebP and unsupported formats", async () => {
  const image = sharp(
    Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]),
    {
      raw: { width: 2, height: 2, channels: 3, pageHeight: 1 },
    },
  );

  for (const input of [
    await image.webp().toBuffer(),
    await image.gif().toBuffer(),
  ])
    await expect(decodeImage(input)).rejects.toThrow("Provide a valid single");
});
