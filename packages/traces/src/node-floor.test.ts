import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NODE_FLOOR_MAJOR,
  nodeFloorMessage,
  supportedNodeRuntime,
} from "./node-floor";

describe("node floor", () => {
  it("accepts 22 and newer", () => {
    expect(supportedNodeRuntime("22.0.0")).toBe(true);
    expect(supportedNodeRuntime("24.15.0")).toBe(true);
    expect(supportedNodeRuntime("24.18.0")).toBe(true);
  });

  it("rejects older versions", () => {
    expect(supportedNodeRuntime("21.7.3")).toBe(false);
    expect(supportedNodeRuntime("20.11.0")).toBe(false);
    expect(supportedNodeRuntime("20.19.0")).toBe(false);
  });

  it("rejects a version with a non-numeric major", () => {
    expect(supportedNodeRuntime("")).toBe(false);
    expect(supportedNodeRuntime("v22.0.0")).toBe(false);
    expect(supportedNodeRuntime("lts.0.0")).toBe(false);
  });

  it("matches the floor the package manifest declares", async () => {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );

    const manifest: { engines?: { node?: string } } = JSON.parse(
      await readFile(manifestPath, "utf8"),
    );

    const engines = manifest.engines?.node ?? "";
    const major = /(\d+)/.exec(engines)?.[1];
    expect(major).toBeDefined();
    expect(Number(major)).toBe(NODE_FLOOR_MAJOR);
  });

  it("names the floor and the found version", () => {
    expect(nodeFloorMessage("20.19.0")).toBe(
      "dev-traces needs Node.js 22 or newer; found 20.19.0. Install Node 22 and rerun.\n",
    );
  });
});
