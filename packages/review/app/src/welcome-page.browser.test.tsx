import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
  ReviewCliInstallTarget,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { WelcomePage } from "./welcome-page";

describe("Welcome agent installation", () => {
  it.each(["cursor", "claude", "codex"] as const)(
    "remembers %s installation across dropdown toggles and copies skill prompts",
    async (target: ReviewCliInstallTarget) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);

      const initial: ReviewCliInstallStatus = {
        agents: [
          { target, present: true, installed: false },
          ...(target === "cursor"
            ? [
                { target: "claude" as const, present: true, installed: false },
                { target: "codex" as const, present: true, installed: false },
              ]
            : []),
        ],
        fingerprint: "test",
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
          corpusRoot: "/tmp/traces",
          binary: { path: "/tmp/fff", installed: false },
          registrations: [],
        },
        trace: {
          enabled: false,
          configured: false,
          autoActivateRepositories: false,
          envPath: "/tmp/env",
          settingsPath: "/tmp/settings",
        },
        cli: { path: "/tmp/cli.js", version: "0.0.1" },
      };

      const installed: ReviewCliInstallStatus = {
        ...initial,
        agents: initial.agents.map((agent) => ({
          ...agent,
          installed: agent.target === target,
        })),
        shim: { ...initial.shim, installed: true },
      };

      const install: ReviewCanvasInstallContent = {
        status: initial,
        apply: vi.fn<ReviewCanvasInstallContent["apply"]>(
          async () => installed,
        ),
        remove: vi.fn<ReviewCanvasInstallContent["remove"]>(
          async () => initial,
        ),
        decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
        skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
        enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
      };

      const click = async (label: string) => {
        const button = [...container.querySelectorAll("button")].find(
          (button) =>
            button.textContent === label ||
            button.getAttribute("aria-label") === label,
        );

        expect(button).toBeDefined();
        await act(async () => button!.click());
      };

      const state = () =>
        container.querySelector(".review-agent-setup-state")?.textContent;

      try {
        await act(async () => root.render(<WelcomePage install={install} />));
        await click("Install");
        expect(install.apply).toHaveBeenCalledExactlyOnceWith({
          targets: [target],
        });
        expect(state()).toBe("installed");
        expect(
          container
            .querySelector(".review-onboarding-step")
            ?.getAttribute("data-state"),
        ).toBe("done");
        await click("Collapse Connect your agents");
        await click("Expand Connect your agents");
        expect(state()).toBe("installed");
        await click("Expand Create your first review");
        const writeText = vi
          .spyOn(navigator.clipboard, "writeText")
          .mockResolvedValue();

        for (const kind of ["Review a change", "Architecture review"]) {
          await click(kind);
          const prompt = container.querySelector(
            ".review-home-prompt-body",
          )?.textContent;

          expect(prompt).toContain(
            target === "cursor" ? "/dev-review" : "dev-review",
          );
          expect(prompt).not.toContain("review scaffold");
          expect(prompt).not.toContain("review publish");
          await click("Copy prompt");
          expect(writeText).toHaveBeenLastCalledWith(prompt);
        }

        await click("Expand Connect your agents");
        await click("Uninstall");
        await click("Collapse Connect your agents");
        await click("Expand Connect your agents");
        expect(state()).toBe("detected");
        expect(
          container
            .querySelector(".review-onboarding-step")
            ?.getAttribute("data-state"),
        ).toBe("todo");
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
      }
    },
  );
});
