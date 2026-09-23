import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REVIEW_CONNECT_COPIED_STORAGE_KEY, WelcomePage } from "./welcome-page";

const fresh: ReviewCliInstallStatus = {
  fingerprint: "test",
  stamp: null,
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
    configured: false,
    autoActivateRepositories: false,
    envPath: "/tmp/env",
    settingsPath: "/tmp/settings",
  },
  cli: { path: "/tmp/cli.js", version: "0.0.1" },
  connect: {
    command: "sh",
    args: ["-c", 'exec "$HOME/.local/bin/review" mcp'],
    prompts: {
      claude: "claude prompt",
      codex: "codex prompt",
      cursor: "cursor prompt",
      opencode: "opencode prompt",
      pi: "pi prompt",
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

function content(status: ReviewCliInstallStatus): ReviewCanvasInstallContent {
  const same = async () => status;

  return {
    status,
    apply: vi.fn<ReviewCanvasInstallContent["apply"]>(same),
    remove: vi.fn<ReviewCanvasInstallContent["remove"]>(same),
    removeLegacySkills: vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(
      async () => ({ ...status, legacySkills: [] }),
    ),
    finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(
      async () => ({ ...status, updateNeeded: false }),
    ),
    decline: vi.fn<ReviewCanvasInstallContent["decline"]>(same),
    skip: vi.fn<ReviewCanvasInstallContent["skip"]>(same),
    enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(same),
  };
}

describe("WelcomePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    localStorage.removeItem(REVIEW_CONNECT_COPIED_STORAGE_KEY);
    await act(async () => root.unmount());
    container.remove();
  });

  const buttons = (label: string) =>
    [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === label,
    );

  const step = (index: number) =>
    container.querySelectorAll(".review-onboarding-step")[index];

  const stepState = (index: number) => step(index)?.getAttribute("data-state");

  const stepOpen = (index: number) => step(index)?.getAttribute("data-open");

  it("opens on the install step until the review command is installed", async () => {
    const setupActions = {
      load: vi.fn<() => Promise<ReviewCanvasInstallContent>>(async () =>
        content({ ...fresh, shim: { ...fresh.shim, installed: true } }),
      ),
      installCli: vi.fn<() => Promise<void>>(async () => {}),
    };

    await act(async () =>
      root.render(
        <WelcomePage install={content(fresh)} setupActions={setupActions} />,
      ),
    );
    expect(stepOpen(0)).toBe("true");
    expect(stepState(0)).toBe("todo");
    expect(stepState(1)).toBe("todo");
    expect(buttons("Install review in PATH")).toHaveLength(1);

    await act(async () => buttons("Install review in PATH")[0]?.click());
    expect(setupActions.installCli).toHaveBeenCalledOnce();
    expect(stepState(0)).toBe("done");
    expect(container.textContent).toContain("Installed at /tmp/review.");
    expect(buttons("Install review in PATH")).toHaveLength(0);
  });

  it("opens on the connect step once the command is installed", async () => {
    await act(async () =>
      root.render(
        <WelcomePage
          install={content({
            ...fresh,
            shim: { ...fresh.shim, installed: true },
          })}
        />,
      ),
    );
    expect(stepState(0)).toBe("done");
    expect(stepOpen(1)).toBe("true");
    expect(
      container.querySelectorAll('[aria-label="Agent"] button'),
    ).toHaveLength(5);
  });

  it("counts a source run as installed", async () => {
    await act(async () =>
      root.render(<WelcomePage install={content({ ...fresh, cli: null })} />),
    );
    expect(stepState(0)).toBe("done");
  });

  it("finishes the connect step once a prompt is copied", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    await act(async () =>
      root.render(
        <WelcomePage
          install={content({
            ...fresh,
            shim: { ...fresh.shim, installed: true },
          })}
        />,
      ),
    );
    expect(stepState(1)).toBe("todo");
    await act(async () => buttons("Copy prompt")[0]?.click());
    expect(stepState(1)).toBe("done");
    expect(localStorage.getItem(REVIEW_CONNECT_COPIED_STORAGE_KEY)).toBe("1");
    writeText.mockRestore();
  });

  it("shows the update screen and finishes the update on Done", async () => {
    const install = content({
      ...fresh,
      updateNeeded: true,
      shim: { ...fresh.shim, installed: true },
      legacySkills: [{ path: "/h/.codex/skills/review" }],
    });

    const onClose = vi.fn<() => void>(() => {
      expect(install.finishUpdate).toHaveBeenCalledOnce();
    });

    await act(async () =>
      root.render(<WelcomePage install={install} onClose={onClose} />),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Review now connects to your agents over MCP",
    );
    expect(container.textContent).toContain("/h/.codex/skills/review");
    expect(buttons("Copy prompt")).toHaveLength(1);
    expect(
      container.querySelectorAll('[aria-label="Agent"] button'),
    ).toHaveLength(5);

    await act(async () => buttons("Done")[0]?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
