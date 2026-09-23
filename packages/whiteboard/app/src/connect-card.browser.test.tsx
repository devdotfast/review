import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCliInstallStatus,
} from "@dev.fast/whiteboard-protocol";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectCard,
  LegacySkillsRow,
  WHITEBOARD_CONNECT_TARGET_STORAGE_KEY,
} from "./connect-card";

const status: WhiteboardCliInstallStatus = {
  fingerprint: "f",
  stamp: null,
  stale: false,
  updateNeeded: false,
  shim: {
    path: "/tmp/whiteboard",
    installed: true,
    profileConfigured: true,
    onPath: true,
  },
  trace: {
    enabled: false,
    configured: false,
    autoActivateRepositories: false,
    envPath: "/e",
    settingsPath: "/s",
  },
  cli: { path: "/tmp/cli.js", version: "0.0.1" },
  connect: {
    command: "sh",
    args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
    prompts: {
      claude: "CLAUDE PROMPT",
      codex: "CODEX PROMPT",
      cursor: "CURSOR PROMPT",
      opencode: "OPENCODE PROMPT",
      pi: "PI PROMPT",
    },
    plugins: {
      claude: {
        label: "Install the Claude Code plugin",
        command: "CLAUDE COMMAND",
      },
      codex: { label: "Install the Codex plugin", command: "CODEX COMMAND" },
      cursor: {
        label: "Install in Cursor",
        url: "cursor://anysphere.cursor-deeplink/mcp/install?name=whiteboard",
      },
      opencode: {
        label: "Install the OpenCode plugin",
        command: "OPENCODE COMMAND",
      },
      pi: { label: "Install the Pi package", command: "PI COMMAND" },
    },
  },
  legacySkills: [],
};

function content(
  overrides: Partial<WhiteboardCliInstallStatus> = {},
): WhiteboardCanvasInstallContent {
  const s = { ...status, ...overrides };

  const same = async () => s;

  return {
    status: s,
    apply: vi.fn<WhiteboardCanvasInstallContent["apply"]>(same),
    remove: vi.fn<WhiteboardCanvasInstallContent["remove"]>(same),
    removeLegacySkills: vi.fn<
      WhiteboardCanvasInstallContent["removeLegacySkills"]
    >(async () => ({ ...s, legacySkills: [] })),
    finishUpdate: vi.fn<WhiteboardCanvasInstallContent["finishUpdate"]>(same),
    decline: vi.fn<WhiteboardCanvasInstallContent["decline"]>(same),
    skip: vi.fn<WhiteboardCanvasInstallContent["skip"]>(same),
    enablePrompts: vi.fn<WhiteboardCanvasInstallContent["enablePrompts"]>(same),
  };
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);

  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));

  return container;
}

afterEach(async () => {
  localStorage.removeItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY);

  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
}

function body(container: HTMLElement) {
  return container.querySelector(".whiteboard-home-prompt-body")?.textContent;
}

function copyButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(".whiteboard-home-prompt-copy");
}

