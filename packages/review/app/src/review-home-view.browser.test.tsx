import type {
  ReviewCliInstallStatus,
  SessionSummary,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReviewHome,
  formatRelativeTime,
  setupBannerMessage,
} from "./review-home-view";

describe("ReviewHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
  });

  it("groups chronologically across repositories and shows origins", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-22T12:00:00Z"));

    const reviews = [
      summary({
        sessionId: uuid(1),
        title: "Week",
        createdAt: "2026-09-20T12:00:00Z",
      }),
      summary({
        sessionId: uuid(2),
        title: "Recent local",
        createdAt: "2026-09-22T10:00:00Z",
        repositoryPath: "/worktrees/feature-a",
      }),
      summary({
        sessionId: uuid(3),
        title: "Old",
        createdAt: "2026-09-01T12:00:00Z",
      }),
      summary({
        sessionId: uuid(4),
        title: "Newest shared",
        createdAt: "2026-09-22T11:00:00Z",
        repositoryPath: undefined,
        shared: { cloneUrl: "https://github.com/team/other.git" },
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );
    expect(
      [...container.querySelectorAll(".review-home-review-title")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Newest shared", "Recent local", "Week", "Old"]);
    expect(container.textContent).toContain("team/other");
    expect(
      container.querySelector('[title^="/worktrees/feature-a"]'),
    ).not.toBeNull();
  });

  it("filters repositories and changes sort order without losing review actions", async () => {
    const reviews = [
      summary({
        sessionId: uuid(1),
        title: "Zulu",
        repositoryName: "alpha",
        firstCreatedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
        origin: { pullRequestNumber: 10 },
      }),
      summary({
        sessionId: uuid(2),
        title: "Alpha",
        repositoryName: "beta",
        firstCreatedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
        origin: { pullRequestNumber: 20 },
      }),
    ];

    const onOpen = vi.fn<(review: SessionSummary) => void>();

    const onDismiss = vi.fn<(review: SessionSummary) => Promise<void>>(
      async () => undefined,
    );

    await act(async () =>
      root.render(
        <ReviewHome reviews={reviews} onOpen={onOpen} onDismiss={onDismiss} />,
      ),
    );

    const titles = () =>
      [
        ...container.querySelectorAll(
          ".review-home-table-open .review-home-review-title",
        ),
      ].map((element) => element.textContent);

    const select = async (label: string, value: string) => {
      const names = new Map([
        ["updated", "Recently updated"],
        ["oldest", "Oldest first"],
        ["pr", "PR number"],
        ["title", "Title A–Z"],
      ]);

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
          .click(),
      );

      const option = [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      ].find((element) => element.textContent === (names.get(value) ?? value));

      await act(async () => option!.click());
    };

    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("Sort reviews", "updated");
    expect(titles()).toEqual(["Zulu", "Alpha"]);
    await select("Sort reviews", "oldest");
    expect(titles()).toEqual(["Zulu", "Alpha"]);
    await select("Sort reviews", "pr");
    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("Sort reviews", "title");
    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("Filter by repository", "alpha");
    expect(titles()).toEqual(["Zulu"]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss Zulu"]')!
        .click(),
    );
    expect(onDismiss).toHaveBeenCalledWith(reviews[0]);
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-table-open")!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledWith(reviews[0]);
  });

  it("puts the scratchpad first, above the reviews and out of their workspaces", async () => {
    const {
      pins: _pins,
      repositoryPath: _path,
      ...base
    } = summary({
      sessionId: "scratchpad",
      title: "Scratchpad",
      repositoryName: "",
    });

    const pad: SessionSummary = {
      ...base,
      kind: "scratchpad",
      contents: { blocks: 6, diagrams: 2 },
    };

    const review = summary({ sessionId: uuid(1), title: "A review" });
    const onOpen = vi.fn<(review: SessionSummary) => void>();
    await act(async () =>
      root.render(<ReviewHome reviews={[review, pad]} onOpen={onOpen} />),
    );

    const labels = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );

    const padIndex = labels.findIndex((text) => text.includes("Scratchpad"));
    expect(padIndex).toBeGreaterThanOrEqual(0);
    expect(padIndex).toBeLessThan(
      labels.findIndex((text) => text.includes("A review")),
    );
    expect(container.querySelectorAll(".review-home-table")).toHaveLength(1);
    expect(container.textContent).not.toContain("Dismiss Scratchpad");
    expect(container.textContent).toContain("6 blocks");
    expect(container.textContent).toContain("2 diagrams");

    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Scratchpad"),
    )!;

    await act(async () => button.click());
    expect(onOpen).toHaveBeenCalledWith(pad);
  });

  it("opens API reviews grouped by repository without needing a checkout path", async () => {
    const { repositoryPath: _, ...review } = summary({ title: "API review" });
    const item = { ...review, repositoryName: "Review repository" };
    const onOpen = vi.fn<(review: typeof item) => void>();
    await act(async () =>
      root.render(<ReviewHome reviews={[item]} onOpen={onOpen} />),
    );
    expect(container.textContent).toContain("Review repository");

    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("API review"),
    );

    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it("shows reviews from different repositories in one table", async () => {
    const reviews = [
      summary({ sessionId: uuid(1), title: "First dev review" }),
      summary({ sessionId: uuid(2), title: "Second dev review" }),
      summary({
        sessionId: uuid(3),
        title: "Other workspace review",
        repositoryPath: "/repo/other",
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    expect(container.querySelectorAll(".review-home-table")).toHaveLength(1);
    expect(
      container.querySelectorAll(".review-home-table tbody tr"),
    ).toHaveLength(3);
    expect(container.querySelector('[title^="/repo/dev"]')).not.toBeNull();
    expect(container.querySelector('[title^="/repo/other"]')).not.toBeNull();
  });

  it("opens the row menu without opening the review and requires confirmation to delete", async () => {
    const review = summary({ title: "Menu review" });
    const onOpen = vi.fn<(review: SessionSummary) => void>();

    const onDelete = vi.fn<(review: SessionSummary) => Promise<void>>(
      async () => undefined,
    );

    await act(async () =>
      root.render(
        <ReviewHome reviews={[review]} onOpen={onOpen} onDelete={onDelete} />,
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Actions for Menu review"]',
        )!
        .click(),
    );
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();

    const remove =
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    await act(async () => remove.click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(remove.textContent).toContain("Confirm delete");
    await act(async () => remove.click());
    expect(onDelete).toHaveBeenCalledWith(review);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("deletes a review after an arming click without opening it", async () => {
    const onOpen = vi.fn<(review: SessionSummary) => void>();

    const onDelete = vi.fn<(review: SessionSummary) => Promise<void>>(
      async () => undefined,
    );

    const reviews = [
      summary({
        sessionId: uuid(1),
        title: "Removable",
        dismissedAt: "2026-08-13T20:00:00.000Z",
      }),
    ];

    await act(async () =>
      root.render(
        <ReviewHome reviews={reviews} onOpen={onOpen} onDelete={onDelete} />,
      ),
    );

    const dismissed = container.querySelector<HTMLButtonElement>(
      ".review-home-dismissed-toggle",
    );

    await act(async () => dismissed?.click());

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Removable"]',
    );

    expect(remove).not.toBeNull();
    await act(async () => remove?.click());
    expect(onDelete).not.toHaveBeenCalled();

    const confirm = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Confirm delete Removable"]',
    );

    await act(async () => confirm?.click());
    expect(onDelete).toHaveBeenCalledWith(reviews[0]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "optimistically deletes and restores failed deletions (dismissed: %s)",
    async (isDismissed) => {
      const review = summary({
        title: "Pending review",
        dismissedAt: isDismissed ? "2026-08-13T20:00:00.000Z" : null,
      });

      const deletion = Promise.withResolvers<void>();

      const onDelete = vi.fn<(review: SessionSummary) => Promise<void>>(
        () => deletion.promise,
      );

      await act(async () =>
        root.render(
          <ReviewHome
            reviews={[review]}
            onOpen={() => {}}
            onDelete={onDelete}
          />,
        ),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            isDismissed
              ? ".review-home-dismissed-toggle"
              : '[aria-label="Actions for Pending review"]',
          )!
          .click(),
      );

      const remove = container.querySelector<HTMLButtonElement>(
        '[aria-label="Delete Pending review"]',
      )!;

      await act(async () => remove.click());
      expect(container.textContent).toContain("Pending review");
      await act(async () => remove.click());
      expect(onDelete).toHaveBeenCalledWith(review);
      expect(container.textContent).not.toContain("Pending review");
      expect(container.querySelector('[role="menu"]')).toBeNull();

      await act(async () => deletion.reject(new Error("Offline")));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not delete",
      );
      expect(
        container.querySelector(
          isDismissed
            ? '[aria-label="Delete Pending review"]'
            : '[aria-label="Actions for Pending review"]',
        ),
      ).not.toBeNull();
    },
  );

  it("keeps a successful deletion hidden until the catalog catches up, and allows reimport", async () => {
    const review = summary({ title: "Pending review" });
    const deletion = Promise.withResolvers<void>();

    const onDelete = vi.fn<(review: SessionSummary) => Promise<void>>(
      () => deletion.promise,
    );

    const render = async (reviews: SessionSummary[]) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={reviews}
            onOpen={() => {}}
            onDelete={onDelete}
          />,
        ),
      );

    await render([review]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Actions for Pending review"]',
        )!
        .click(),
    );

    const remove =
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    await act(async () => remove.click());
    await act(async () => remove.click());
    expect(container.textContent).not.toContain("Pending review");
    await act(async () => deletion.resolve());
    await render([review]);
    expect(container.textContent).not.toContain("Pending review");
    await render([]);
    await render([review]);
    expect(container.textContent).toContain("Pending review");
  });

  it("keeps attention actions on native summaries", async () => {
    const review = summary({
      title: "Native review",
      version: 0,
      origin: { pullRequestNumber: 320 },
    });

    const onOpen = vi.fn<(review: SessionSummary) => void>();

    const onDismiss = vi.fn<(review: SessionSummary) => Promise<void>>(
      async () => {},
    );

    const onRestore = vi.fn<(review: SessionSummary) => Promise<void>>(
      async () => {},
    );

    const render = async (item: SessionSummary) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={[item]}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />,
        ),
      );

    await render(review);
    expect(container.textContent).toContain("#320");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Dismiss Native review"]',
        )!
        .click(),
    );
    expect(onDismiss).toHaveBeenCalledWith(review);
    expect(onOpen).not.toHaveBeenCalled();

    const dismissed = {
      ...review,
      viewedAt: "2026-09-01T00:00:00Z",
      dismissedAt: "2026-09-02T00:00:00Z",
    };

    await render(dismissed);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-dismissed-toggle")!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-restore")!
        .click(),
    );
    expect(onRestore).toHaveBeenCalledWith(dismissed);
    await render({ ...dismissed, dismissedAt: null });
    expect(
      container.querySelector(".review-home-table-open")?.textContent,
    ).toContain("Native review");
  });

  it("hides the delete action when the host does not support deletion", async () => {
    await act(async () =>
      root.render(<ReviewHome reviews={[summary()]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-delete")).toBeNull();
  });

  it("shows the native snapshot update time in the table", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-29T12:00:00.000Z"),
    );

    const review = summary({
      createdAt: "2026-07-29T11:54:00.000Z",
    });

    await act(async () =>
      root.render(<ReviewHome reviews={[review]} onOpen={() => {}} />),
    );
    expect(container.textContent).toContain("6 min ago");
    expect(container.textContent).not.toContain("updated not published");
  });
});

