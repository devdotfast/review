import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  readHealthyReviewDesktopDiscovery,
  requireHealthyReviewDesktop,
} from "./desktop-discovery";

const discovery: ReviewDesktopDiscovery = {
  version: REVIEW_DESKTOP_DISCOVERY_VERSION,
  instanceId: "desktop-1",
  url: "http://127.0.0.1:5570",
  appPid: 1,
  serverPid: 2,
  token: "secret",
  startedAt: 3,
};

describe("Review Desktop health discovery", () => {
  it("accepts only the matching instance with an attached Desktop client", async () => {
    await expect(
      readHealthyReviewDesktopDiscovery({
        readDiscovery: async () => discovery,
        fetch: vi.fn<() => Promise<Response>>(async () =>
          Response.json({
            ok: true,
            instanceId: discovery.instanceId,
            desktopAttached: true,
          }),
        ),
      }),
    ).resolves.toEqual(discovery);
  });

  it.each([
    [
      "dead server",
      vi.fn<() => Promise<Response>>(async () =>
        Promise.reject(new Error("refused")),
      ),
    ],
    [
      "wrong instance",
      vi.fn<() => Promise<Response>>(async () =>
        Response.json({
          ok: true,
          instanceId: "other-instance",
          desktopAttached: true,
        }),
      ),
    ],
    [
      "detached Desktop",
      vi.fn<() => Promise<Response>>(async () =>
        Response.json({
          ok: true,
          instanceId: discovery.instanceId,
          desktopAttached: false,
        }),
      ),
    ],
  ])("rejects %s discovery", async (_label, fetch) => {
    await expect(
      readHealthyReviewDesktopDiscovery({
        readDiscovery: async () => discovery,
        fetch,
      }),
    ).resolves.toBeNull();
  });

  it("gives the explicit recovery command for stale discovery", async () => {
    await expect(
      requireHealthyReviewDesktop("review info", {
        readDiscovery: async () => discovery,
        fetch: vi.fn<() => Promise<Response>>(async () =>
          Promise.reject(new Error("refused")),
        ),
      }),
    ).rejects.toThrow(
      "Review Desktop is not ready. Run `review app launch`, then retry `review info`.",
    );
  });
});
