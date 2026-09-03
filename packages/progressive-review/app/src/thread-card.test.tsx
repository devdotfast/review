// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom does not implement ResizeObserver, which ThreadCard uses to re-measure
// clamped message bodies. These tests assert markup, not layout, so a stub that
// never fires is enough — the observer's real behaviour is verified in a browser.
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= StubResizeObserver;

import type { ThreadView } from "./review-threads";
import { writeReviewUiState } from "./review-ui-state";
import {
  ThreadCard,
  ThreadComposer,
  composeVerbMenuPlacement,
} from "./thread-card";

const roots: Array<ReturnType<typeof createRoot>> = [];

describe("ThreadComposer", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    window.sessionStorage.clear();
  });

  it("defaults the primary verb to Ask now, ignoring any stored preference", async () => {
    // The sticky last-used verb was removed: the same-looking button must not
    // mean different things across sessions.
    writeReviewUiState("window", "review-compose-verb", "add-to-review");
    const { container } = await renderComposer();

    expect(primaryButton(container).textContent).toContain("Ask now");
    expect(
      container.querySelector(".thread-compose-verb--ask-now"),
    ).not.toBeNull();
  });

  it("fires the current new-thread verb from the primary segment and Enter", async () => {
    const onAskNow = vi.fn<(body: string) => void>();
    const onAddToReview = vi.fn<(body: string) => void>();
    const { container } = await renderComposer({
      initialDraft: "Why did this change?",
      onAskNow,
      onAddToReview,
    });

    await act(async () => primaryButton(container).click());
    expect(onAskNow).toHaveBeenCalledWith("Why did this change?");
    expect(onAddToReview).not.toHaveBeenCalled();

    await setTextarea(container, "Queue this finding");
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      textarea(container).dispatchEvent(shiftEnter);
    });

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(textarea(container).value).toBe("Queue this finding");

    await act(async () => {
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    // Enter fires the primary verb, which stays Ask now: only a menu click
    // sends the other one.
    expect(onAskNow).toHaveBeenNthCalledWith(2, "Queue this finding");
    expect(onAddToReview).not.toHaveBeenCalled();
    expect(
      primaryButton(container).querySelector(".thread-compose-kbd")
        ?.textContent,
    ).toMatch(/↩$/);
  });

  it("clears a submitted ask while the answer is still running", async () => {
    let finishAsk!: () => void;
    let valueWhenAskStarted: string | undefined;
    const askFinished = new Promise<void>((resolve) => {
      finishAsk = resolve;
    });
    let composerContainer!: HTMLElement;
    const onAskNow = vi.fn<() => Promise<void>>(() => {
      valueWhenAskStarted = textarea(composerContainer).value;
      return askFinished;
    });
    const { container } = await renderComposer({
      initialDraft: "Why did this change?",
      onAskNow,
    });
    composerContainer = container;

    await act(async () => {
      primaryButton(container).click();
      await Promise.resolve();
    });

    expect(onAskNow).toHaveBeenCalledWith("Why did this change?");
    expect(valueWhenAskStarted).toBe("");
    expect(textarea(container).value).toBe("");

    await act(async () => finishAsk());
  });

  it("submits a message with Enter or Command-Enter and keeps Shift-Enter for a newline", async () => {
    const onSubmit = vi.fn<(body: string) => void>();
    const { container } = await renderMessageComposer({
      initialDraft: "Please change this",
      onSubmit,
    });

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      textarea(container).dispatchEvent(shiftEnter);
    });

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe("Please change this");

    await act(async () => {
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      );
    });

    expect(onSubmit).toHaveBeenCalledWith("Please change this");
  });

  it("sends the draft from the menu item instead of re-arming the primary", async () => {
    const onAskNow = vi.fn<(body: string) => void>();
    const onAddToReview = vi.fn<(body: string) => void>();
    const { container } = await renderComposer({
      initialDraft: "Queue this finding",
      onAskNow,
      onAddToReview,
    });

    await chooseVerb(container, "Add to review");

    expect(onAddToReview).toHaveBeenCalledWith("Queue this finding");
    expect(onAskNow).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("compose verb menu placement", () => {
  it("flips above when the menu would clip below the viewport", () => {
    expect(
      composeVerbMenuPlacement({
        controlTop: 620,
        controlBottom: 650,
        menuHeight: 120,
        viewportHeight: 700,
      }),
    ).toBe("above");
  });

  it("keeps the menu below when there is enough room", () => {
    expect(
      composeVerbMenuPlacement({
        controlTop: 200,
        controlBottom: 230,
        menuHeight: 120,
        viewportHeight: 700,
      }),
    ).toBe("below");
  });
});

describe("ThreadCard compact presentation", () => {
  it("keeps the anchored card's head/body rows and never adopts the agent-chat skin", async () => {
    const thread: ThreadView = {
      key: "thread-1",
      threadId: "thread-1",
      target: { kind: "document" },
      quote: "Entire document",
      resolved: false,
      latestAt: "2026-01-01T00:00:02.000Z",
      messages: [
        {
          id: "user-1",
          by: "You",
          at: "2026-01-01T00:00:00.000Z",
          body: "Please change this",
          userAuthored: true,
        },
        {
          id: "agent-1",
          by: "Agent",
          at: "2026-01-01T00:00:01.000Z",
          body: "Understood",
          userAuthored: false,
          agentMarkdown: true,
        },
        {
          id: "activity-1",
          by: "Agent",
          at: "2026-01-01T00:00:02.000Z",
          body: "Running…",
          userAuthored: false,
          running: true,
        },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<ThreadCard thread={thread} variant="panel" />);
    });

    const messages = container.querySelectorAll(".thread-message");
    expect(messages).toHaveLength(3);
    expect(
      messages[0]?.querySelector(".thread-message-head strong")?.textContent,
    ).toBe("You");
    expect(
      messages[0]?.querySelector(".thread-message-body")?.textContent,
    ).toBe("Please change this");
    expect(
      messages[1]?.querySelector(".thread-message-body .agent-markdown"),
    ).not.toBeNull();
    // The anchored mini cards deliberately keep their compact presentation;
    // only the sidebar thread view and traces use the agent-chat rows.
    expect(container.querySelector('[class*="agent-chat"]')).toBeNull();
  });
});

describe("ThreadCard message actions", () => {
  it("puts thread delete in the ordered header and Edit/Delete on user messages", async () => {
    const thread: ThreadView = {
      key: "thread-1",
      threadId: "thread-1",
      target: { kind: "document" },
      quote: "Entire document",
      resolved: false,
      latestAt: "2026-01-01T00:00:01.000Z",
      messages: [
        {
          id: "user-1",
          by: "You",
          at: "2026-01-01T00:00:00.000Z",
          body: "Please change this",
          userAuthored: true,
        },
        {
          id: "agent-1",
          by: "Agent",
          at: "2026-01-01T00:00:01.000Z",
          body: "Understood",
          userAuthored: false,
          agentMarkdown: true,
        },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onDelete = vi.fn<() => void>();
    const onDeleteMessage = vi.fn<(messageId: string) => void>();
    await act(async () => {
      root.render(
        <ThreadCard
          thread={thread}
          variant="panel"
          onEditMessage={() => {}}
          onDelete={onDelete}
          onDeleteMessage={onDeleteMessage}
          onMinimize={() => {}}
          onResolve={() => {}}
        />,
      );
    });

    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".thread-actions > button",
        ),
      ).map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Delete thread", "Minimize thread", "Resolve"]);

    const messages = container.querySelectorAll(".thread-message");
    expect(messages).toHaveLength(2);
    expect(
      messages[0]?.querySelector(".thread-message-menu-button"),
    ).not.toBeNull();
    expect(
      messages[1]?.querySelector(".thread-message-menu-button"),
    ).toBeNull();

    await act(async () => {
      messages[0]
        ?.querySelector<HTMLButtonElement>(".thread-message-menu-button")
        ?.click();
    });
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).map((button) => button.textContent);
    expect(labels).toEqual(["Edit", "Delete"]);

    await act(async () => {
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      )
        .find((button) => button.textContent === "Delete")
        ?.click();
    });
    expect(onDeleteMessage).toHaveBeenCalledWith("user-1");
    expect(onDelete).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete thread"]')
        ?.click();
    });
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

async function renderComposer(
  overrides: {
    initialDraft?: string;
    onAskNow?: (body: string) => void | boolean | Promise<void | boolean>;
    onAddToReview?: (body: string) => void | boolean | Promise<void | boolean>;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ThreadComposer
        kind="new-thread"
        placeholder="Ask about this..."
        autoFocus
        initialDraft={overrides.initialDraft}
        onAskNow={overrides.onAskNow ?? (() => {})}
        onAddToReview={overrides.onAddToReview ?? (() => {})}
      />,
    );
  });
  return { container, root };
}

