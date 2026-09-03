// @vitest-environment jsdom

import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceCaptureSection } from "./trace-capture-section";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("TraceCaptureSection", () => {
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

  it("enables capture for every installed agent through the install action", async () => {
    const apply = vi.fn<ReviewCanvasInstallContent["apply"]>(
      async () => traceStatus,
    );
    const install: ReviewCanvasInstallContent = {
      status: traceStatus,
      apply,
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Enable")
        ?.click();
    });

    expect(apply).toHaveBeenCalledExactlyOnceWith({
      targets: ["codex"],
      fff: true,
      trace: true,
    });
  });

  it("reports enabled while a repository may publish traces", async () => {
    const install: ReviewCanvasInstallContent = {
      status: { ...traceStatus, trace: { enabled: true } },
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );

    expect(
      container.querySelector(".review-agent-setup-state")?.textContent,
    ).toBe("enabled");
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].map(
        (button) => button.textContent,
      ),
    ).toContain("Disable");
  });

  it("disables capture through the shared remove action", async () => {
    const enabledStatus: ReviewCliInstallStatus = {
      ...traceStatus,
      trace: { enabled: true },
    };
    const remove = vi.fn<ReviewCanvasInstallContent["remove"]>(
      async () => traceStatus,
    );
    const install: ReviewCanvasInstallContent = {
      status: enabledStatus,
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove,
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Disable")
        ?.click();
    });

    expect(remove).toHaveBeenCalledExactlyOnceWith({
      targets: [],
      trace: true,
    });
  });
});

const traceStatus: ReviewCliInstallStatus = {
  agents: [{ target: "codex", present: true, installed: true }],
  fingerprint: "fingerprint",
  stamp: {
    consent: "granted",
    updatedAt: "2026-08-09T00:00:00.000Z",
    targets: ["codex"],
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
