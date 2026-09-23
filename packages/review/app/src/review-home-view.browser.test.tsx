import type {
  ReviewApiSummary,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReviewHome,
  formatRelativeTime,
  groupReviewsByTime,
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

  it("uses rolling day/week boundaries and sorts newest first", () => {
    const now = Date.parse("2026-09-22T12:00:00Z");

    const reviews = [
      summary({ title: "Older", createdAt: "2026-09-15T12:00:00Z" }),
      summary({ title: "Day boundary", createdAt: "2026-09-21T12:00:00Z" }),
      summary({ title: "Recent", createdAt: "2026-09-22T11:00:00Z" }),
      summary({ title: "Newest", createdAt: "2026-09-22T11:59:00Z" }),
      summary({ title: "Week", createdAt: "2026-09-15T12:00:01Z" }),
    ];

    expect(groupReviewsByTime(reviews, now)).toMatchObject([
      {
        label: "Last day",
        reviews: [{ title: "Newest" }, { title: "Recent" }],
      },
      {
        label: "Last week",
        reviews: [{ title: "Day boundary" }, { title: "Week" }],
      },
      { label: "Older", reviews: [{ title: "Older" }] },
    ]);
  });

  it("groups chronologically across repositories and shows origins", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-22T12:00:00Z"));

    const reviews = [
      summary({
        reviewId: uuid(1),
        title: "Week",
        createdAt: "2026-09-20T12:00:00Z",
      }),
      summary({
        reviewId: uuid(2),
        title: "Recent local",
        createdAt: "2026-09-22T10:00:00Z",
        repositoryPath: "/worktrees/feature-a",
      }),
      summary({
        reviewId: uuid(3),
        title: "Old",
        createdAt: "2026-09-01T12:00:00Z",
      }),
      summary({
        reviewId: uuid(4),
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
      [
        ...container.querySelectorAll(
          ".review-home-workspace-header--group strong",
        ),
      ].map((el) => el.textContent),
    ).toEqual(["Last day · 2", "Last week · 1", "Older · 1"]);
    expect(
      [...container.querySelectorAll(".review-home-review-title")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Newest shared", "Recent local", "Week", "Old"]);
    expect(container.textContent).toContain("team/other");
    expect(container.textContent).toContain("Shared");
    expect(
      container.querySelector('[title^="/worktrees/feature-a"]'),
    ).not.toBeNull();
  });

  it("puts the scratchpad first, above the reviews and out of their workspaces", async () => {
    const {
      pins: _pins,
      repositoryPath: _path,
      ...base
    } = summary({
      reviewId: "scratchpad",
      title: "Scratchpad",
      repositoryName: "",
    });

    const pad: ReviewApiSummary = {
      ...base,
      kind: "scratchpad",
      contents: { blocks: 6, diagrams: 2 },
    };

    const review = summary({ reviewId: uuid(1), title: "A review" });
    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();
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
    expect(container.querySelectorAll(".review-home-workspace")).toHaveLength(
      1,
    );
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

  it("groups cards from different repositories under one time header", async () => {
    const reviews = [
      summary({ reviewId: uuid(1), title: "First dev review" }),
      summary({ reviewId: uuid(2), title: "Second dev review" }),
      summary({
        reviewId: uuid(3),
        title: "Other workspace review",
        repositoryPath: "/repo/other",
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    expect(container.querySelectorAll(".review-home-workspace")).toHaveLength(
      1,
    );
    expect(container.querySelectorAll(".review-home-card")).toHaveLength(3);
    expect(container.querySelector('[title^="/repo/dev"]')).not.toBeNull();
    expect(container.querySelector('[title^="/repo/other"]')).not.toBeNull();
  });

  it("deletes a review after an arming click without opening it", async () => {
    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();

    const onDelete = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => undefined,
    );

    const reviews = [
      summary({
        reviewId: uuid(1),
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

  it("keeps attention actions on native summaries", async () => {
    const review = summary({
      title: "Native review",
      version: 0,
      origin: { pullRequestNumber: 320 },
    });

    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();

    const onDismiss = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => {},
    );

    const onRestore = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => {},
    );

    const render = async (item: ReviewApiSummary) =>
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
    expect(container.textContent).toContain("PR #320");
    expect(container.querySelector(".review-home-status")?.textContent).toBe(
      "New",
    );
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
    expect(container.querySelector(".review-home-status")?.textContent).toBe(
      "Review ready",
    );
  });

  it("hides the delete action when the host does not support deletion", async () => {
    await act(async () =>
      root.render(<ReviewHome reviews={[summary()]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-delete")).toBeNull();
  });

  it("shows the native snapshot update time on cards", async () => {
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
      "Review is not set up for your coding agents yet.",
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

function summary(overrides: Partial<ReviewApiSummary> = {}): ReviewApiSummary {
  return {
    reviewId: uuid(9),
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
