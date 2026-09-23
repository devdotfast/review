import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceCaptureSection } from "./trace-capture-section";

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

  it("enables capture with the entered credentials and no agent targets", async () => {
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
      removeLegacySkills:
        vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(),
      finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(),
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
      trace: {
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucket: "review-traces",
      },
    });
  });

  it("names the hosted store when capture runs on it", async () => {
    const hostedStatus: ReviewCliInstallStatus = {
      ...traceStatus,
      trace: {
        ...traceStatus.trace,
        enabled: true,
        configured: true,
        storageMode: "hosted",
      },
    };

    const install: ReviewCanvasInstallContent = {
      status: hostedStatus,
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
      removeLegacySkills:
        vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(),
      finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );
    expect(
      container.querySelector(".review-agent-setup-state")?.textContent,
    ).toBe("enabled (hosted)");
    expect(
      container.querySelector('[data-testid="trace-storage"]')?.textContent,
    ).toContain("hosted trace store selected");
  });

  it("disables capture through the shared remove action", async () => {
    const enabledStatus: ReviewCliInstallStatus = {
      ...traceStatus,
      trace: { ...traceStatus.trace, enabled: true },
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
      removeLegacySkills:
        vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(),
      finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Disable")
        ?.click();
    });

    expect(remove).toHaveBeenCalledExactlyOnceWith({ trace: true });
  });

  it("hides the bucket fields and the S3 copy on a hosted machine", async () => {
    const hostedStatus: ReviewCliInstallStatus = {
      ...traceStatus,
      trace: {
        ...traceStatus.trace,
        enabled: true,
        configured: true,
        storageMode: "hosted",
      },
    };

    const install: ReviewCanvasInstallContent = {
      status: hostedStatus,
      apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
      remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
      decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
      skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
      enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
      removeLegacySkills:
        vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(),
      finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(),
    };

    await act(async () =>
      root.render(<TraceCaptureSection install={install} />),
    );
    expect(
      container.querySelector('input[aria-label="S3/R2 endpoint URL"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      "to the hosted /dev/fast trace store",
    );
    expect(container.textContent).not.toContain("your own S3/R2 bucket");
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].map(
        (button) => button.textContent,
      ),
    ).not.toContain("Repair");
  });
});

const traceStatus: ReviewCliInstallStatus = {
  fingerprint: "fingerprint",
  stamp: {
    consent: "granted",
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  stale: false,
  updateNeeded: false,
  shim: {
    path: "/tmp/review",
    installed: false,
    profileConfigured: false,
    onPath: false,
  },
  trace: {
    enabled: false,
    configured: true,
    autoActivateRepositories: false,
    envPath: "/tmp/trace-env",
    settingsPath: "/tmp/trace-settings.json",
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "review-traces",
    accessKeyIdPrefix: "key-id",
  },
  cli: { path: "/tmp/cli.js", version: "0.0.1" },
  connect: {
    command: "review",
    args: ["mcp"],
    prompts: {
      claude: "claude",
      codex: "codex",
      cursor: "cursor",
      opencode: "opencode",
      pi: "pi",
    },
    plugins: {
      claude: { label: "claude plugin", command: "claude command" },
      codex: { label: "codex plugin", command: "codex command" },
      cursor: { label: "cursor plugin", url: "cursor://install" },
      opencode: { label: "opencode plugin", command: "opencode command" },
      pi: { label: "pi plugin", command: "pi command" },
    },
  },
  legacySkills: [],
};