describe("ConnectCard", () => {
  it("shows the Claude Code prompt first and switches harness on click", async () => {
    const container = await mount(<ConnectCard install={content()} />);

    expect(button(container, "Claude Code")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(body(container)).toBe("CLAUDE PROMPT");

    await act(async () => button(container, "Codex")?.click());
    expect(button(container, "Codex")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(button(container, "Claude Code")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(body(container)).toBe("CODEX PROMPT");
    expect(localStorage.getItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY)).toBe(
      "codex",
    );
  });

  it("preselects the stored harness", async () => {
    localStorage.setItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY, "pi");

    const container = await mount(<ConnectCard install={content()} />);

    expect(button(container, "Pi")?.getAttribute("aria-pressed")).toBe("true");
    expect(body(container)).toBe("PI PROMPT");
  });

  it("copies whichever text is shown", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const container = await mount(<ConnectCard install={content()} />);

    await act(async () => button(container, "Codex")?.click());
    expect(copyButton(container)?.getAttribute("aria-label")).toBe(
      "Copy prompt for Codex",
    );
    await act(async () => copyButton(container)?.click());
    expect(writeText).toHaveBeenLastCalledWith("CODEX PROMPT");
    expect(copyButton(container)?.textContent).toBe("Copied");

    await act(async () => button(container, "Install the plugin")?.click());
    expect(body(container)).toBe("CODEX COMMAND");
    expect(copyButton(container)?.textContent).toBe("Copy command");
    expect(copyButton(container)?.getAttribute("aria-label")).toBe(
      "Copy install command for Codex",
    );
    await act(async () => copyButton(container)?.click());
    expect(writeText).toHaveBeenLastCalledWith("CODEX COMMAND");
    expect(copyButton(container)?.textContent).toBe("Copied");
    writeText.mockRestore();
  });

  it("reports a successful copy", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const onCopied = vi.fn<() => void>();

    const container = await mount(
      <ConnectCard install={content()} onCopied={onCopied} />,
    );

    await act(async () => copyButton(container)?.click());
    expect(onCopied).toHaveBeenCalledOnce();
    writeText.mockRestore();
  });

  it("links to Cursor's installer, or asks for the whiteboard command without one", async () => {
    localStorage.setItem(WHITEBOARD_CONNECT_TARGET_STORAGE_KEY, "cursor");

    const container = await mount(<ConnectCard install={content()} />);

    await act(async () => button(container, "Install the plugin")?.click());

    const link = container.querySelector("a");

    expect(link?.textContent).toBe("Install in Cursor");
    expect(link?.getAttribute("href")).toMatch(/^cursor:\/\//);
    expect(link?.getAttribute("target")).toBe("_blank");

    const bare = await mount(
      <ConnectCard
        install={content({
          cli: null,
          shim: { ...status.shim, installed: false },
          connect: {
            ...status.connect,
            plugins: {
              ...status.connect.plugins,
              cursor: { label: "Install in Cursor" },
            },
          },
        })}
      />,
    );

    await act(async () => button(bare, "Install the plugin")?.click());
    expect(bare.querySelector("a")).toBeNull();
    expect(body(bare)).toContain("Install in Cursor");
    expect(body(bare)).toContain("Install the whiteboard command first.");
    expect(bare.querySelector(".whiteboard-connect-note")).toBeNull();
  });

  it("notes the missing whiteboard command without disabling copy", async () => {
    const container = await mount(
      <ConnectCard
        install={content({ shim: { ...status.shim, installed: false } })}
      />,
    );

    expect(container.querySelector(".whiteboard-connect-note")?.textContent).toBe(
      "Install the whiteboard command first. The prompt and the plugin both launch it.",
    );
    expect(copyButton(container)?.disabled).toBe(false);
  });

  it("collapses a long prompt until the reader expands it, and copies all of it", async () => {
    const long = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const container = await mount(
      <ConnectCard
        install={content({
          connect: {
            ...status.connect,
            prompts: { ...status.connect.prompts, claude: long },
          },
        })}
      />,
    );

    const body = container.querySelector("pre");
    expect(body?.dataset.collapsed).toBe("true");

    const toggle = container.querySelector("[aria-expanded]");
    expect(toggle?.textContent).toBe("Show more…");
    await act(async () => (toggle as HTMLButtonElement).click());
    expect(body?.dataset.collapsed).toBe("false");
    expect(toggle?.textContent).toBe("Show less");

    const copy = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Copy prompt",
    );

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(long);

    const short = await mount(<ConnectCard install={content()} />);
    expect(short.querySelector("pre")?.dataset.collapsed).toBe("false");
    expect(short.querySelector("[aria-expanded]")).toBeNull();
  });

  it("shows the setup error from the status", async () => {
    const container = await mount(
      <ConnectCard install={content({ error: "boom" })} />,
    );

    expect(
      container.querySelector(".whiteboard-connect-error")?.textContent,
    ).toBe("boom");
  });
});

describe("LegacySkillsRow", () => {
  it("renders nothing without legacy skills and reports what it removed", async () => {
    const install = content({
      legacySkills: [{ path: "/h/.claude/skills/whiteboard" }],
    });

    const onStatusChange =
      vi.fn<(status: WhiteboardCliInstallStatus) => void>();

    const container = await mount(
      <LegacySkillsRow install={install} onStatusChange={onStatusChange} />,
    );

    expect(container.textContent).toContain("Whiteboard no longer uses them.");
    expect(container.textContent).toContain("/h/.claude/skills/whiteboard");

    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove old Whiteboard skills",
    );

    await act(async () => button?.click());
    expect(install.removeLegacySkills).toHaveBeenCalled();

    const next = onStatusChange.mock.calls[0]?.[0];

    expect(next?.legacySkills).toEqual([]);

    await act(async () => {
      if (next) {
        mounted[0]?.root.render(
          <LegacySkillsRow
            install={{ ...install, status: next }}
            onStatusChange={onStatusChange}
          />,
        );
      }
    });
    expect(container.textContent).toContain("Removed 1 skill");
    expect(container.textContent).toContain("/h/.claude/skills/whiteboard");
    expect(container.querySelector("button")).toBeNull();

    const empty = await mount(<LegacySkillsRow install={content()} />);

    expect(empty.textContent).toBe("");
  });
});
