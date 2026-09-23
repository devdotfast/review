import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCliInstallStatus,
} from "@dev.fast/whiteboard-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSetupCard } from "./agent-setup-card";

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
    const onStatusChange =
      vi.fn<(status: WhiteboardCliInstallStatus) => void>();

    const apply = vi.fn<WhiteboardCanvasInstallContent["apply"]>(
      async () => grantedStatus,
    );

    const install: WhiteboardCanvasInstallContent = {
      // A granted stamp: not first run, so only the per-agent rows install.
      status: { ...status, stamp: grantedStatus.stamp },
      apply,
      remove: vi.fn<WhiteboardCanvasInstallContent["remove"]>(),
      decline: vi.fn<WhiteboardCanvasInstallContent["decline"]>(),
      skip: vi.fn<WhiteboardCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<WhiteboardCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(
        <AgentSetupCard install={install} onStatusChange={onStatusChange} />,
      ),
    );
    await act(async () => {
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".whiteboard-agent-setup-agents button",
        ),
      ];

      buttons.find((button) => button.textContent === "Install")?.click();
    });

    expect(apply).toHaveBeenCalledExactlyOnceWith({
      targets: ["codex"],
    });
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(grantedStatus);
  });
});

const status: WhiteboardCliInstallStatus = {
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

const grantedStatus: WhiteboardCliInstallStatus = {
  ...status,
  agents: [{ target: "codex", present: true, installed: true }],
  stamp: {
    consent: "granted",
    updatedAt: "2026-08-09T00:00:00.000Z",
    targets: ["codex"],
  },
};