async function renderMessageComposer(overrides: {
  initialDraft: string;
  onSubmit: (body: string) => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ThreadComposer
        kind="message"
        placeholder="Reply..."
        submitLabel="Send"
        autoFocus
        initialDraft={overrides.initialDraft}
        onSubmit={overrides.onSubmit}
      />,
    );
  });
  return { container, root };
}

/** Opens the chevron menu and clicks an item, which now sends the draft. */
async function chooseVerb(container: HTMLElement, label: string) {
  const toggle = container.querySelector<HTMLButtonElement>(
    ".thread-compose-verb-chevron",
  );
  if (!toggle) throw new Error("Missing compose verb menu toggle");
  await act(async () => toggle.click());
  const option = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find(
    (candidate) => candidate.querySelector("strong")?.textContent === label,
  );
  if (!option) throw new Error(`Missing ${label} compose verb option`);
  await act(async () => option.click());
}

async function setTextarea(container: HTMLElement, value: string) {
  await act(async () => {
    const field = textarea(container);
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!setValue) throw new Error("Missing textarea value setter");
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector("textarea");
  if (!field) throw new Error("Missing thread composer textarea");
  return field;
}

function primaryButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    ".thread-compose-verb-primary",
  );
  if (!button) throw new Error("Missing primary compose verb button");
  return button;
}
