import { EventEmitter } from "node:events";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import type { ReviewInstanceSelection } from "./desktop-discovery";
import {
  type LaunchDesktopApplicationInput,
  launchDesktopApplication,
  runReviewAppLaunch,
} from "./review-app-launcher";
import { selectingDesktop } from "./review-test-utils";

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
  it.each([
    [undefined, [[`${discovery.url}/health`, "GET", null]]],
    [
      true,
      [
        [`${discovery.url}/health`, "GET", null],
        [`${discovery.url}/app/focus`, "POST", discovery.token],
      ],
    ],
  ])(
    "reuses a healthy instance and focuses it only when asked: focus=%s",
    async (focus, requests) => {
      const launchDesktop = vi.fn<typeof launchDesktopApplication>(() =>
        pendingAttempt(),
      );

      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(healthyResponse())
        .mockResolvedValueOnce(Response.json({ ok: true }));

      await expect(
        runReviewAppLaunch(
          { focus },
          {
            selectInstance: selectingDesktop(async () => discovery, fetch),
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
      expect(
        fetch.mock.calls.map(([url, init]) => [
          String(url),
          init?.method ?? "GET",
          new Headers(init?.headers).get("x-review-token"),
        ]),
      ).toEqual(requests);
      expect(launchDesktop).not.toHaveBeenCalled();
    },
  );

  it("launches when discovery is missing", async () => {
    let readCount = 0;

    const launchDesktop = vi.fn<typeof launchDesktopApplication>(() =>
      pendingAttempt(),
    );

    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        launcherRuntime([healthyResponse()], launchDesktop, async () =>
          readCount++ === 0 ? null : discovery,
        ),
      ),
    ).resolves.toMatchObject({ state: "launched" });
    expect(launchDesktop).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { key: "preview", source: "env" },
      { key: "preview", appPath: undefined },
    ],
    [{ key: "stable", source: "fallback" }, undefined],
  ] as const)(
    "launches the selected release instance: %j",
    async (selection, instance) => {
      let readCount = 0;

      const launchDesktop = vi.fn<typeof launchDesktopApplication>(() =>
        pendingAttempt(),
      );

      await runReviewAppLaunch(
        { timeoutMs: 1_000 },
        launcherRuntime(
          [healthyResponse()],
          launchDesktop,
          async () => (readCount++ === 0 ? null : discovery),
          selection,
        ),
      );
      expect(launchDesktop).toHaveBeenCalledWith(
        instance ? { focus: undefined, instance } : { focus: undefined },
      );
    },
  );

  it("never auto-launches a dev checkout", async () => {
    const launchDesktop = vi.fn<typeof launchDesktopApplication>();
    await expect(
      runReviewAppLaunch(
        {},
        launcherRuntime([], launchDesktop, async () => null, {
          key: "dev-review-0123456789ab",
          source: "default",
        }),
      ),
    ).rejects.toThrow("Start it with `pnpm dev` in its checkout");
    expect(launchDesktop).not.toHaveBeenCalled();
  });

  it("ignores unreadable discovery and launches Desktop", async () => {
    let readCount = 0;
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        launcherRuntime(
          [healthyResponse()],
          vi.fn<typeof launchDesktopApplication>(() => pendingAttempt()),
          async () => {
            if (readCount++ === 0) throw new Error("unreadable discovery");

            return discovery;
          },
        ),
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
          selectInstance: selectingDesktop(
            async () => (readCount++ === 0 ? discovery : fresh),
            fetch,
          ),
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
          selectInstance: selectingDesktop(async () => discovery, fetch),
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
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          selectInstance: selectingDesktop(async () => null, fetch),
          fetch,
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

    const fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return Response.json({ ok: false });
    };

    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          selectInstance: selectingDesktop(
            async () => (readCount++ === 0 ? null : discovery),
            fetch,
          ),
          fetch,
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
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runReviewAppLaunch(
        { timeoutMs: 1_000 },
        {
          selectInstance: selectingDesktop(async () => null, fetch),
          fetch,
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
        env: { KEEP: "yes", DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1" },
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
          DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1",
        },
      }),
    );
  });

  it.each([
    [
      undefined,
      [
        "-g",
        "-b",
        "dev.fast.review",
        "--env",
        "DEV_FAST_REVIEW_DESKTOP_BACKGROUND=1",
      ],
    ],
    [true, ["-b", "dev.fast.review"]],
  ])(
    "opens the bundle for a standalone CLI, in the foreground only with focus=%s",
    (focus, args) => {
      const child = new FakeChild();

      const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
        () => child,
      );

      launchDesktopApplication({
        platform: "darwin",
        electron: false,
        focus,
        spawn,
      });
      expect(spawn).toHaveBeenCalledWith(
        "/usr/bin/open",
        args,
        expect.objectContaining({ detached: true }),
      );
    },
  );

  it.each([
    [false, "/usr/bin/review-desktop"],
    [true, "/usr/share/review/review"],
  ])(
    "launches Linux with bundled Electron=%s and preserves the isolated profile",
    (electron, executable) => {
      const child = new FakeChild();

      const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
        () => child,
      );

      const environment = {
        ELECTRON_RUN_AS_NODE: "1",
        DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: "/tmp/linux-profile",
        VSCODE_DEV: "1",
        VSCODE_CLI: "1",
      };

      const attempt = launchDesktopApplication({
        platform: "linux",
        electron,
        execPath: "/usr/share/review/review",
        env: environment,
        spawn,
      });

      expect(spawn).toHaveBeenCalledWith(
        executable,
        [
          "--user-data-dir=/tmp/linux-profile/user-data",
          "--extensions-dir=/tmp/linux-profile/extensions",
        ],
        expect.objectContaining({
          env: {
            DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: "/tmp/linux-profile",
            DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1",
          },
          detached: true,
        }),
      );
      expect(attempt.successfulExitIsExpected).toBe(false);
      expect(environment.ELECTRON_RUN_AS_NODE).toBe("1");
    },
  );

  it("launches the channel's own Linux launcher when the CLI wrapper names it", () => {
    const child = new FakeChild();

    const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
      () => child,
    );

    const attempt = launchDesktopApplication({
      platform: "linux",
      electron: false,
      env: {
        DEV_FAST_REVIEW_DESKTOP_COMMAND: "/usr/bin/review-preview-desktop",
      },
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/review-preview-desktop",
      [],
      expect.objectContaining({ detached: true }),
    );
    expect(attempt.method).toContain("/usr/bin/review-preview-desktop");
  });

  it.each([
    [
      "darwin",
      { key: "preview" },
      "/usr/bin/open",
      ["-g", "-b", "dev.fast.review.preview"],
    ],
    [
      "darwin",
      { key: "preview", appPath: "/Users/me/Apps/Review Preview.app" },
      "/usr/bin/open",
      ["-g", "-a", "/Users/me/Apps/Review Preview.app"],
    ],
    ["linux", { key: "preview" }, "/usr/bin/review-preview-desktop", []],
  ] as const)(
    "opens the selected channel on %s: %j",
    (platform, instance, command, args) => {
      const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
        () => new FakeChild(),
      );

      launchDesktopApplication({
        platform,
        electron: false,
        instance,
        env: {
          DEV_FAST_REVIEW_DESKTOP_COMMAND: "/usr/bin/review-desktop",
          DEV_FAST_REVIEW_CHECKOUT: "/src/review",
        },
        spawn,
      });

      const [spawned, spawnedArgs, options] = spawn.mock.calls[0]!;
      expect(spawned).toBe(command);
      expect(spawnedArgs.slice(0, args.length)).toEqual(args);
      expect(options.env?.DEV_FAST_REVIEW_CHECKOUT).toBeUndefined();
    },
  );

  it("does not mark a focused direct launch as background", () => {
    const child = new FakeChild();

    const spawn = vi.fn<NonNullable<LaunchDesktopApplicationInput["spawn"]>>(
      () => child,
    );

    launchDesktopApplication({
      platform: "linux",
      electron: false,
      focus: true,
      env: { DEV_FAST_REVIEW_DESKTOP_BACKGROUND: "1" },
      spawn,
    });
    const options = spawn.mock.calls[0]?.[2];
    expect(options?.env).not.toHaveProperty(
      "DEV_FAST_REVIEW_DESKTOP_BACKGROUND",
    );
  });

  it("reports a missing Linux package launcher", async () => {
    const child = new FakeChild();

    const attempt = launchDesktopApplication({
      platform: "linux",
      electron: false,
      spawn: () => child,
    });

    child.emit("error", new Error("spawn /usr/bin/review-desktop ENOENT"));
    await expect(attempt.completion).rejects.toThrow("ENOENT");
  });
});

function launcherRuntime(
  responses: Response[],
  launchDesktop: typeof launchDesktopApplication,
  read: () => Promise<ReviewDesktopDiscovery | null> = async () => discovery,
  selection?: Pick<ReviewInstanceSelection, "key" | "source">,
) {
  const fetch = vi.fn<typeof globalThis.fetch>();

  for (const response of responses) fetch.mockResolvedValueOnce(response);

  return {
    selectInstance: selectingDesktop(read, fetch, selection),
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
