// @vitest-environment jsdom

import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSetupCard, TARGET_LABELS, supportsFff } from "./agent-setup-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentSetupCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("persists a skip before it closes the setup card", async () => {
    let finishSkip: ((status: ReviewCliInstallStatus) => void) | undefined;
    const skip = vi.fn<ReviewCanvasInstallContent["skip"]>(
      () =>
        new Promise<ReviewCliInstallStatus>((resolve) => {
          finishSkip = resolve;
        }),
    );
    const onSkip = vi.fn<() => void>();
    const install: ReviewCanvasInstallContent = {
      status,
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip,
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(<AgentSetupCard install={install} onSkip={onSkip} />),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button.review-agent-setup-subtle")
        ?.click();
    });

    expect(skip).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Skipping…");

    await act(async () => finishSkip?.(skippedStatus));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("reports the refreshed status after the first-run install", async () => {
    const onStatusChange = vi.fn<(status: ReviewCliInstallStatus) => void>();
    const apply = vi.fn<ReviewCanvasInstallContent["apply"]>(
      async () => grantedStatus,
    );
    const install: ReviewCanvasInstallContent = {
      status,
      apply,
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(
        <AgentSetupCard install={install} onStatusChange={onStatusChange} />,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button.review-agent-setup-primary")
        ?.click();
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(grantedStatus);
  });

  it("reports the refreshed status after a per-agent install", async () => {
    const onStatusChange = vi.fn<(status: ReviewCliInstallStatus) => void>();
    const apply = vi.fn<ReviewCanvasInstallContent["apply"]>(
      async () => grantedStatus,
    );
    const install: ReviewCanvasInstallContent = {
      // A granted stamp: not first run, so only the per-agent rows install.
      status: { ...status, stamp: grantedStatus.stamp },
      apply,
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(
        <AgentSetupCard install={install} onStatusChange={onStatusChange} />,
      ),
    );
    await act(async () => {
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".review-agent-setup-agents button",
        ),
      ];
      buttons.find((button) => button.textContent === "Install")?.click();
    });

    expect(apply).toHaveBeenCalledExactlyOnceWith({
      targets: ["codex"],
    });
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(grantedStatus);
  });

  it("maps OpenCode setup without enabling FFF", async () => {
    const openCodeStatus: ReviewCliInstallStatus = {
      ...status,
      agents: [{ target: "opencode", present: true, installed: false }],
      stamp: grantedStatus.stamp,
    };
    const install: ReviewCanvasInstallContent = {
      status: openCodeStatus,
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(
        async () => openCodeStatus,
      ),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () => root.render(<AgentSetupCard install={install} />));

    expect(TARGET_LABELS.opencode).toBe("OpenCode");
    expect(supportsFff("opencode")).toBe(false);
    expect(container.textContent).toContain("OpenCode");
    expect(
      container.querySelector(".review-agent-logo--opencode"),
    ).not.toBeNull();
  });
});

const status: ReviewCliInstallStatus = {
  agents: [{ target: "codex", present: true, installed: false }],
  fingerprint: "fingerprint",
  stamp: null,
  stale: false,
  shim: { path: "/tmp/review", onPath: false },
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

const skippedStatus: ReviewCliInstallStatus = {
  ...status,
  stamp: { consent: "skipped", updatedAt: "2026-08-09T00:00:00.000Z" },
};

const grantedStatus: ReviewCliInstallStatus = {
  ...status,
  agents: [{ target: "codex", present: true, installed: true }],
  stamp: {
    consent: "granted",
    updatedAt: "2026-08-09T00:00:00.000Z",
    targets: ["codex"],
  },
};
