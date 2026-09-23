import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  isHealthyReviewDesktop,
  reviewInstanceUnavailable,
  selectReviewInstance,
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

describe("Review Desktop health", () => {
  it("accepts only the matching instance with an attached Desktop client", async () => {
    await expect(
      isHealthyReviewDesktop(
        discovery,
        vi.fn<() => Promise<Response>>(async () =>
          Response.json({
            ok: true,
            instanceId: discovery.instanceId,
            desktopAttached: true,
          }),
        ),
      ),
    ).resolves.toBe(true);
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
    await expect(isHealthyReviewDesktop(discovery, fetch)).resolves.toBe(false);
  });
});

describe("Review instance selection", () => {
  async function home(
    records: Record<string, boolean | "broken">,
    extra: {
      defaultInstance?: string;
      legacy?: boolean;
      malformed?: boolean;
    } = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "review-instances-"));
    const desktop = path.join(root, "review-desktop");
    await mkdir(path.join(desktop, "instances"), { recursive: true });
    const healthy = new Map<string, string>();
    let port = 6000;

    for (const [key, isHealthy] of Object.entries(records)) {
      if (isHealthy === "broken") {
        await writeFile(path.join(desktop, "instances", `${key}.json`), "{");
        continue;
      }

      const record = {
        ...discovery,
        key,
        instanceId: key,
        url: `http://127.0.0.1:${++port}`,
      };

      if (isHealthy) healthy.set(record.url, key);
      await writeFile(
        path.join(desktop, "instances", `${key}.json`),
        JSON.stringify(record),
      );
    }

    if (extra.legacy) {
      const url = `http://127.0.0.1:${++port}`;
      healthy.set(url, "legacy");
      await writeFile(
        path.join(desktop, "server.json"),
        JSON.stringify({ ...discovery, instanceId: "legacy", url }),
      );
    }

    if (extra.malformed)
      await writeFile(path.join(desktop, "instances", "broken.json"), "{");

    if (extra.defaultInstance)
      await writeFile(
        path.join(desktop, "default-instance"),
        `${extra.defaultInstance}\n`,
      );

    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const instanceId = healthy.get(new URL(String(url)).origin);

      return instanceId
        ? Response.json({ ok: true, instanceId, desktopAttached: true })
        : Promise.reject(new Error("refused"));
    });

    return (env: NodeJS.ProcessEnv = {}) =>
      selectReviewInstance({
        env: { DEV_REVIEW_HOME: root, ...env },
        fetch,
      });
  }

  it("prefers the env override, then the machine default, then the only running Desktop, then stable", async () => {
    const both = await home(
      { stable: true, preview: true },
      { defaultInstance: "preview" },
    );

    expect(await both({ DEV_REVIEW_INSTANCE: "stable" })).toMatchObject({
      key: "stable",
      source: "env",
    });
    expect(await both()).toMatchObject({ key: "preview", source: "default" });

    const previewOnly = await home({ stable: false, preview: true });
    expect(await previewOnly()).toMatchObject({
      key: "preview",
      source: "only-running",
    });

    const none = await home({});
    const nothing = await none();
    expect(nothing).toMatchObject({ key: "stable", source: "fallback" });
    expect(nothing.instance).toBeUndefined();
    expect(nothing.problem).toBeUndefined();
  });

  it("errors instead of redirecting when the selected instance is not running", async () => {
    const select = await home(
      { stable: true, preview: false },
      { malformed: true },
    );

    const selection = await select({ DEV_REVIEW_INSTANCE: "preview" });
    expect(selection.instances.map((instance) => instance.key).sort()).toEqual([
      "preview",
      "stable",
    ]);
    expect(reviewInstanceUnavailable(selection).message).toBe(
      "Whiteboard `preview` is not running. Start it with `whiteboard app launch`, or pick another instance with `whiteboard instances`. Running: stable.",
    );
  });

  it("asks the user to choose when several run and none is selected", async () => {
    const select = await home({
      preview: true,
      "dev-review-0123456789ab": true,
    });

    expect(reviewInstanceUnavailable(await select()).message).toMatch(
      /Several Whiteboard instances are running and none is selected\. Running: .*`whiteboard instances use <key>`/,
    );
  });

  it("rejects a key that is not an instance name and says where it came from", async () => {
    const select = await home({});
    await expect(select({ DEV_REVIEW_INSTANCE: "../server" })).rejects.toThrow(
      'Unknown Whiteboard instance "../server" from DEV_REVIEW_INSTANCE',
    );

    const stored = await home({}, { defaultInstance: "../server" });
    await expect(stored()).rejects.toThrow(
      /as the machine default \(`whiteboard instances clear` removes it\)/,
    );
  });

  it("reports the selected key's broken record instead of skipping it", async () => {
    const select = await home({ stable: "broken", preview: true });
    const selection = await select({ DEV_REVIEW_INSTANCE: "stable" });
    expect(selection.instance).toBeUndefined();
    expect(selection.problem?.message).toMatch(
      /discovery is unreadable at .*stable\.json/,
    );
    expect(reviewInstanceUnavailable(selection)).toBe(selection.problem);

    // A broken record that is not selected is only skipped.
    const other = await select({ DEV_REVIEW_INSTANCE: "preview" });
    expect(other.problem).toBeUndefined();
    expect(other.instance?.healthy).toBe(true);
  });

  it("reads a pre-instance Desktop's server.json as stable", async () => {
    const select = await home({}, { legacy: true });
    const selection = await select();
    expect(selection.key).toBe("stable");
    expect(selection.instance?.discovery.instanceId).toBe("legacy");
  });
});
