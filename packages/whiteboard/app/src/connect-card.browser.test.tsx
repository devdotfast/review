import type {
  WhiteboardCanvasInstallContent,
  WhiteboardCliInstallStatus,
} from "@dev.fast/whiteboard-protocol";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectCard, LegacySkillsRow } from "./connect-card";

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
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("ConnectCard", () => {
  it("copies the prompt for the chosen harness", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const container = await mount(<ConnectCard install={content()} />);

    const buttons = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === "Copy prompt",
    );

    expect(buttons).toHaveLength(5);
    expect(buttons[1]?.getAttribute("aria-label")).toBe(
      "Copy prompt for Codex",
    );
    await act(async () => buttons[1]?.click());
    expect(writeText).toHaveBeenCalledWith("CODEX PROMPT");
    expect(container.textContent).toContain("Copied");
    writeText.mockRestore();
  });

  it("offers each harness's plugin above the prompt", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const container = await mount(<ConnectCard install={content()} />);

    const rows = [...container.querySelectorAll("li")];

    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Install the Claude Code plugin"),
      expect.stringContaining("Install the Codex plugin"),
      expect.stringContaining("Install in Cursor"),
      expect.stringContaining("Install the OpenCode plugin"),
      expect.stringContaining("Install the Pi package"),
    ]);

    for (const row of rows) {
      expect(row.textContent).toContain("or paste this prompt");
    }

    const link = rows[2]?.querySelector("a");

    expect(link?.textContent).toBe("Install in Cursor");
    expect(link?.getAttribute("href")).toMatch(/^cursor:\/\//);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(rows[2]?.textContent).not.toContain("Copy command");

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy install command for Pi"]',
    );

    expect(copy?.textContent).toBe("Copy command");
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith("PI COMMAND");
    writeText.mockRestore();
  });

  it("lets Desktop from source connect without the whiteboard command", async () => {
    const container = await mount(
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

    const cursor = container.querySelectorAll("li")[2];

    expect(cursor?.querySelector("a")).toBeNull();
    expect(cursor?.textContent).toContain("Install in Cursor");
    expect(container.textContent).not.toContain(
      "Install the whiteboard command first",
    );
    expect(
      [...container.querySelectorAll("button")].every((b) => !b.disabled),
    ).toBe(true);
  });

  it("reveals the prompt text on demand", async () => {
    const container = await mount(<ConnectCard install={content()} />);

    const details = container.querySelectorAll("details")[4];

    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Show prompt");
    await act(async () => {
      if (details) details.open = true;
    });
    expect(details?.querySelector("pre")?.textContent).toBe("PI PROMPT");
  });

  it("asks for the whiteboard command before agents can connect", async () => {
    const container = await mount(
      <ConnectCard
        install={content({ shim: { ...status.shim, installed: false } })}
      />,
    );

    expect(container.textContent).toContain(
      "Install the whiteboard command first",
    );

    const copies = [...container.querySelectorAll("button")].filter((b) =>
      ["Copy prompt", "Copy command"].includes(b.textContent ?? ""),
    );

    expect(copies).toHaveLength(9);
    expect(copies.every((b) => b.disabled)).toBe(true);
    expect(container.querySelector("a")).toBeNull();
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
