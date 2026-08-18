import { EventEmitter } from "node:events";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  type LaunchDesktopApplicationInput,
  launchDesktopApplication,
  runReviewAppLaunch,
} from "./review-app-launcher";

const discovery: ReviewDesktopDiscovery = {
  version: REVIEW_DESKTOP_DISCOVERY_VERSION,
  instanceId: "desktop-1",
  url: "http://127.0.0.1:5570",
  appPid: 1,
  serverPid: 2,
  token: "secret",
  startedAt: 3,
};

describe("Review Desktop launcher", () => {
  it("activates and reuses a healthy instance with an attached Desktop client", async () => {
    const launchDesktop = vi.fn<typeof launchDesktopApplication>(() =>
      pendingAttempt(),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(healthyResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(
      runReviewAppLaunch(
        {},
        {
          readReviewDesktopDiscovery: async () => discovery,
          fetch,
          launchDesktop,
        },
      ),
    ).resolves.toEqual({
      event: "app",
      action: "launch",
      state: "running",
      instanceId: discovery.instanceId,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${discovery.url}/app/focus`,
      expect.objectContaining({
        method: "POST",
        headers: { "x-review-token": discovery.token },
      }),
    );
    expect(launchDesktop).not.toHaveBeenCalled();
  });

  it("launches when discovery is missing", async () => {
    let readCount = 0;
    const launchDesktop = vi.fn<typeof launchDesktopApplication>(() =>
      pendingAttempt(),
    );
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          ...launcherRuntime([healthyResponse()], launchDesktop),
          readReviewDesktopDiscovery: async () =>
            readCount++ === 0 ? null : discovery,
        },
      ),
    ).resolves.toMatchObject({ state: "launched" });
    expect(launchDesktop).toHaveBeenCalledOnce();
  });

  it("ignores unreadable discovery and launches Desktop", async () => {
    let readCount = 0;
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          ...launcherRuntime(
            [healthyResponse()],
            vi.fn<typeof launchDesktopApplication>(() => pendingAttempt()),
          ),
          readReviewDesktopDiscovery: async () => {
            if (readCount++ === 0) throw new Error("unreadable discovery");
            return discovery;
          },
        },
      ),
    ).resolves.toMatchObject({ state: "launched" });
  });

  it("ignores stale discovery and waits for the new instance", async () => {
    const fresh = { ...discovery, instanceId: "desktop-2" };
    let readCount = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          instanceId: fresh.instanceId,
          desktopAttached: true,
        }),
      );
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          readReviewDesktopDiscovery: async () =>
            readCount++ === 0 ? discovery : fresh,
          fetch,
          launchDesktop: () => pendingAttempt(),
          now: () => 0,
          wait: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      state: "launched",
      instanceId: fresh.instanceId,
    });
  });

  it("polls through delayed server and Desktop attachment", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          instanceId: discovery.instanceId,
          desktopAttached: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          instanceId: discovery.instanceId,
          desktopAttached: true,
        }),
      );
    let now = 0;
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          readReviewDesktopDiscovery: async () => discovery,
          fetch,
          launchDesktop: () => pendingAttempt(),
          now: () => now,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).resolves.toMatchObject({ state: "launched" });
  });

  it("reports the launch method and recovery after an early exit", async () => {
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          readReviewDesktopDiscovery: async () => null,
          fetch: vi.fn<typeof globalThis.fetch>(),
          launchDesktop: () => ({
            method: 'the macOS bundle identifier "dev.fast.review"',
            successfulExitIsExpected: true,
            completion: Promise.resolve({ code: 1, signal: null }),
          }),
          now: () => 0,
          wait: () => new Promise(() => undefined),
        },
      ),
    ).rejects.toThrow(
      'Could not launch Review Desktop with the macOS bundle identifier "dev.fast.review": the launch process exited with code 1. Open Review Desktop once, then run `review app launch` again.',
    );
  });

  it("observes an asynchronous spawn failure while health polling is pending", async () => {
    let readCount = 0;
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          readReviewDesktopDiscovery: async () =>
            readCount++ === 0 ? null : discovery,
          fetch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return Response.json({ ok: false });
          },
          launchDesktop: () => ({
            method: 'the Desktop-managed bundle at "/missing/Review"',
            successfulExitIsExpected: false,
            completion: Promise.reject(new Error("spawn ENOENT")),
          }),
          now: () => 0,
          wait: () => new Promise(() => undefined),
        },
      ),
    ).rejects.toThrow(
      'Could not launch Review Desktop with the Desktop-managed bundle at "/missing/Review": spawn ENOENT.',
    );
  });

  it("reports a successful Electron exit before Desktop becomes ready", async () => {
    let now = 0;
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          readReviewDesktopDiscovery: async () => null,
          fetch: vi.fn<typeof globalThis.fetch>(),
          launchDesktop: () => ({
            method: 'the Desktop-managed bundle at "/tmp/Review"',
            successfulExitIsExpected: false,
            completion: Promise.resolve({ code: 0, signal: null }),
          }),
          now: () => now,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).rejects.toThrow(
      'Could not launch Review Desktop with the Desktop-managed bundle at "/tmp/Review": the launch process exited before Desktop became ready.',
    );
  });

  it("launches the exact Electron path without ELECTRON_RUN_AS_NODE", () => {
    const child = new FakeChild();
    const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
      () => child,
    );
    launchDesktopApplication({
      platform: "darwin",
      electron: true,
      execPath: "/tmp/Review.app/Contents/MacOS/Review",
      env: { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/tmp/Review.app/Contents/MacOS/Review",
      [],
      expect.objectContaining({
        detached: true,
        env: { KEEP: "yes" },
        stdio: "ignore",
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("passes the isolated Desktop profile to the exact Electron path", () => {
    const child = new FakeChild();
    const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
      () => child,
    );
    launchDesktopApplication({
      platform: "darwin",
      electron: true,
      execPath: "/tmp/Review.app/Contents/MacOS/Review",
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: "/tmp/review-state",
      },
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/tmp/Review.app/Contents/MacOS/Review",
      [
        "--user-data-dir=/tmp/review-state/user-data",
        "--extensions-dir=/tmp/review-state/extensions",
      ],
      expect.objectContaining({
        env: {
          DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: "/tmp/review-state",
        },
      }),
    );
  });

  it("uses the bundle identifier for a standalone CLI", () => {
    const child = new FakeChild();
    const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
      () => child,
    );
    launchDesktopApplication({
      platform: "darwin",
      electron: false,
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-b", "dev.fast.review"],
      expect.objectContaining({ detached: true }),
    );
  });
});

function launcherRuntime(
  responses: Response[],
  launchDesktop: typeof launchDesktopApplication,
) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    readReviewDesktopDiscovery: async () => discovery,
    fetch,
    focusDesktop: async () => undefined,
    launchDesktop,
    now: () => 0,
    wait: async () => undefined,
  };
}

function healthyResponse(): Response {
  return Response.json({
    ok: true,
    instanceId: discovery.instanceId,
    desktopAttached: true,
  });
}

function pendingAttempt() {
  return {
    method: 'the macOS bundle identifier "dev.fast.review"',
    successfulExitIsExpected: true,
    completion: new Promise<never>(() => undefined),
  };
}

class FakeChild extends EventEmitter {
  readonly unref = vi.fn<() => void>();
}
