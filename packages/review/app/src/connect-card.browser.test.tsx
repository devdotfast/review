import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectCard,
  LegacySkillsRow,
  REVIEW_CONNECT_TARGET_STORAGE_KEY,
} from "./connect-card";

const status: ReviewCliInstallStatus = {
  fingerprint: "f",
  stamp: null,
  stale: false,
  updateNeeded: false,
  shim: {
    path: "/tmp/review",
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
    args: ["-c", 'exec "$HOME/.local/bin/review" mcp'],
    prompts: {
      claude: "CLAUDE PROMPT",
      codex: "CODEX PROMPT",
      cursor: "CURSOR PROMPT",
      opencode: "OPENCODE PROMPT",
      pi: "PI PROMPT",
      omp: "OMP PROMPT",
    },
    plugins: {
      claude: {
        label: "Install the Claude Code plugin",
        command: "CLAUDE COMMAND",
      },
      codex: { label: "Install the Codex plugin", command: "CODEX COMMAND" },
      cursor: {
        label: "Install in Cursor",
        url: "cursor://anysphere.cursor-deeplink/mcp/install?name=review",
      },
      opencode: {
        label: "Install the OpenCode plugin",
        command: "OPENCODE COMMAND",
      },
      pi: { label: "Install the Pi package", command: "PI COMMAND" },
      omp: { label: "Install the oh-my-pi package", command: "OMP COMMAND" },
    },
  },
  legacySkills: [],
};

function content(
  overrides: Partial<ReviewCliInstallStatus> = {},
): ReviewCanvasInstallContent {
  const s = { ...status, ...overrides };

  const same = async () => s;

  return {
    status: s,
    apply: vi.fn<ReviewCanvasInstallContent["apply"]>(same),
    remove: vi.fn<ReviewCanvasInstallContent["remove"]>(same),
    removeLegacySkills: vi.fn<ReviewCanvasInstallContent["removeLegacySkills"]>(
      async () => ({ ...s, legacySkills: [] }),
    ),
    finishUpdate: vi.fn<ReviewCanvasInstallContent["finishUpdate"]>(same),
    decline: vi.fn<ReviewCanvasInstallContent["decline"]>(same),
    skip: vi.fn<ReviewCanvasInstallContent["skip"]>(same),
    enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(same),
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
  localStorage.removeItem(REVIEW_CONNECT_TARGET_STORAGE_KEY);

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
  return container.querySelector(".review-home-prompt-body")?.textContent;
}

function otherTrigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(
    ".review-connect-other-trigger",
  );
}

function copyButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(".review-home-prompt-copy");
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
    expect(localStorage.getItem(REVIEW_CONNECT_TARGET_STORAGE_KEY)).toBe(
      "codex",
    );
  });

  it("preselects the stored harness", async () => {
    localStorage.setItem(REVIEW_CONNECT_TARGET_STORAGE_KEY, "pi");

    const container = await mount(<ConnectCard install={content()} />);

    expect(otherTrigger(container)?.textContent).toBe("Pi");
    expect(otherTrigger(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(body(container)).toBe("PI PROMPT");
  });

  it("swaps between the other agents from the menu", async () => {
    const container = await mount(<ConnectCard install={content()} />);

    expect(otherTrigger(container)?.textContent).toBe("Other…");
    expect(otherTrigger(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[role=menu]")).toBeNull();

    await act(async () => otherTrigger(container)?.click());
    expect(
      [...container.querySelectorAll("[role=menuitemradio]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["Pi", "oh-my-pi"]);

    await act(async () => button(container, "oh-my-pi")?.click());
    expect(container.querySelector("[role=menu]")).toBeNull();
    expect(otherTrigger(container)?.textContent).toBe("oh-my-pi");
    expect(otherTrigger(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(
      otherTrigger(container)?.querySelector(".review-agent-logo--omp"),
    ).not.toBeNull();
    expect(button(container, "Claude Code")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(body(container)).toBe("OMP PROMPT");
    expect(localStorage.getItem(REVIEW_CONNECT_TARGET_STORAGE_KEY)).toBe("omp");

    await act(async () => button(container, "Install the plugin")?.click());
    expect(body(container)).toBe("OMP COMMAND");
    expect(copyButton(container)?.getAttribute("aria-label")).toBe(
      "Copy install command for oh-my-pi",
    );

    await act(async () => button(container, "Codex")?.click());
    expect(otherTrigger(container)?.textContent).toBe("Other…");
    expect(otherTrigger(container)?.getAttribute("aria-pressed")).toBe("false");
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
    localStorage.setItem(REVIEW_CONNECT_TARGET_STORAGE_KEY, "cursor");

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
    expect(bare.querySelector("button")).toBeNull();
  });

  it.each([
    { legacySkills: [{ path: "~/.claude/skills/dev-review" }] },
    { cli: null, shim: { ...status.shim, installed: false } },
    { shim: { ...status.shim, installed: false } },
    { shim: { ...status.shim, onPath: false, profileConfigured: false } },
  ])(
    "blocks setup actions until prerequisites are complete: %j",
    async (overrides) => {
      const container = await mount(
        <ConnectCard install={content(overrides)} />,
      );

      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    },
  );

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

    const toggle = container.querySelector(
      ".review-connect-body-wrap [aria-expanded]",
    );

    expect(toggle?.textContent).toBe("Show full prompt");
    await act(async () => (toggle as HTMLButtonElement).click());
    expect(body?.dataset.collapsed).toBe("false");
    expect(
      container.querySelector(".review-connect-collapse")?.textContent,
    ).toBe("Show less");

    const copy = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Copy prompt",
    );

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(long);

    const short = await mount(<ConnectCard install={content()} />);
    expect(short.querySelector("pre")?.dataset.collapsed).toBe("false");
    expect(
      short.querySelector(".review-connect-body-wrap [aria-expanded]"),
    ).toBeNull();
  });

  it("shows the setup error from the status", async () => {
    const container = await mount(
      <ConnectCard install={content({ error: "boom" })} />,
    );

    expect(container.querySelector(".review-connect-error")?.textContent).toBe(
      "boom",
    );
  });
});

describe("LegacySkillsRow", () => {
  it("renders nothing without legacy skills and reports what it removed", async () => {
    const install = content({
      legacySkills: [{ path: "/h/.claude/skills/review" }],
    });

    const onStatusChange = vi.fn<(status: ReviewCliInstallStatus) => void>();

    const container = await mount(
      <LegacySkillsRow install={install} onStatusChange={onStatusChange} />,
    );

    expect(container.textContent).toContain("Whiteboard no longer uses them.");
    expect(container.textContent).toContain("/h/.claude/skills/review");

    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove deprecated skills",
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
    expect(container.textContent).toContain("/h/.claude/skills/review");
    expect(container.querySelector("button")).toBeNull();

    const empty = await mount(<LegacySkillsRow install={content()} />);

    expect(empty.textContent).toBe("");
  });
});
