import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCliInstallStatus,
} from "@dev.fast/whiteboard-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WelcomePage } from "./welcome-page";

const fresh: WhiteboardCliInstallStatus = {
  fingerprint: "test",
  stamp: null,
  stale: false,
  updateNeeded: false,
  shim: {
    path: "/tmp/whiteboard",
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
    args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
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

function content(
  status: WhiteboardCliInstallStatus,
): WhiteboardCanvasInstallContent {
  const same = async () => status;

  return {
    status,
    apply: vi.fn<WhiteboardCanvasInstallContent["apply"]>(same),
    remove: vi.fn<WhiteboardCanvasInstallContent["remove"]>(same),
    removeLegacySkills: vi.fn<
      WhiteboardCanvasInstallContent["removeLegacySkills"]
    >(async () => ({ ...status, legacySkills: [] })),
    finishUpdate: vi.fn<WhiteboardCanvasInstallContent["finishUpdate"]>(
      async () => ({ ...status, updateNeeded: false }),
    ),
    decline: vi.fn<WhiteboardCanvasInstallContent["decline"]>(same),
    skip: vi.fn<WhiteboardCanvasInstallContent["skip"]>(same),
    enablePrompts: vi.fn<WhiteboardCanvasInstallContent["enablePrompts"]>(same),
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
    await act(async () => root.unmount());
    container.remove();
  });

  const buttons = (label: string) =>
    [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === label,
    );

  const stepState = () =>
    container
      .querySelector(".whiteboard-onboarding-step")
      ?.getAttribute("data-state");

  it("offers a prompt per agent and finishes step one once the command is installed", async () => {
    const setupActions = {
      load: vi.fn<() => Promise<WhiteboardCanvasInstallContent>>(async () =>
        content({ ...fresh, shim: { ...fresh.shim, installed: true } }),
      ),
      installCli: vi.fn<() => Promise<void>>(async () => {}),
    };

    await act(async () =>
      root.render(
        <WelcomePage install={content(fresh)} setupActions={setupActions} />,
      ),
    );
    expect(buttons("Copy prompt")).toHaveLength(5);
    expect(container.textContent).toContain("paste a prompt into each agent");
    expect(stepState()).toBe("todo");

    await act(async () => buttons("Install whiteboard in PATH")[0]?.click());
    expect(setupActions.installCli).toHaveBeenCalledOnce();
    expect(stepState()).toBe("done");
  });

  it("shows the update screen and finishes the update on Done", async () => {
    const install = content({
      ...fresh,
      updateNeeded: true,
      shim: { ...fresh.shim, installed: true },
      legacySkills: [{ path: "/h/.codex/skills/whiteboard" }],
    });

    const onClose = vi.fn<() => void>(() => {
      expect(install.finishUpdate).toHaveBeenCalledOnce();
    });

    await act(async () =>
      root.render(<WelcomePage install={install} onClose={onClose} />),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Whiteboard now connects to your agents over MCP",
    );
    expect(container.textContent).toContain("/h/.codex/skills/whiteboard");
    expect(buttons("Copy prompt")).toHaveLength(5);

    await act(async () => buttons("Done")[0]?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
