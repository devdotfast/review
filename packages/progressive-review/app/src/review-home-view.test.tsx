// @vitest-environment jsdom

import type {
  ReviewCliInstallStatus,
  ReviewDescriptor,
  ReviewListError,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REVIEW_HOME_VIEW_STORAGE_KEY,
  ReviewHome,
  formatRelativeTime,
  groupReviewsByWorktree,
  setupBannerMessage,
} from "./review-home-view";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("shows each non-repair scan error without offering repair commands", async () => {
    const errors: ReviewListError[] = [
      {
        reviewDir: "/reviews/unsupported",
        reviewUuid: uuid(2),
        title: "Unsupported review",
        worktreePath: "/repo",
        lastPublishedAt: null,
        code: "MIGRATION_REQUIRED",
        message: "Unsupported review schema.",
      },
      {
        reviewDir: "/reviews/unreadable",
        reviewUuid: null,
        title: "",
        worktreePath: "/repo",
        lastPublishedAt: null,
        code: "EACCES",
        message: "Cannot read review.json.",
      },
    ];
    await act(async () =>
      root.render(
        <ReviewHome reviews={[]} onOpen={() => {}} reviewErrors={errors} />,
      ),
    );
    const attention = [...container.querySelectorAll(".review-home-attention")];
    expect(attention).toHaveLength(2);
    expect(attention.map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "Attention for Unsupported review",
      "Attention for /reviews/unreadable",
    ]);
    expect(attention[0]?.textContent).toContain(errors[0]!.message);
    expect(attention[1]?.textContent).toContain(errors[1]!.message);
    expect(container.querySelector(".review-home-attention code")).toBeNull();
    expect(
      container.querySelector('button[aria-label="Copy command"]'),
    ).toBeNull();
    expect(container.querySelector(".review-migration-warning")).toBeNull();
  });

  it("groups reviews by worktree without changing their order", () => {
    const reviews = [
      descriptor({ uuid: uuid(1), worktreePath: "/repo/dev", title: "First" }),
      descriptor({
        uuid: uuid(2),
        worktreePath: "/repo/other",
        title: "Second",
      }),
      descriptor({ uuid: uuid(3), worktreePath: "/repo/dev", title: "Third" }),
    ];

    expect(groupReviewsByWorktree(reviews)).toMatchObject([
      { label: "dev", reviews: [{ title: "First" }, { title: "Third" }] },
      { label: "other", reviews: [{ title: "Second" }] },
    ]);
  });

  it("does not show a pinned commit as a workspace branch", () => {
    const [workspace] = groupReviewsByWorktree([
      descriptor({
        sourceBranch: "19398e1af4117b1e131a74edb4d198678a310409",
      }),
    ]);

    expect(workspace?.branch).toBeNull();
  });

  it("toggles between the Paper card and list views and remembers the choice", async () => {
    const onOpen = vi.fn<(review: ReviewDescriptor) => void>();
    const reviews = [
      descriptor({
        uuid: uuid(1),
        title: "Store review threads in SQLite",
        pullRequestNumber: 636,
        diffStats: { fileCount: 18, additions: 804, deletions: 356 },
        commentCount: 6,
        presentedDocumentRevision: "presented",
        presentedSoftwareMapRevision: null,
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={onOpen} />),
    );
    expect(container.querySelector(".review-home-topbar")).toBeNull();
    expect(container.querySelector(".review-home-card")).not.toBeNull();
    // An unopened review reads as New: the attention state outranks the
    // handoff status on the pill.
    expect(container.textContent).toContain("New");
    expect(container.textContent).toContain("PR #636");
    expect(container.textContent).toContain("+804");
    expect(container.textContent).not.toContain("review scaffold");
    expect(container.querySelector(".review-home-status svg")).not.toBeNull();
    expect(container.querySelector(".review-home-status i")).toBeNull();

    const listToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="List view"]',
    );
    await act(async () => listToggle?.click());
    expect(container.querySelector(".review-home-list-table")?.tagName).toBe(
      "TABLE",
    );
    expect(container.querySelector(".review-home-card")).toBeNull();
    expect(localStorage.getItem(REVIEW_HOME_VIEW_STORAGE_KEY)).toBe("list");

    const row = container.querySelector<HTMLButtonElement>(
      ".review-home-list-row",
    );
    await act(async () => row?.click());
    expect(onOpen).toHaveBeenCalledWith(reviews[0]);
  });

  it("groups cards under workspace headers", async () => {
    const reviews = [
      descriptor({ uuid: uuid(1), title: "First dev review" }),
      descriptor({ uuid: uuid(2), title: "Second dev review" }),
      descriptor({
        uuid: uuid(3),
        title: "Other workspace review",
        worktreePath: "/repo/other",
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    expect(container.querySelectorAll(".review-home-workspace")).toHaveLength(
      2,
    );
    expect(container.querySelectorAll(".review-home-card")).toHaveLength(3);
    expect(container.textContent).toContain("/repo/dev");
    expect(container.textContent).toContain("/repo/other");
  });

  it("groups rows by workspace and sorts them through column headers", async () => {
    localStorage.setItem(REVIEW_HOME_VIEW_STORAGE_KEY, "list");
    const reviews = [
      descriptor({
        uuid: uuid(1),
        title: "Later PR",
        pullRequestNumber: 900,
      }),
      descriptor({
        uuid: uuid(2),
        title: "Early PR",
        pullRequestNumber: 100,
      }),
      descriptor({
        uuid: uuid(3),
        title: "Other workspace",
        worktreePath: "/repo/other",
        pullRequestNumber: 500,
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    expect(
      container.querySelectorAll("tbody .review-home-list-workspace-row"),
    ).toHaveLength(2);

    const visibleTitles = () =>
      [...container.querySelectorAll(".review-home-list-row")].map(
        (row) =>
          row.querySelector(".review-home-review-title")?.textContent ?? "",
      );
    expect(visibleTitles()).toEqual([
      "Later PR",
      "Early PR",
      "Other workspace",
    ]);

    const prSort = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sort by PR"]',
    );
    await act(async () => prSort?.click());

    expect(visibleTitles()).toEqual([
      "Early PR",
      "Later PR",
      "Other workspace",
    ]);
    expect(prSort?.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("keeps list workspace groups expanded", async () => {
    localStorage.setItem(REVIEW_HOME_VIEW_STORAGE_KEY, "list");
    const devWorktreePath = "/Users/ketanagrawal/monorepo/repos/dev";
    const reviews = [
      descriptor({
        uuid: uuid(1),
        title: "First dev review",
        worktreePath: devWorktreePath,
      }),
      descriptor({
        uuid: uuid(2),
        title: "Second dev review",
        worktreePath: devWorktreePath,
      }),
      descriptor({
        uuid: uuid(3),
        title: "Other workspace review",
        worktreePath: "/repo/other",
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    const visibleTitles = () =>
      [...container.querySelectorAll(".review-home-list-row")].map(
        (row) =>
          row.querySelector(".review-home-review-title")?.textContent ?? "",
      );
    const workspaceRows = container.querySelectorAll(
      ".review-home-list-workspace-row",
    );
    expect(workspaceRows).toHaveLength(2);
    expect(workspaceRows[0]?.textContent).toContain(devWorktreePath);
    expect(workspaceRows[0]?.textContent).not.toContain("…/");
    expect(
      container.querySelectorAll(".review-home-list-columns"),
    ).toHaveLength(2);
    expect(
      workspaceRows[0]?.nextElementSibling?.classList.contains(
        "review-home-list-columns",
      ),
    ).toBe(true);
    expect(visibleTitles()).toEqual([
      "First dev review",
      "Second dev review",
      "Other workspace review",
    ]);
    expect(
      container.querySelectorAll(".review-home-list-columns"),
    ).toHaveLength(2);
  });

  it("deletes a review after an arming click without opening it", async () => {
    const onOpen = vi.fn<(review: ReviewDescriptor) => void>();
    const onDelete = vi.fn<(review: ReviewDescriptor) => Promise<void>>(
      async () => undefined,
    );
    const reviews = [
      descriptor({
        uuid: uuid(1),
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

  it("hides the delete action when the host does not support deletion", async () => {
    await act(async () =>
      root.render(<ReviewHome reviews={[descriptor()]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-delete")).toBeNull();
  });

  it("shows and copies the repair command for failed artifact conversion", async () => {
    const error: ReviewListError = {
      reviewDir: `/tmp/reviews/${uuid(2)}`,
      reviewUuid: uuid(2),
      title: "Old review",
      worktreePath: "/repo/old",
      lastPublishedAt: null,
      code: "REPAIR_REQUIRED",
      message: `Sealed document conversion failed. Run \`review repair --review ${uuid(2)}\` to regenerate this Review's artifacts.`,
    };
    await act(async () =>
      root.render(
        <ReviewHome
          reviews={[descriptor()]}
          reviewErrors={[error]}
          onOpen={() => {}}
        />,
      ),
    );

    const attention = container.querySelector(".review-home-attention");
    expect(attention?.textContent).toContain("Old review");
    expect(attention?.textContent).toContain(error.message);
    expect(attention?.querySelector("code")?.textContent).toBe(
      `review repair --review ${uuid(2)}`,
    );
    expect(container.querySelector(".review-migration-warning")).toBeNull();
    const copy = container.querySelector<HTMLButtonElement>(
      '.review-home-attention button[aria-label="Copy command"]',
    );
    expect(copy).not.toBeNull();
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await act(async () => copy?.click());
    expect(writeText.mock.calls).toEqual([
      [`review repair --review ${uuid(2)}`],
    ]);
    expect(copy?.getAttribute("aria-label")).toBe("Command copied");
    expect(
      container.querySelector('button[aria-label="Copy prompt"]'),
    ).toBeNull();
  });

  it("restores list view from storage", async () => {
    localStorage.setItem(REVIEW_HOME_VIEW_STORAGE_KEY, "list");
    await act(async () =>
      root.render(<ReviewHome reviews={[descriptor()]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-list-table")).not.toBeNull();
    expect(
      container
        .querySelector('button[aria-label="List view"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows the document update time for an unpublished review", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-29T12:00:00.000Z"),
    );
    const review = descriptor({
      documentUpdatedAt: "2026-07-29T11:54:00.000Z",
      lastPublishedAt: null,
    });

    await act(async () =>
      root.render(<ReviewHome reviews={[review]} onOpen={() => {}} />),
    );
    expect(container.textContent).toContain("updated 6 min ago");
    expect(container.textContent).not.toContain("updated not published");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="List view"]')
        ?.click(),
    );
    expect(container.textContent).toContain("6 min ago");
    expect(container.textContent).not.toContain("not published");
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
      trace: { enabled: false },
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
    expect(formatRelativeTime(null, now)).toBe("not published");
  });
});

function descriptor(
  overrides: Partial<ReviewDescriptor> = {},
): ReviewDescriptor {
  return {
    uuid: uuid(9),
    title: "Progressive Review",
    status: "awaiting-review",
    worktreePath: "/repo/dev",
    repoKey: "repo-1",
    sourceBranch: "feature/home",
    pullRequestNumber: null,
    pullRequestUrl: null,
    diffStats: null,
    commentCount: 0,
    documentUpdatedAt: null,
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    lastPublishedAt: "2026-07-29T11:54:00.000Z",
    available: true,
    ...overrides,
  };
}

function uuid(suffix: number): string {
  return `11111111-1111-4111-8111-${String(suffix).padStart(12, "0")}`;
}
