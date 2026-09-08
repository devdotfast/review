// @vitest-environment jsdom

import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSetupCard } from "./agent-setup-card";

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

  it("only shows per-agent install controls and the command disclosure", async () => {
    const install: ReviewCanvasInstallContent = {
      status: {
        ...grantedStatus,
        shim: {
          ...grantedStatus.shim,
          installed: true,
          profileConfigured: true,
          onPath: false,
        },
      },
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () => root.render(<AgentSetupCard install={install} />));

    expect(container.textContent).toContain(
      "Installing skills will also install review to your shell PATH.",
    );
    expect(container.textContent).not.toContain("Install for");
    expect(container.textContent).not.toContain("terminal command");
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });
});

const status: ReviewCliInstallStatus = {
  agents: [{ target: "codex", present: true, installed: false }],
  fingerprint: "fingerprint",
  stamp: null,
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

const grantedStatus: ReviewCliInstallStatus = {
  ...status,
  agents: [{ target: "codex", present: true, installed: true }],
  stamp: {
    consent: "granted",
    updatedAt: "2026-08-09T00:00:00.000Z",
    targets: ["codex"],
  },
};