describe("setupBannerMessage", () => {
  it("keeps the first-run banner after setup is skipped", () => {
    const status: ReviewCliInstallStatus = {
      agents: [{ target: "codex", present: true, installed: false }],
      fingerprint: "fingerprint",
      stamp: {
        consent: "skipped",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      stale: false,
      shim: {
        path: "/tmp/review",
        installed: false,
        profileConfigured: false,
        onPath: false,
      },
      fff: {
        serverName: "fff",
        corpusRoot: "/tmp/trace-search",
        binary: { path: "/tmp/fff-mcp", installed: false },
        registrations: [{ target: "codex", present: false, managed: false }],
      },
      trace: {
        enabled: false,
        configured: false,
        autoActivateRepositories: false,
        envPath: "/tmp/trace-env",
        settingsPath: "/tmp/trace-settings.json",
      },
      cli: { path: "/tmp/cli.js", version: "0.0.1" },
    };

    expect(setupBannerMessage(status)).toBe(
      "Whiteboard is not set up for your coding agents yet.",
    );
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");

  it("uses compact home-page relative labels", () => {
    expect(formatRelativeTime("2026-07-29T11:54:00.000Z", now)).toBe(
      "6 min ago",
    );
    expect(formatRelativeTime("2026-07-28T12:00:00.000Z", now)).toBe(
      "1 day ago",
    );
    expect(formatRelativeTime(null, now)).toBe("unknown");
  });
});

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: uuid(9),
    version: 0,
    title: "Progressive Review",
    repositoryPath: "/repo/dev",
    repositoryName: (overrides.repositoryPath ?? "/repo/dev")
      .split("/")
      .at(-1)!,
    pins: {
      repositoryId: overrides.repositoryPath ?? "/repo/dev",
      base: "base",
      head: "head",
    },
    origin: { branch: "feature/home" },
    diffStats: null,
    createdAt: "2026-07-29T11:54:00.000Z",
    viewedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function uuid(suffix: number): string {
  return `11111111-1111-4111-8111-${String(suffix).padStart(12, "0")}`;
}
