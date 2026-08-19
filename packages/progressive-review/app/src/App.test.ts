import { readFileSync } from "node:fs";

import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodePeekCard, validatedCodePeekInputFromRef } from "./CodePeek";
import { commentAnnotationPositionsEqual } from "./comment-pins";
import { a as ReviewMdxLink } from "./review-components";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";
import {
  normalizeReviewView,
  reviewViewLabel,
  shouldCloseSidePeekForReviewView,
} from "./review-view-route";
import { selectActiveSoftwareMapModel } from "./software-map-selection";
import { defineSoftwareModel } from "./software-map/model";
import {
  CARD_BODY_LINE_HEIGHT,
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  MARGIN_CARDS_MIN_GUTTER,
  gutterForAvailable,
} from "./thread-annotations";

const testSession = testReviewSession();

function renderWithTestSession(element: ReactElement): string {
  return renderToStaticMarkup(reviewSessionElement(testSession, element));
}

describe("Review Home styling", () => {
  it("uses theme tokens for every Home surface", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.review-home-card\s*{[^}]*background:\s*var\(--bg\);/s,
    );
    expect(styles).toMatch(
      /\.review-home\s*{[^}]*color:\s*var\(--ink\);[^}]*background:\s*var\(--review-home-bg\);/s,
    );
    expect(styles).not.toContain("--review-home-card:");

    const blockFor = (selector: string) => {
      const start = styles.indexOf(selector);
      const open = styles.indexOf("{", start);
      let depth = 0;
      for (let index = open; index < styles.length; index += 1) {
        if (styles[index] === "{") depth += 1;
        if (styles[index] === "}" && --depth === 0) {
          return styles.slice(start, index + 1);
        }
      }
      throw new Error(`Expected ${selector} token block`);
    };
    const darkTokens = blockFor(".review-canvas-root");
    const lightTokens = blockFor(".review-app--theme-light");
    for (const token of [
      "--review-home-bg",
      "--review-home-card-active",
      "--review-home-rule",
      "--review-home-rule-soft",
      "--review-home-meta",
      "--review-home-comment",
      "--review-home-submitted",
      "--review-home-view-toggle-bg",
      "--review-home-view-toggle-active-border",
      "--review-home-view-toggle-active-bg",
      "--review-home-view-toggle-shadow",
      "--review-home-view-toggle-highlight",
    ]) {
      expect(darkTokens).toContain(`${token}:`);
      expect(lightTokens).toContain(`${token}:`);
    }
  });
});

describe("review app comment annotations", () => {
  it("detects unchanged annotation positions so observer passes can stay idle", () => {
    const annotations = [
      {
        key: "thread-comment",
        threadId: "thread-comment",
        targetKey: "text:block:p:3:abc123:0:selection",
        index: 1,
        status: "persisted" as const,
        kind: "comment" as const,
        rects: [{ x: 120, y: 48, width: 320, height: 18 }],
        marker: { x: 810, y: 46 },
        anchorY: 48,
        blockRight: 800,
      },
      {
        key: "thread-comment-2",
        threadId: "thread-comment-2",
        targetKey: "text:anchor:reviewRuntime:text:0:selection",
        index: 1,
        status: "draft" as const,
        kind: "comment" as const,
        rects: [],
        marker: { x: 640, y: 90 },
        anchorY: 98,
        blockRight: null,
      },
    ];

    expect(commentAnnotationPositionsEqual(annotations, [...annotations])).toBe(
      true,
    );
    expect(
      commentAnnotationPositionsEqual(annotations, [
        {
          ...annotations[0],
          rects: [{ ...annotations[0].rects[0], y: 49 }],
        },
        annotations[1],
      ]),
    ).toBe(false);
    expect(
      commentAnnotationPositionsEqual(annotations, [
        annotations[0],
        { ...annotations[1], marker: { x: 641, y: 90 } },
      ]),
    ).toBe(false);
  });
});

describe("review app initial view", () => {
  it("wires the version history control and historical banner", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(appSource).toContain("<ReviewHistoryControl />");
    expect(appSource).toContain('name: "openReviewRevision"');
    expect(styles).toMatch(/\.review-history-banner\s*{/);
  });

  it("closes side peeks when leaving the rendered review document", () => {
    expect(shouldCloseSidePeekForReviewView("review")).toBe(false);
    expect(shouldCloseSidePeekForReviewView("map")).toBe(true);
    expect(shouldCloseSidePeekForReviewView("diff")).toBe(true);
  });

  it("opens on the persisted view and falls back to the review document", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toContain('viewStateSync.initialActiveView ?? "review"');
    expect(normalizeReviewView("map", false)).toBe("review");
    expect(normalizeReviewView("map", true)).toBe("map");
    expect(normalizeReviewView("commits", true, false)).toBe("review");
    expect(normalizeReviewView("diff", true, false)).toBe("review");
    expect(normalizeReviewView("commits", false, true)).toBe("commits");
  });

  it("routes all tab changes through side peek cleanup", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toContain("const applyReviewView = (view: ReviewView) => {");
    expect(source).toContain(
      "shouldCloseSidePeekForReviewView(normalizedView)",
    );
    expect(source).toContain("closeDetail();");
    expect(source).toContain('applyReviewView("map");');
    expect(source).toContain("onClick={() => applyReviewView(view)}");
  });

  it("puts Review, Commits, Diff, and Map in one segmented switcher", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const diffFilesContextSource = readFileSync(
      new URL("./review-diff-files-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(appSource).toContain('diffFiles.status === "loaded"');
    // The count is seeded at app load, before the launcher is clicked.
    expect(appSource).toContain("diffFiles.files.length");
    expect(appSource).toContain("<ReviewDiffFilesProvider");
    expect(diffFilesContextSource).toContain('reviewFetch("/diff-files"');
    expect(diffFilesContextSource).toContain("includePatch: false");
    expect(appSource).toContain("filesTabFileCount !== null && (");
    expect(appSource).toContain('<span className="review-segment-count">');
    expect(appSource).toContain('className="review-segmented"');
    expect(appSource).toContain('role="group"');
    expect(appSource).toContain("aria-pressed={activeView === view}");
    expect(appSource).toContain('"Map (Experimental)"');
    // Diff is one of the switcher's views, not a launcher for another tab.
    expect(appSource).toContain(
      'view === "diff" && filesTabFileCount !== null',
    );
    expect(appSource).toContain("reviewViewLabel(view)");
    expect(appSource).not.toContain("session.surface.openFiles()");
    expect(appSource).not.toContain('aria-label="Open the diff in the editor"');
    expect(appSource).toContain(
      '...(hasChangeRange ? (["commits", "diff"] as const) : [])',
    );
    expect(appSource).toContain(
      '...(softwareMapEnabled ? (["map"] as const) : [])',
    );
    expect(reviewViewLabel("review")).toBe("Review");
    expect(reviewViewLabel("map")).toBe("Map");
    expect(reviewViewLabel("diff")).toBe("Diff");
    expect(reviewViewLabel("commits")).toBe("Commits");
    expect(appSource).not.toContain("review-files-launcher");
    expect(appSource).not.toContain("review-tabbar");
    expect(appSource).not.toContain("review-tab-pill");
    expect(appSource).not.toContain('role="tablist"');
    expect(appSource).not.toContain('role="tab"');
    expect(appSource).not.toContain("files_opened");
    expect(styles).toMatch(
      /\.review-segment\s*{[^}]*height:\s*var\(--chrome-control-height\);[^}]*border:\s*0;[^}]*border-radius:\s*var\(--chrome-control-radius\);/s,
    );
    expect(styles).toMatch(
      /\.review-segmented \.review-segment:focus-visible\s*{[^}]*outline:\s*2px solid var\(--chrome-fg\);/s,
    );
    expect(styles).toMatch(/\.review-topbar-left\s*{[^}]*overflow-x:\s*auto;/s);
    expect(styles).toMatch(/\.review-segmented\s*{[^}]*display:\s*flex;/s);
    expect(styles).not.toContain(".review-files-launcher");
    expect(styles).not.toContain(".review-tab-pill");
  });

  it("renders the split topbar Threads control beside the decision control", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const iconSource = readFileSync(new URL("./icons.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).not.toContain(
      "@container review-content (max-width: 860px)",
    );
    expect(styles).toContain("@container review-content (max-width: 720px)");
    expect(appSource).toContain("<ThreadsIcon />");
    expect(appSource).not.toContain("<span>Ask</span>");
    expect(appSource).not.toContain("topbar-ask-button");
    expect(appSource).toContain(
      'review.pendingCommentCount > 0 ? "New comment" : "New ask"',
    );
    expect(appSource).toContain("<span>Threads</span>");
    expect(appSource).toContain("topbar-new-ask-button");
    expect(appSource).toContain("<ReviewCornerAction />");
    expect(appSource).toContain("<ReviewBatonChip");
    expect(appSource).not.toContain("RejectReviewControl");
    expect(iconSource).toContain("function ThreadsIcon");
    expect(styles).toMatch(
      /\.topbar-threads-split\s*{[^}]*height:\s*var\(--chrome-control-height\);[^}]*border:\s*1px solid var\(--chrome-border\);/s,
    );
    expect(styles).toMatch(
      /\.topbar-threads-button\s*{[^}]*border:\s*none;[^}]*font-family:\s*var\(--chrome-font\);/s,
    );
    expect(styles).toContain(".review-corner-confirm");
  });

  it("dresses the topbar in workbench chrome instead of its own wordmark", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // The /dev/fast wordmark moved to the macOS application menu.
    expect(appSource).not.toContain("review-kicker");
    expect(appSource).not.toContain("review-topbar-divider");
    expect(styles).not.toContain("review-kicker");
    expect(styles).not.toContain("review-topbar-divider");

    // The bar lines up with the workbench's own 35px tab row and drops the
    // frosted-glass treatment that read as a foreign surface.
    expect(styles).toMatch(
      /\.review-topbar\s*{[^}]*height:\s*35px;[^}]*background:\s*var\(--surface\);/s,
    );
    expect(styles).not.toContain("backdrop-filter: blur(14px)");

    // Every chrome token resolves against the workbench theme first and only
    // falls back to the canvas palette in the standalone browser build.
    for (const [token, vscodeVar, fallback] of [
      ["--chrome-fg", "--vscode-foreground", "--ink"],
      ["--chrome-hover-bg", "--vscode-toolbar-hoverBackground", "--control-bg"],
      [
        "--chrome-active-border",
        "--vscode-panelTitle-activeBorder",
        "--accent",
      ],
    ] as const) {
      expect(styles).toContain(
        `${token}: var(${vscodeVar}, var(${fallback}));`,
      );
    }
    // Declared on .review-app, the element that also carries the light-theme
    // palette class -- declaring them higher up would freeze the dark values.
    expect(styles).toMatch(/\.review-app\s*{[^}]*--chrome-fg:/s);
  });

  it("resolves the canvas ground against the workbench theme in both palettes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // The canvas used to paint a hardcoded #0a0b0d ground while the workbench
    // root painted --vscode-editor-background, so the canvas sat in a visibly
    // lighter frame. Both palettes now bridge the same ten neutrals.
    const groundBridge = [
      ["--bg", "--vscode-editor-background", "#0a0b0d", "#ffffff"],
      ["--bg-2", "--vscode-editorWidget-background", "#10141c", "#f4f4f3"],
      ["--surface", "--vscode-editor-background", "#0d0f13", "#ffffff"],
      [
        "--surface-raised",
        "--vscode-editorWidget-background",
        "#1a1f2a",
        "#ffffff",
      ],
      ["--control-bg", "--vscode-input-background", "#141822", "#ffffff"],
      ["--ink", "--vscode-editor-foreground", "#e8eaee", "#1a1a18"],
      ["--ink-soft", "--vscode-descriptionForeground", "#9ba1ac", "#555555"],
      ["--ink-faint", "--vscode-disabledForeground", "#565c66", "#999999"],
      ["--rule", "--vscode-panel-border", "#1c1f26", "#e0e0de"],
      ["--rule-soft", "--vscode-editorWidget-border", "#262c37", "#cccccc"],
    ] as const;
    for (const [
      token,
      vscodeVar,
      darkFallback,
      lightFallback,
    ] of groundBridge) {
      expect(styles).toContain(`${token}: var(${vscodeVar}, ${darkFallback});`);
      expect(styles).toContain(
        `${token}: var(${vscodeVar}, ${lightFallback});`,
      );
    }

    // widget.border is null on both stock themes, so the variable is never
    // emitted and its fallback would leak the dark rule into light. Scoped to
    // the bridge itself -- an unrelated future use elsewhere is not this test's
    // business.
    for (const [, vscodeVar] of groundBridge) {
      expect(vscodeVar).not.toBe("--vscode-widget-border");
    }
  });

  it("floats whole-document drafts outside the clipped review column", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const annotationsSource = readFileSync(
      new URL("./thread-annotations.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(appSource).toContain("isGlobalCommentDraft(review.draftTarget)");
    expect(appSource).toContain("openThreadsWithDraftCleanup({");
    expect(annotationsSource).toContain(
      "isGlobalCommentDraft(review.draftTarget)\n    ? null",
    );
    expect(styles).toMatch(
      /\.review-app--peek-open \.review-floating-draft\s*{[^}]*right:\s*calc\(var\(--side-peek-width, 560px\) \+ 34px\);/s,
    );
    expect(styles).toMatch(
      /@media \(max-width: 720px\)\s*{[^}]*\.review-app--peek-open \.review-floating-draft\s*{[^}]*right:\s*16px;/s,
    );
  });

  it("keeps map floating actions out of the side peek corner", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toContain("showFloatingActions={!activePanel}");
  });
});

describe("review app software map selection", () => {
  it("selects the model that contains a side-peek map focus target", () => {
    const repoModel = defineSoftwareModel({
      systems: {
        repo: { label: "Repo map" },
      },
    });
    const documentModel = defineSoftwareModel({
      systems: {
        review: {
          label: "Review model",
          containers: {
            app: { label: "Review app" },
          },
        },
      },
    });

    expect(
      selectActiveSoftwareMapModel({
        softwareModels: [repoModel, documentModel],
        focusElementPath: "review.app",
      }),
    ).toBe(documentModel);
    expect(
      selectActiveSoftwareMapModel({
        softwareModels: [repoModel, documentModel],
      }),
    ).toBe(repoModel);
  });
});

describe("review app interaction palette", () => {
  it("bridges every map color from the workbench theme in both palettes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const darkBlock = styles.match(/\.review-canvas-root\s*{([^}]*)}/s)?.[1];
    const lightBlock = styles.match(
      /\.review-app--theme-light\s*{([^}]*)}/s,
    )?.[1];

    if (!darkBlock || !lightBlock) {
      throw new Error("Expected dark and light theme blocks in styles.css");
    }

    const mapBridge = [
      ["--map-canvas", "--vscode-review-map-canvas", "#08080D", "#FFFFFF"],
      ["--map-panel-1", "--vscode-review-map-panel1", "#0F1119", "#F4F4F8"],
      ["--map-panel-2", "--vscode-review-map-panel2", "#14161F", "#ECEDF3"],
      ["--map-card", "--vscode-review-map-card", "#0B0C12", "#FFFFFF"],
      ["--map-line-1", "--vscode-review-map-line1", "#1E2130", "#E2E3EC"],
      ["--map-line-2", "--vscode-review-map-line2", "#262A3B", "#DEE0EA"],
      ["--map-card-line", "--vscode-review-map-cardLine", "#262A3B", "#E2E3EC"],
      ["--map-edge", "--vscode-review-map-edge", "#3D4256", "#AFB3C2"],
      ["--map-chip", "--vscode-review-map-chip", "#10121A", "#FFFFFF"],
      [
        "--map-active-fill",
        "--vscode-review-map-activeFill",
        "rgba(77,110,245,0.08)",
        "#F8F9FD",
      ],
      ["--map-changed", "--vscode-review-map-changed", "#F5C97C", "#C89544"],
      ["--map-added", "--vscode-review-map-added", "#6FC7A8", "#149E62"],
      ["--map-removed", "--vscode-review-map-removed", "#F58A7C", "#CF5D4C"],
      ["--map-pos", "--vscode-review-map-diffPositive", "#6FC7A8", "#149E62"],
      ["--map-neg", "--vscode-review-map-diffNegative", "#F58A7C", "#CF5D4C"],
      [
        "--map-badge-bg",
        "--vscode-review-map-badgeBg",
        "rgba(255,255,255,0.04)",
        "rgba(23,27,25,0.05)",
      ],
    ] as const;

    const normalizedDarkBlock = darkBlock.replace(/\s/g, "").toLowerCase();
    const normalizedLightBlock = lightBlock.replace(/\s/g, "").toLowerCase();

    for (const [token, vscodeToken, darkFallback, lightFallback] of mapBridge) {
      expect(normalizedDarkBlock).toContain(
        `${token}:var(${vscodeToken},${darkFallback});`.toLowerCase(),
      );
      expect(normalizedLightBlock).toContain(
        `${token}:var(${vscodeToken},${lightFallback});`.toLowerCase(),
      );
    }
  });

  it("keeps map selection in the accent while removing inherited focus borders", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // Canvas controls render inside the workbench DOM. Inherited VS Code
    // focus/list/input borders must not draw an extra box around the canvas's
    // own subtle background highlights. The map's selection ring is the
    // exception: it is the only cue a node is selected, so it draws in the
    // accent instead of being suppressed.
    expect(styles).toMatch(
      /\.review-canvas-root\s*{[^}]*--selection:\s*var\(--accent\);[^}]*--selection-shadow:\s*color-mix\(in srgb, var\(--accent\) 40%, transparent\);[^}]*--vscode-focusBorder:\s*transparent;[^}]*--vscode-list-focusOutline:\s*transparent;[^}]*--vscode-inputOption-activeBorder:\s*transparent;/s,
    );
    expect(styles).toMatch(
      /\.review-app--theme-light\s*{[^}]*--selection:\s*var\(--accent\);[^}]*--selection-shadow:\s*color-mix\(in srgb, var\(--accent\) 40%, transparent\);[^}]*--vscode-focusBorder:\s*transparent;[^}]*--vscode-list-focusOutline:\s*transparent;[^}]*--vscode-inputOption-activeBorder:\s*transparent;/s,
    );
    expect(styles).not.toContain("--focus-border:");
    expect(styles).not.toContain(".review-canvas-root :focus-visible");
  });
});

describe("review app light theme", () => {
  it("keeps text selection readable and subtle in focused and inactive light windows", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.review-app--theme-light\s*{[^}]*--text-selection-bg:\s*rgba\(43,\s*79,\s*224,\s*0\.18\);[^}]*--text-selection-color:\s*var\(--ink\);/s,
    );
    expect(styles).toMatch(
      /\.review-app::selection,\s*\.review-app \*::selection\s*{[^}]*background-color:\s*var\(--text-selection-bg\);[^}]*color:\s*var\(--text-selection-color\);/s,
    );
    expect(styles).toMatch(
      /\.review-app::-moz-selection,\s*\.review-app \*::-moz-selection\s*{[^}]*background-color:\s*var\(--text-selection-bg\);[^}]*color:\s*var\(--text-selection-color\);/s,
    );
    expect(styles).not.toMatch(
      /\.review-app--theme-light\s*{[^}]*--text-selection-bg:\s*var\(--selection\);/s,
    );
  });

  it("opens ordinary review document links in a new tab by default", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReviewMdxLink,
        { href: "https://example.com/docs" },
        "Docs",
      ),
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("preserves in-document hash links without new-tab defaults", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewMdxLink, { href: "#summary" }, "Summary"),
    );

    expect(html).toContain('href="#summary"');
    expect(html).not.toContain("target=");
    expect(html).not.toContain("rel=");
  });

  it("uses shared icon controls for close and comment actions", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewContextSource = readFileSync(
      new URL("./review-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const diagramsSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const softwareMapStyles = readFileSync(
      new URL("./software-map/styles.css", import.meta.url),
      { encoding: "utf8" },
    );

    expect(appSource).toContain("<CommentIcon />");
    expect(appSource).toContain('? "Comment on selection"');
    expect(appSource).toContain(': "Ask about selection"');
    expect(appSource).not.toContain("selection-question-button");
    expect(reviewComponentsSource).toContain("<CloseIcon />");
    expect(reviewComponentsSource).toContain("<CommentIcon />");
    expect(reviewComponentsSource).toContain("<MapPinIcon />");
    expect(reviewComponentsSource).toContain("openSoftwareMapElement");
    expect(reviewComponentsSource).not.toContain("Ask about side peek");
    expect(reviewComponentsSource).not.toContain("hideAskAction");
    expect(reviewContextSource).not.toContain("setPanelState");
    expect(reviewContextSource).not.toContain("hideAskAction");
    expect(diagramsSource).toContain("<CommentIcon />");
    expect(styles).toMatch(
      /\.ui-icon\s*{[^}]*stroke:\s*currentColor;[^}]*stroke-width:\s*1\.7px;/s,
    );
    expect(styles).toMatch(
      /\.icon-button\s*{[^}]*width:\s*30px;[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*color:\s*var\(--ink-faint\);/s,
    );
    expect(styles).toMatch(
      /\.review-debug-close\s*{[^}]*width:\s*24px;[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*color:\s*var\(--ink-faint\);/s,
    );
    expect(styles).toMatch(
      /\.peek-actions \.icon-button\s*{[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*color:\s*var\(--ink-faint\);/s,
    );
    // One labeled canvas action opens the merged draft composer.
    expect(styles).toMatch(
      /\.selection-action-buttons\s*{[^}]*height:\s*28px;[^}]*border:\s*1px solid var\(--rule-soft\);[^}]*border-radius:\s*7px;[^}]*background:\s*var\(--bg-2\);[^}]*color:\s*var\(--ink\);/s,
    );
    expect(styles).toMatch(
      /\.selection-action-segment\s*{[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);/s,
    );
    expect(appSource).not.toContain("selection-button-divider");
    expect(styles).toMatch(
      /\.comment-hover-button\s*{[^}]*min-width:\s*30px;[^}]*height:\s*30px;[^}]*border:\s*1px solid var\(--accent\);[^}]*border-radius:\s*999px;[^}]*background:\s*color-mix\(in srgb, var\(--accent\) 70%, var\(--surface\)\);[^}]*color:\s*var\(--on-accent\);/s,
    );
    expect(styles).toMatch(/\.comment-hover-button\s*{[^}]*z-index:\s*40;/s);
    // The chip rests visible and clickable, with a solid fill rather than
    // element opacity, so what is underneath never shows through the pill.
    expect(styles).toMatch(
      /\.comment-hover-button\s*{[^}]*pointer-events:\s*auto;/s,
    );
    expect(styles).not.toMatch(
      /^\.comment-hover-button\s*{[^}]*pointer-events:\s*none;/ms,
    );
    expect(styles).not.toMatch(/^\.comment-hover-button\s*{[^}]*opacity:/ms);
    // Sequence diagrams are the exception: every participant and message is a
    // comment target, so rest-visible chips stack up as clutter. There the
    // chip is hover-gated per labeled element.
    expect(styles).toMatch(
      /\.sequence-diagram \.comment-hover-button\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.sequence-diagram\s+:is\(\s*\.sequence-participant-comment-target,\s*\.sequence-message-comment-target\s*\):hover\s*>\s*\.comment-hover-button[\s\S]*?{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    // Hover undamps the fill on both the document and software map surfaces.
    expect(styles).toMatch(
      /\.comment-hover-button:hover,\s*\.comment-hover-button:focus-visible\s*{[^}]*background:\s*var\(--accent\);/s,
    );
    expect(softwareMapStyles).toMatch(
      /\.comment-target-hovered > \.comment-hover-button\s*{[^}]*background:\s*var\(--accent\);/s,
    );
    expect(styles).toMatch(
      /\.sequence-participant-comment-target,\s*\.sequence-message-comment-target,\s*\.database-edge-comment-target\s*{[^}]*z-index:\s*40;/s,
    );
    expect(styles).toMatch(
      /\.sequence-message-comment-target,\s*\.database-edge-comment-target\s*{[^}]*z-index:\s*40;/s,
    );
    expect(styles).toMatch(
      /\.sequence-diagram[\s\S]*?\.react-flow__node:has\(\s*\.sequence-participant-node:hover \.comment-hover-button\s*\)\s*{[^}]*z-index:\s*40 !important;/s,
    );
    expect(styles).not.toMatch(/\.react-flow__node:hover\s*{[^}]*z-index:/s);
    expect(appSource).not.toContain("+ Comment");
    expect(reviewComponentsSource).not.toMatch(/>\s*x\s*</);
    expect(reviewComponentsSource).not.toMatch(/>\s*Comment\s*</);
    expect(reviewComponentsSource).not.toContain("side-peek-eyebrow");
    expect(diagramsSource).not.toContain("+ comment");
  });

  it("rests hover-gated affordances at a shared visible opacity", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.review-canvas-root\s*{[^}]*--affordance-rest-opacity:\s*0\.45;/s,
    );
    // Expanded sections still advertise their collapse chevron.
    expect(styles).toMatch(
      /\.review-section-toggle\s*{[^}]*opacity:\s*var\(--affordance-rest-opacity\);/s,
    );
    expect(styles).not.toMatch(
      /\.review-section-toggle\s*{[^}]*opacity:\s*0;/s,
    );
    // Hover, focus and the collapsed state remain the full-strength escalation.
    expect(styles).toMatch(
      /\.review-section-header:hover \.review-section-toggle,\s*\.review-section-toggle:focus-visible,\s*\.review-section--collapsed \.review-section-toggle\s*{[^}]*opacity:\s*1;/s,
    );
  });

  it("uses shared icon controls for compact expand and collapse actions", () => {
    const iconSource = readFileSync(new URL("./icons.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(iconSource).toContain("function PlusIcon");
    expect(iconSource).toContain("function MinusIcon");
    expect(iconSource).toContain('className="ui-icon ui-icon--plus"');
    expect(iconSource).toContain('className="ui-icon ui-icon--minus"');
    expect(iconSource).not.toMatch(/>\s*\+\s*</);
    expect(iconSource).not.toMatch(/>\s*-\s*</);
  });

  it("uses one minimal draggable separator for side panels", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const resizerSource = readFileSync(
      new URL("./side-panel-resizer.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(appSource).toContain("useRightPanelResize");
    expect(appSource).toContain('stateKey: "side-peek-width"');
    expect(resizerSource).toContain("useReviewUiState(");
    expect(resizerSource).toContain("constrainWidth(requestedWidth)");
    expect(appSource).toContain("containerRef: appRef");
    expect(appSource).toContain("ref={appRef}");
    expect(appSource).toContain("separatorWidth: 10");
    expect(appSource).toContain(
      'className="side-panel-resizer side-peek-resizer"',
    );
    expect(appSource).toMatch(
      /{rightPanelOpen && \(\s*<div\s+className="side-panel-resizer side-peek-resizer"/s,
    );
    expect(resizerSource).toContain('role: "separator"');
    expect(resizerSource).toContain('"aria-orientation": "vertical"');
    expect(resizerSource).toContain("new ResizeObserver(reclampWidth)");
    expect(resizerSource).toContain("resizeObserver.observe(container)");
    expect(styles).toMatch(
      /\.side-panel-resizer\s*{[^}]*width:\s*10px;[^}]*background:\s*var\(--transparent\);[^}]*border:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.side-panel-resizer::before\s*{[^}]*width:\s*1px;[^}]*background:\s*var\(--rule\);/s,
    );
  });

  it("keeps side-peek hover widgets above the resize divider", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // The detail host follows the resizer in the grid. Keep the separator in
    // the normal stacking order so hover widgets can paint over its divider.
    expect(appSource).toMatch(
      /side-panel-resizer side-peek-resizer"\s*{\.\.\.sidePeekResize\.separatorProps}\s*\/>\s*\)}\s*<div className="review-detail-host">/s,
    );
    expect(styles).not.toMatch(/\.side-panel-resizer\s*{[^}]*\bz-index\s*:/s);
  });

  it("hosts side peeks as mobile bottom sheets instead of a right rail", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const softwareMapStyles = readFileSync(
      new URL("./software-map/styles.css", import.meta.url),
      { encoding: "utf8" },
    );
    const softwareMapSource = readFileSync(
      new URL("./software-map/SoftwareMap.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(reviewComponentsSource).toContain("side-panel-sheet-resizer");
    expect(reviewComponentsSource).not.toContain("side-peek-backdrop");
    expect(styles).not.toContain("side-peek-backdrop");
    expect(appSource).toContain("review-app--peek-open");
    expect(styles).toMatch(
      /\.review-canvas-root\s*{[^}]*contain:\s*layout;[^}]*container:\s*review-canvas \/ inline-size;/s,
    );
    expect(styles).toMatch(
      /@container review-canvas \(max-width:\s*929px\)\s*{[\s\S]*?\.review-app--peek-open\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0\s*0;/s,
    );
    expect(styles).toMatch(
      /@container review-canvas \(max-width:\s*929px\)\s*{[\s\S]*?\.side-panel\s*{[^}]*position:\s*absolute;[^}]*inset:\s*auto 0 0 0;[^}]*height:\s*calc\(var\(--side-panel-bottom-fraction,\s*0\.5\)\s*\*\s*100%\);/s,
    );
    expect(styles).toMatch(
      /@container review-canvas \(max-width:\s*929px\)\s*{[\s\S]*?\.side-panel-sheet-resizer\s*{[^}]*display:\s*block;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.review-app--peek-open\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0\s*0;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.side-panel\s*{[^}]*position:\s*absolute;[^}]*inset:\s*auto 0 0 0;[^}]*height:\s*calc\(var\(--side-panel-bottom-fraction,\s*0\.5\)\s*\*\s*100%\);/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.side-panel-sheet-resizer\s*{[^}]*display:\s*block;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.review-document[\s\S]*?--review-document-padding-inline:\s*clamp\(12px,\s*4vw,\s*20px\);/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.review-document[\s\S]*?:is\(\.sequence-diagram, \.database-lens, \.software-map\)[\s\S]*?width:\s*calc\(100cqi - 16px\);/s,
    );
    expect(styles).toMatch(
      /@media \(max-height:\s*560px\)\s*{[\s\S]*?\.side-panel\s*{[^}]*inset:\s*0;[^}]*height:\s*100%;/s,
    );
    expect(styles).toMatch(
      /\.review-app\s*{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).not.toContain("@media (max-width: 420px)");
    expect(softwareMapSource).toContain("software-map-code-inspector-backdrop");
    expect(softwareMapStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.software-map-code-inspector-backdrop\s*{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*48;[^}]*background:\s*var\(--backdrop\);/s,
    );
    expect(softwareMapStyles).toMatch(
      /@media \(max-width:\s*720px\)\s*{[\s\S]*?\.software-map-code-inspector\s*{[^}]*position:\s*absolute;[^}]*bottom:\s*8px;[^}]*height:\s*min\(72%,\s*560px\);[^}]*border-radius:\s*12px;/s,
    );
  });

  it("suppresses layout and panel entrance motion during restoration", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(appSource).toContain("review-app--restored-panel");
    expect(reviewComponentsSource).toContain("side-panel--restored");
    expect(styles).toMatch(
      /\.review-app--restored-panel\s*{[^}]*transition:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.side-panel--restored\s*{[^}]*animation:\s*none;/s,
    );
  });

  it("drafts new threads through the unified ThreadCard composer", () => {
    const annotationsSource = readFileSync(
      new URL("./thread-annotations.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const threadCardSource = readFileSync(
      new URL("./thread-card.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewContextSource = readFileSync(
      new URL("./review-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(reviewContextSource).toContain("CommentDraftPlacement");
    expect(reviewContextSource).toContain(
      "commentDraftPlacementFromActiveElement",
    );
    // The draft is one card with the verb chosen by the persisted split
    // control. It renders in the margin at wide layouts, as a popover otherwise.
    expect(annotationsSource).toContain("ThreadDraftCard");
    expect(annotationsSource).toContain("submitDraft");
    expect(annotationsSource).toContain("review.closeCommentDraft()");
    expect(threadCardSource).toContain('"Ask or add to review..."');
    expect(threadCardSource).toContain('intent === "ask-agent"');
    expect(threadCardSource).toContain("thread-compose-verb");
    expect(threadCardSource).toContain('label: "Ask now"');
    expect(threadCardSource).toContain('label: "Add to review"');
    expect(threadCardSource).toContain('kind="new-thread"');
    expect(threadCardSource).not.toContain("secondaryLabel");
    expect(threadCardSource).not.toContain("onSecondarySubmit");
    // The composer is bare until focused; controls appear while composing.
    expect(threadCardSource).toContain("thread-reply-row");
    expect(threadCardSource).toContain("setComposing(true)");
    // Portaling the popover to the app lets it cross the document scroller's
    // clipping edge and paint above an open side peek.
    expect(annotationsSource).toContain(
      'import { createPortal } from "react-dom"',
    );
    expect(annotationsSource).toContain("createPortal(");
    expect(annotationsSource).toContain("reviewRoots?.appRef.current");
    // Popover geometry is owned by popoverStyle() so the rendered width and the
    // POPOVER_WIDTH the placement clamps use cannot drift apart again.
    const popoverRule = /\.thread-popover\s*{([^}]*)}/s.exec(styles)?.[1] ?? "";
    expect(popoverRule).toContain("z-index: 60;");
    expect(popoverRule).not.toMatch(/\bwidth:/);
    expect(popoverRule).not.toMatch(/\bposition:/);
    expect(annotationsSource).toContain(
      "width: `min(${POPOVER_WIDTH}px, calc(100% - 24px))`",
    );
    // A clamped compact body says so, rather than trailing off into an ellipsis.
    expect(threadCardSource).toContain("thread-expand-hint");
    expect(styles).toMatch(
      /\.thread-expand-hint\s*{[^}]*color:\s*var\(--ink-faint\);/s,
    );
    expect(styles).toMatch(
      /\.thread-compose textarea\s*{[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);/s,
    );
    expect(styles).toMatch(
      /\.thread-reply-row\s*{[^}]*background:\s*var\(--transparent\);/s,
    );
    // The bespoke comment popover is gone.
    expect(styles).not.toContain(".comment-popover");
  });

  it("anchors threads to highlights with margin cards and compact markers", () => {
    const annotationsSource = readFileSync(
      new URL("./thread-annotations.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // Prose threads highlight the annotated range; the highlight is visual
    // only so the text stays selectable, and clicks are hit-tested.
    expect(annotationsSource).toContain("textRangeClientGeometry");
    expect(annotationsSource).toContain("review-annotation--active");
    expect(annotationsSource).toContain("annotation.rects.some");
    expect(styles).toMatch(
      /\.review-highlight\s*{[^}]*border-bottom:\s*1px solid var\(--highlight-thread-border\);[^}]*border-radius:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.review-highlight\.review-annotation--focused\s*{[^}]*border-bottom-width:\s*2px;[^}]*box-shadow:\s*none;/s,
    );
    // Wide gutters get Google-Docs-style stacked cards; narrow ones get a
    // marker at the line's edge that opens the same card as a popover.
    expect(annotationsSource).toContain("MARGIN_CARDS_MIN_GUTTER");
    expect(annotationsSource).toContain("MARKER_MIN_GUTTER");
    expect(annotationsSource).toContain("review-margin-threads");
    expect(annotationsSource).toContain("cardTops");
    expect(styles).toMatch(/\.thread-marker\s*{[^}]*border-radius:\s*6px;/s);
    expect(styles).toMatch(
      /\.review-margin-threads > \*\s*{[^}]*position:\s*absolute;[^}]*transition:\s*top 160ms ease;/s,
    );
    expect(styles).not.toContain(".review-comment-pin");
  });

  it("keeps node and edge-label text selectable in every diagram", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const sequenceSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const softwareMapSource = readFileSync(
      new URL("./software-map/SoftwareMap.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(styles).toMatch(
      /:is\(\.sequence-diagram, \.software-map-c4-canvas\)\s*:is\(\.react-flow__node, \.react-flow__edgelabel-renderer\)\s*{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/s,
    );
    expect(softwareMapSource).not.toContain("C4NodeLabelOverlay");
    expect(sequenceSource).not.toMatch(
      /<button[\s\S]{0,500}className="sequence-participant-label"/,
    );
    expect(sequenceSource).not.toMatch(
      /<button[\s\S]{0,700}sequence-message-label/,
    );
    expect(softwareMapSource).not.toMatch(
      /<button[\s\S]{0,700}software-map-c4-edge-label/,
    );
    expect(softwareMapSource).toContain('as: Element = "div"');
  });

  it("renders comment threads in the unified side panel", () => {
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewContextSource = readFileSync(
      new URL("./review-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(reviewComponentsSource).toContain("ThreadPanelInner");
    expect(reviewComponentsSource).toContain('className="question-panel"');
    expect(reviewComponentsSource).toContain("<ThreadChat");
    expect(reviewComponentsSource).toContain('className="threads-new-ask"');
    expect(reviewComponentsSource).toContain('panel.kind === "new-ask"');
    // Sidebar rows scroll to and highlight the anchor without opening the
    // inline thread surface; the detail opens in the sidebar itself.
    expect(reviewComponentsSource).toContain(
      "review.focusThread(item.threadId, { scroll: true, inline: false })",
    );
    expect(reviewComponentsSource).toContain("thread-resolved-section");
    expect(reviewContextSource).not.toContain("panelCommentThreadId");
    expect(reviewContextSource).not.toContain("questionSidebarOpen");
    expect(reviewComponentsSource).toContain("await review.askAgent({");
    expect(styles).not.toMatch(/\.question-panel\s*{[^}]*position:\s*fixed;/s);
    expect(styles).toMatch(
      /\.side-panel\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(styles).toMatch(
      /\.review-panel-body\s*{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s,
    );
    expect(styles).not.toMatch(
      /\.thread-panel-body\s*{[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toContain(".thread-chat-transcript");
    expect(styles).toContain(".threads-new-ask");
    expect(styles).toContain(".question-thread-row");
  });

  it("publishes one submission event after pending comments are saved", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const reviewContextSource = readFileSync(
      new URL("./review-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(reviewContextSource).toContain("submissionId: createSubmissionId()");
    expect(reviewContextSource).toContain("const submittedInputs");
    expect(reviewContextSource).toMatch(/reviewFetch\(\s*"\/submissions"/);
    expect(reviewContextSource).toContain("comments: submittedInputs");
    expect(reviewContextSource).toContain(
      "commentStore.completeHumanReviewRound()",
    );
    expect(reviewContextSource).not.toContain(
      "commentStore.reloadPersistedComments()",
    );
    expect(
      reviewContextSource.indexOf("commentStore.completeHumanReviewRound()"),
    ).toBeGreaterThan(reviewContextSource.indexOf("if (!response.ok)"));
    expect(appSource).not.toContain("review-outcome-banner");
    expect(appSource).not.toContain("You can close this tab");
  });

  it("scopes review DOM queries to the active mount", () => {
    const files = [
      "App.tsx",
      "review-components.tsx",
      "review-toc.tsx",
      "sidepeek-thread-ui.tsx",
      "thread-target-model.tsx",
    ];
    const documentScopedReviewQuery =
      /document\.querySelector(?:<[^>]+>)?\(\s*["'`](?:\.review-document(?:-shell)?|\.review-view-region|\.side-panel|\.thread-popover|\.software-map-overlay)/;

    const unscoped = files.filter((file) =>
      documentScopedReviewQuery.test(
        readFileSync(new URL(`./${file}`, import.meta.url), {
          encoding: "utf8",
        }),
      ),
    );

    expect(unscoped).toEqual([]);
  });

  it("submits pending comments without a review waiter gate", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const reviewContextSource = readFileSync(
      new URL("./review-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    // The one-shot server removed the waiter poll and its submit gate entirely:
    // the desktop host is always ready for one submission.
    expect(reviewContextSource).not.toContain("/__progressive-review/waiter");
    expect(reviewContextSource).not.toContain("canSubmitReview");
    expect(appSource).not.toContain("ReviewWaiterStatusIndicator");
    expect(appSource).not.toContain("waitingForWaiter");
    // The topbar Finish review control is the only submit surface; the old
    // bottom pending-review bar is gone.
    expect(appSource).toContain("ReviewCornerAction");
    expect(appSource).not.toContain("topbar-approve-button");
    expect(appSource).not.toContain("PendingReviewBar");
  });

  it("collapses the contents rail by content pane width", () => {
    const tocSource = readFileSync(
      new URL("./review-toc.tsx", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const iconSource = readFileSync(new URL("./icons.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(tocSource).toContain("ContentsIcon");
    expect(tocSource).toContain("review-toc-toggle");
    expect(tocSource).toContain("review-toc--open");
    expect(tocSource).toContain("aria-expanded={isDrawerOpen}");
    expect(tocSource).toContain("setIsDrawerOpen(false)");
    // The rail persists while scrolling on wide shells; narrow shells
    // collapse it into a breadcrumb pill that names the active section,
    // tracked against the top edge of the scroll viewport.
    expect(tocSource).toContain("review-toc--rail");
    expect(tocSource).toContain("ACTIVE_HEADING_TOP_SLACK_PX");
    expect(tocSource).toContain("TOC_COLLAPSE_SCROLL_TOP");
    expect(tocSource).toContain("showRail = !isScrolled && isWide");
    expect(tocSource).toContain("numberReviewTocEntries");
    expect(tocSource).toContain("review-toc-toggle-number");
    expect(iconSource).toContain("function ContentsIcon");
    expect(styles).toMatch(
      /\.review-document-shell\s*{[^}]*container:\s*review-content \/ inline-size;/s,
    );
    expect(styles).toMatch(
      /\.review-toc-toggle\s*{[^}]*position:\s*fixed;[^}]*display:\s*flex;/s,
    );
    expect(styles).toMatch(
      /\.review-toc\s*{[^}]*position:\s*fixed;[^}]*flex:\s*none;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.review-toc--rail\s*{[^}]*border-color:\s*var\(--transparent\);[^}]*background:\s*var\(--transparent\);[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.review-toc--open\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;[^}]*transform:\s*translateX\(0\);/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*1080px\)\s*{[\s\S]*?\.review-view-region--review\s*{[^}]*flex-direction:\s*row;[^}]*padding:\s*var\(--review-page-top\) calc\(24px \+ var\(--review-thread-gutter\)\)\s*120px\s*24px;/s,
    );
    expect(styles).not.toMatch(
      /@media \(max-width:\s*1080px\)\s*{[\s\S]*?\.review-app--theme-light \.review-document/,
    );
  });

  it("lets the Diff view fill its region the way Map does", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.review-diff-view\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.review-diff-view-host\s*{[^}]*grid-row:\s*1;[^}]*min-height:\s*0;[^}]*height:\s*100%;/s,
    );
    expect(styles).not.toMatch(
      /\.review-diff-view\s*{[^}]*padding:\s*var\(--review-page-top\)/s,
    );
  });

  it("aligns the Review page surface while letting Map fill its view", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(/\.review-app\s*{[^}]*--review-page-top:\s*20px;/s);
    expect(styles).toMatch(
      /\.review-view-region--review\s*{[^}]*padding:\s*var\(--review-page-top\) calc\(52px \+ var\(--review-thread-gutter\)\)\s*120px\s*52px;/s,
    );
    expect(styles).not.toMatch(
      /\.review-map-view\s*{[^}]*padding:\s*var\(--review-page-top\)/s,
    );
    expect(styles).toMatch(
      /\.review-map-view\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*background:\s*var\(--map-canvas\);/s,
    );
    expect(styles).toMatch(
      /\.review-map-canvas-shell\s*{[^}]*grid-row:\s*1;[^}]*min-height:\s*0;/s,
    );
    expect(styles).not.toContain("review-map-topology-summary");
    expect(styles).not.toContain("review-map-topology-count");
    expect(styles).toMatch(
      /\.review-map-canvas-shell\s*{[^}]*border:\s*0;[^}]*background:\s*var\(--map-canvas\);[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.software-map-canvas,[\s\S]*?\.review-map-view \.react-flow__pane,[\s\S]*?\.software-map-c4-canvas \.react-flow\s*{[^}]*background:\s*var\(--map-canvas\);/s,
    );
    expect(styles).toContain(".review-segment");
    expect(styles).not.toContain(".review-file-list-shell");
  });

  it("keeps the Review document mounted offscreen while Map is active", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toContain('className="review-document-view"');
    expect(source).toContain('hidden={activeView !== "review"}');
    expect(source).not.toMatch(
      /activeView === "review"\s*&&\s*\(ReviewDocument/,
    );
    expect(styles).toMatch(
      /\.review-document-view\s*{[^}]*display:\s*contents;/s,
    );
    expect(styles).toMatch(
      /\.review-document-view\[hidden\]\s*{[^}]*display:\s*none;/s,
    );
  });

  it("uses a sliders icon for the debug settings trigger", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const iconSource = readFileSync(new URL("./icons.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toContain("<SettingsSlidersIcon />");
    expect(iconSource).toContain('className="review-debug-trigger-icon"');
    expect(iconSource).toContain('<circle cx="9" cy="8" r="2" />');
    expect(iconSource).toContain('<circle cx="15" cy="16" r="2" />');
    expect(iconSource).not.toContain('r="5.25"');
    expect(styles).toMatch(
      /\.review-debug-trigger-icon\s*{[^}]*stroke:\s*currentColor;[^}]*stroke-width:\s*1\.5px;/s,
    );
    expect(styles).not.toContain(".review-debug-trigger::before");
    expect(styles).not.toContain(".review-debug-trigger::after");
  });

  it("floats the map settings over the map canvas and closes them on outside clicks", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // The topbar gear held nothing but map settings, so it went with them.
    expect(source).not.toContain("ReviewSettingsPanel");
    expect(source).not.toContain("review-debug-panel");
    expect(source).toContain("<MapSettingsControl />");
    expect(source).toContain(
      "const controlRef = useRef<HTMLDivElement | null>",
    );
    expect(source).toContain(
      'document.addEventListener("pointerdown", closeOnOutsidePointerDown, true)',
    );
    expect(source).toContain("controlRef.current?.contains(target)");
    // It mounts inside the map canvas shell, which anchors it.
    expect(source.indexOf("<MapSettingsControl />")).toBeGreaterThan(
      source.indexOf('className="review-map-canvas-shell"'),
    );
    expect(styles).toMatch(
      /\.review-map-canvas-shell\s*{[^}]*position:\s*relative;/s,
    );
    expect(styles).toMatch(
      /\.map-settings-control\s*{[^}]*position:\s*absolute;/s,
    );
  });

  it("keeps every map control in the floating popover", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).not.toContain('aria-label="Theme"');
    expect(source).not.toContain('label="C4 compact label size"');
    expect(source).toContain('label="Show modified nodes only"');
    expect(source).toContain('label="Show removed nodes"');
    expect(source).toContain('aria-label="Node tint"');
    expect(source.indexOf('label="Show modified nodes only"')).toBeGreaterThan(
      source.indexOf('aria-label="Map settings"') -
        source.indexOf('aria-label="Map settings"'),
    );
  });

  it("leaves resolved CodePeek identity and stats to the native editor header", () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: { file: "src/example.ts", fromLine: 1, toLine: 3, graph: "base" },
      resolution: {
        snapshot: {
          roots: [
            {
              kind: "source",
              sourceId: "source-range:src/old.ts:12-14",
            },
          ],
          resolved: {
            "source-range:src/old.ts:12-14": {
              source: {
                id: "source-range:src/old.ts:12-14",
                name: "old.ts L12-L14",
                kind: "source-range",
                file: "src/old.ts",
                line: 12,
                endLine: 14,
              },
              lines: [[{ t: "SECRET_SNAPSHOT_SOURCE", k: "t" }]],
            },
          },
        },
        diff: {
          orientation: "base",
          files: [
            {
              path: "src/new.ts",
              previousPath: "src/old.ts",
              status: "renamed",
              additions: 4,
              deletions: 2,
              patch: "SECRET_PATCH_SOURCE",
            },
          ],
        },
      },
    });
    const html = renderWithTestSession(createElement(CodePeekCard, { input }));

    expect(html).toContain('data-code-rendering="inline-editor"');
    expect(html).not.toContain("code-peek-card");
    expect(html).not.toContain("ReviewWorkbench");
    expect(html).not.toContain("src/old.ts:12–14");
    expect(html).not.toContain("src/old.ts → src/new.ts");
    expect(html).not.toContain("diff counts");
    expect(html).not.toContain("SECRET_SNAPSHOT_SOURCE");
    expect(html).not.toContain("SECRET_PATCH_SOURCE");
  });

  it("renders a no-diff CodePeek without a duplicate React header", () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: { file: "src/unchanged.ts", fromLine: 8, toLine: 8 },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });
    const html = renderWithTestSession(createElement(CodePeekCard, { input }));

    expect(html).toContain('data-review-inline-editor="src/unchanged.ts"');
    expect(html).not.toContain("code-peek-card");
    expect(html).not.toContain("src/unchanged.ts:8");
    expect(html).not.toContain("Open in editor");
    expect(html).not.toContain("diff counts");
  });

  it("keeps CodePeek source rendering and obsolete settings out of the canvas", () => {
    const codePeekSource = readFileSync(
      new URL("./CodePeek.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const debugSource = readFileSync(
      new URL("./debug-settings.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const authoringSource = readFileSync(
      new URL("./review-definition-runtime.ts", import.meta.url),
      { encoding: "utf8" },
    );

    expect(codePeekSource).not.toContain("RenderedCodeBlock");
    expect(codePeekSource).not.toContain("PanelCodeSurface");
    expect(codePeekSource).not.toContain("codePeekPatchLines");
    expect(codePeekSource).not.toContain("CodePeekSnippetView");
    expect(codePeekSource).toContain("includeDiff: false");
    expect(codePeekSource).toContain("<InlineCodeEditor");
    expect(reviewComponentsSource).toContain("<CodePeekCard");
    expect(reviewComponentsSource).toContain("input={content.input}");
    expect(reviewComponentsSource).toContain("active={active}");
    expect(reviewComponentsSource).toContain(
      "onActiveAnchorChange(stop.anchor.id, { reveal: false })",
    );
    expect(reviewComponentsSource).toContain("onNativeFocus={onNativeFocus}");
    expect(reviewComponentsSource).not.toContain(
      "nativeAnchorForAuthoredAnchor",
    );
    expect(reviewComponentsSource).not.toContain("<CodePeekView");
    expect(debugSource).not.toContain("showCodePeekDiffs");
    expect(appSource).not.toContain("showCodePeekDiffs");
    expect(authoringSource).toContain("const includeDiff = false;");
  });

  it("keeps review document and diagram structure shared across themes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const softwareMapStyles = readFileSync(
      new URL("./software-map/styles.css", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const stylesBeforeMobileSheetRules = styles.slice(
      0,
      styles.indexOf("@media (max-width: 720px)"),
    );

    // The bridged value itself is pinned by the ground-bridge test above; here
    // it only matters that the light palette declares the token at all.
    expect(styles).toMatch(/\.review-app--theme-light\s*{[^}]*--surface:/is);
    expect(styles).toMatch(/\.review-app\s*{[^}]*color-scheme:\s*dark;/s);
    expect(styles).toMatch(
      /\.review-app--theme-light\s*{[^}]*color-scheme:\s*light;/s,
    );
    const forbiddenThemeDescendantRules = [
      ...styles.matchAll(
        /\.review-app--theme-light(?!\s*\{|\.review-app--tint-)[^{]*\{/g,
      ),
    ].map((match) => match[0]);
    expect(forbiddenThemeDescendantRules).toEqual([]);
    expect(softwareMapStyles).not.toContain(".review-app--theme-light");
    expect(styles).toMatch(
      /\.sequence-diagram,\s*\.database-lens\s*{[^}]*background:\s*var\(--diagram-surface\);/s,
    );
    expect(styles).toMatch(
      /\.diagram-header,[\s\S]*?\.sequence-diagram figcaption\.diagram-header\s*{[^}]*background:\s*var\(--diagram-header-bg\);/s,
    );
    expect(styles).toMatch(
      /\.sequence-diagram \.react-flow,\s*\.database-diagram-canvas \.react-flow\s*{[^}]*background:\s*var\(--diagram-canvas-bg\);/s,
    );
    expect(styles).toMatch(
      /\.review-document\s*{[^}]*--review-document-padding-inline:\s*clamp\(\s*20px,[^}]*calc\(\(100cqi - 720px\) \* 0\.122 \+ 20px\),[^}]*64px[^}]*\);[^}]*--review-prose-max-width:\s*720px;[^}]*max-width:\s*860px;[^}]*padding:\s*var\(--review-document-padding-block-start\)\s*var\(--review-document-padding-inline\)\s*var\(--review-document-padding-block-end\);/s,
    );
    expect(styles).toMatch(
      /\.review-document\s*{[^}]*--review-inline-diagram-max-width:\s*1120px;/s,
    );
    expect(styles).toMatch(
      /\.review-app--peek-open \.review-document\s*{[^}]*--review-inline-diagram-max-width:\s*1000px;/s,
    );
    expect(styles).toMatch(
      /\.review-document[\s\S]*?:is\(\.sequence-diagram, \.database-lens, \.software-map\)\s*{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(\s*var\(--review-inline-diagram-max-width\),\s*calc\(\s*100cqi - var\(--review-document-padding-inline\) -\s*var\(--review-document-padding-inline\)\s*\)\s*\);[^}]*margin-inline:\s*auto;/s,
    );
    // Sequence diagrams no longer widen the document: they share the prose
    // measure, and the fullscreen overlay is the escape hatch for more room.
    expect(styles).not.toContain(":has(.sequence-diagram)");
    const reviewSequenceDiagramRule = styles.match(
      /\.review-document \.sequence-diagram\s*{(?<body>[^}]*)}/,
    )?.groups?.body;
    // Lanes spread to fill the prose-width frame (see the laneWidth
    // derivation in diagrams.tsx).
    expect(reviewSequenceDiagramRule).toMatch(/width:\s*100%;/);
    expect(reviewSequenceDiagramRule).toMatch(
      /max-width:\s*min\(\s*var\(--review-prose-max-width\),\s*calc\(\s*100cqi - var\(--review-document-padding-inline\) -\s*var\(--review-document-padding-inline\)\s*\)\s*\);/s,
    );
    expect(stylesBeforeMobileSheetRules).not.toMatch(
      /@container review-content \(max-width:\s*1080px\)\s*{[\s\S]*?\.review-document[\s\S]*?:is\(\.sequence-diagram, \.database-lens, \.software-map\)\s*{[^}]*width:/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*1080px\)\s*{[\s\S]*?\.review-document\s*{[^}]*padding:\s*28px var\(--review-document-padding-inline\);/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*1080px\)\s*{[\s\S]*?\.review-document\s*{[^}]*max-width:\s*860px;/s,
    );
    expect(styles).not.toContain("padding: 28px 24px");
    expect(styles).not.toContain("--review-inline-diagram-gutter");
    expect(styles).not.toMatch(
      /\.review-document[\s\S]*?:is\(\.sequence-diagram, \.database-lens, \.software-map\)\s*{[^}]*transform:\s*translateX\(-50%\);/s,
    );
    expect(styles).toMatch(
      /\.review-document\s*{[^}]*background:\s*var\(--transparent\);[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.sequence-message-label\s*{[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).toMatch(/\.sequence-diagram\s*{[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(
      /\.sequence-diagram > \.diagram-header em\s*{[^}]*background:\s*var\(--bg-2\);[^}]*color:\s*var\(--ink-soft\);/s,
    );
    expect(styles).not.toContain(".tour-status");
    expect(styles).not.toContain(".tour-progress");
    expect(styles).not.toContain(".tour-feed-spacer");
    expect(styles).not.toContain(".tour-pill-bar");
    expect(styles).not.toContain(".tour-feed-fade");
    expect(styles).not.toContain("scroll-snap");
    expect(reviewComponentsSource).toContain("setTailHeight(");
    expect(reviewComponentsSource).toContain('className="tour-scroll-tail"');
    expect(styles).toMatch(
      /\.side-peek-body\.tour-feed\s*{[^}]*padding:\s*0 0 72px;[^}]*scroll-padding-bottom:\s*72px;/s,
    );
    expect(styles).toMatch(
      /\.tour-floating-footer\s*{[^}]*position:\s*absolute;[^}]*bottom:\s*12px;[^}]*display:\s*flex;[^}]*justify-content:\s*center;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.tour-floating-footer \.tour-pill\s*{[^}]*pointer-events:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.tour-pill\s*{(?![^}]*position:\s*absolute)[^}]*border-radius:\s*999px;/s,
    );
    expect(styles).toMatch(
      /\.tour-end-cap\s*{[^}]*border:\s*1px dashed var\(--rule-soft\);/s,
    );
    expect(styles).toMatch(
      /\.tour-stop-main > \.peek-content\s*{[^}]*width:\s*calc\(100% \+ var\(--tour-rail-breakout\)\);[^}]*margin-left:\s*calc\(-1 \* var\(--tour-rail-breakout\)\);/s,
    );
    expect(styles).toMatch(
      /\.tour-stop-rail div\s*{(?![^}]*position:\s*sticky)[^}]*display:\s*grid;[^}]*place-items:\s*center;/s,
    );
    expect(styles).toMatch(/\.side-peek-body\s*{[^}]*padding:\s*12px;/s);
    expect(styles).toMatch(
      /\.tour-stop\s*{[^}]*--tour-rail-breakout:\s*50px;[^}]*padding-right:\s*16px;/s,
    );
    expect(styles).toMatch(
      /\.sequence-diagram,\s*\.database-lens\s*{[^}]*background:\s*var\(--diagram-surface\);/s,
    );
    expect(styles).toMatch(
      /\.review-document p,\s*\.review-document li\s*{[^}]*font-size:\s*15px;[^}]*line-height:\s*1\.72;/s,
    );
    expect(styles).not.toContain(".review-document h1 + p");
    expect(styles).not.toContain(".review-document h1 + p code");
  });

  it("passes the active review theme through every React Flow surface", () => {
    const diagramsSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      "utf8",
    );
    const softwareMapSource = readFileSync(
      new URL("./software-map/SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(diagramsSource).toContain(
      "const { theme } = useReviewDebugSettings()",
    );
    expect(diagramsSource).toContain("colorMode={theme}");
    expect(softwareMapSource).toContain(
      "const { theme } = useReviewDebugSettings()",
    );
    expect(softwareMapSource).toContain("colorMode={theme}");
  });

  it("keeps markdown code blocks on the prose measure and highlights explicit languages", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const documentSurfaceSource = readFileSync(
      new URL("./review-document-surface.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const codeBlockSource = readFileSync(
      new URL("./code-block.tsx", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const packageJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      {
        encoding: "utf8",
      },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(packageJson).toContain('"@speed-highlight/core": "1.2.15"');
    expect(codeBlockSource).toContain("tokenize(code, normalizedLanguage");
    expect(codeBlockSource).not.toContain("dangerouslySetInnerHTML");
    expect(codeBlockSource).toContain("function normalizeMarkdownCodeLanguage");
    expect(documentSurfaceSource).toContain("pre: MarkdownCodeBlock");
    expect(appSource).not.toContain("detectLanguage");
    expect(codeBlockSource).not.toContain("detectLanguage");
    expect(styles).toMatch(
      /\.review-document > p,[\s\S]*?\.review-document > \.code-peek,[\s\S]*?\.review-section-body > \.code-peek\s*{[^}]*width:\s*min\(100%,\s*var\(--review-prose-max-width\)\);[^}]*max-width:\s*calc\(\s*100cqi - var\(--review-document-padding-inline\) -\s*var\(--review-document-padding-inline\)\s*\);[^}]*margin-inline:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.review-document pre\.markdown-code-block\s*{[^}]*overflow-x:\s*auto;[^}]*border-radius:\s*8px;/s,
    );
    expect(styles).toMatch(
      /\.review-document pre\.markdown-code-block code\s*{[^}]*background:\s*var\(--transparent\);[^}]*white-space:\s*pre;/s,
    );
    expect(styles).toContain(".markdown-code-block .shj-syn-kwd");
    expect(styles).toMatch(
      /\.rendered-code-block\[data-language\]::before\s*{[^}]*content:\s*attr\(data-language\);/s,
    );
  });

  it("keeps the sequence header outside the scroll viewport", () => {
    const diagramsSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    // Lanes spread across the measured diagram width, never below the 176px
    // floor that keeps dense diagrams scrolling horizontally instead.
    expect(diagramsSource).toContain("const laneWidth = Math.max(");
    expect(diagramsSource).toContain("176,");
    expect(diagramsSource).toContain(
      "Math.floor(availableWidth / Math.max(1, sequence.participants.length))",
    );
    expect(diagramsSource).toContain("const messageTop = 112");
    expect(diagramsSource).toContain("const messageGap = 76");
    expect(diagramsSource).toContain('"--sequence-height": `${height}px`');
    expect(diagramsSource).toContain("const sequenceScrollRef = useRef");
    expect(diagramsSource).toContain('className="sequence-diagram-body"');
    expect(diagramsSource).toContain("ref={sequenceScrollRef}");
    expect(diagramsSource).toContain(
      'scroll.addEventListener("wheel", scrollSequenceHorizontally',
    );
    expect(diagramsSource).toContain("passive: false");
    expect(diagramsSource).toContain("scroll.scrollLeft = nextLeft");
    expect(diagramsSource).toContain("sequenceScrollRef.current");
    expect(diagramsSource).toContain(
      'behavior: panelMotion === "restored" ? "auto" : "smooth"',
    );
    expect(diagramsSource).toContain("sequenceActiveMessageScrollTopTarget");
    expect(diagramsSource).not.toContain("figure.scrollLeft = nextScrollLeft");
    expect(diagramsSource).not.toContain("sequence-diagram-scroll");
    expect(diagramsSource.indexOf("<DiagramHeader")).toBeLessThan(
      diagramsSource.indexOf('className="sequence-diagram-body"'),
    );
    expect(styles).toMatch(
      /\.sequence-diagram\s*{[^}]*height:\s*auto;[^}]*max-height:\s*calc\(100dvh - 160px\);/s,
    );
    expect(styles).toMatch(/\.sequence-diagram\s*{[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(
      /\.sequence-diagram-body\s*{[^}]*overflow:\s*auto;/s,
    );
    // No overscroll-behavior on the diagram body: Chrome latches wheel
    // gestures to the nearest scroll container even when it cannot scroll,
    // and `contain` would stop the page from scrolling under the cursor.
    expect(styles).not.toMatch(
      /\.sequence-diagram-body\s*{[^}]*overscroll-behavior:/s,
    );
    // The fullscreen overlay stays inside the Canvas container. This keeps
    // scoped styles attached while fixed positioning covers the Canvas view.
    expect(styles).toMatch(
      /\.diagram-tour-overlay\s*{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*z-index:\s*var\(--review-debug-layer, 2147483000\);/s,
    );
    expect(diagramsSource).toContain("createPortal(");
    expect(diagramsSource).not.toContain(
      'document.querySelector(".review-canvas-root") ?? document.body',
    );
    const diagramTourSource = readFileSync(
      new URL("./diagram-tour.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    expect(diagramTourSource).toContain(
      "diagram-tour-overlay review-app--theme",
    );
    expect(diagramTourSource).toContain("aria-label={");
    expect(diagramTourSource).toContain(
      "const portalTarget = useReviewContainer();",
    );
    expect(diagramTourSource).toContain("<GuidedTourPanel");
    expect(styles).toMatch(
      /\.sequence-diagram \.react-flow\s*{[^}]*width:\s*max\(100%,\s*var\(--sequence-width\)\);[^}]*height:\s*var\(--sequence-height\);[^}]*min-width:\s*var\(--sequence-width\);/s,
    );
    expect(styles).toMatch(
      /\.sequence-participant-label\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
  });

  it("wraps sequence message labels instead of truncating them", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });
    const messageLabelRule = styles.match(
      /\.sequence-message-label\s*{(?<body>[^}]*)}/,
    )?.groups?.body;

    expect(messageLabelRule).toContain("overflow-wrap: anywhere;");
    expect(messageLabelRule).toContain("white-space: normal;");
    expect(messageLabelRule).toContain("line-height: 14px;");
    expect(messageLabelRule).not.toContain("text-overflow: ellipsis;");
    expect(messageLabelRule).not.toContain("white-space: nowrap;");
  });

  it("exposes guided tour buttons in diagram headers", () => {
    const diagramsSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const databaseLensSource = readFileSync(
      new URL("./database-lens.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(diagramsSource).toContain('className="diagram-tour-button"');
    expect(diagramsSource).toContain("openTour();");
    expect(databaseLensSource).toContain('className="diagram-tour-button"');
    expect(databaseLensSource).toContain("openLensTour();");
    expect(databaseLensSource).toContain("<DiagramTourOverlay");
    expect(styles).toMatch(
      /\.diagram-header-actions\s*{[^}]*display:\s*inline-flex;/s,
    );
    expect(styles).toMatch(/\.diagram-tour-button\s*{[^}]*height:\s*26px;/s);
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*760px\)\s*{[\s\S]*?\.database-lens-header \.diagram-header-actions\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/s,
    );
    expect(styles).toMatch(
      /@container review-content \(max-width:\s*760px\)\s*{[\s\S]*?\.database-use-case-select-target\s*{[^}]*width:\s*auto;[^}]*min-width:\s*0;/s,
    );
  });

  it("owns every panel mode in one document-scoped store and host", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const panelSource = readFileSync(
      new URL("./review-panel.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const panelStoreSource = readFileSync(
      new URL("./review-panel-store.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const diagramsSource = readFileSync(
      new URL("./diagrams.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const databaseLensSource = readFileSync(
      new URL("./database-lens.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(panelStoreSource).toContain('kind: "peek"');
    expect(panelStoreSource).toContain('kind: "tour"');
    expect(panelStoreSource).toContain('kind: "threads"');
    expect(panelStoreSource).toContain('kind: "commentThread"');
    expect(panelStoreSource).not.toContain('kind: "questionThread"');
    expect(panelSource).toContain("useState(createReviewPanelStore)");
    expect(appSource).toContain("<ReviewPanelHost />");
    expect(appSource).not.toContain("<QuestionDialog />");
    expect(reviewComponentsSource).toContain(
      "export function ReviewPanelHost()",
    );
    expect(reviewComponentsSource).not.toContain("ReviewDetailPortal");
    expect(diagramsSource).not.toContain("ownerId");
    expect(databaseLensSource).not.toContain("ownerId");
    expect(diagramsSource).not.toContain("scrollIntoView");
    expect(diagramsSource).not.toContain("focusTarget.focus");
  });

  it("opens normal markdown links in a new tab while keeping hash links in page", () => {
    const linkPropsSource = readFileSync(
      new URL("./link-props.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const reviewComponentsSource = readFileSync(
      new URL("./review-components.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(linkPropsSource).toContain("function newTabLinkProps");
    expect(linkPropsSource).toContain('href.startsWith("#")');
    expect(linkPropsSource).toContain('target: props.target ?? "_blank"');
    expect(linkPropsSource).toContain(
      'rel: appendRelTokens(props.rel, ["noopener", "noreferrer"])',
    );
    expect(reviewComponentsSource).toContain("newTabLinkProps(");
    expect(reviewComponentsSource).not.toContain("review://anchor/");
  });

  it("delegates the full and scoped Diff views to the native bridge", () => {
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const diffViewSource = readFileSync(
      new URL("./DiffView.tsx", import.meta.url),
      { encoding: "utf8" },
    );
    const contextSource = readFileSync(
      new URL("./review-diff-files-context.tsx", import.meta.url),
      { encoding: "utf8" },
    );

    expect(contextSource).toContain("parseReviewDiffFilesResponse");
    expect(contextSource).toContain("includePatch: false");
    // The canvas never renders diff text itself: the workbench mounts its own
    // widgets into the container this component hands it.
    expect(appSource).toContain("<ReviewDiffView");
    expect(appSource).toContain(
      "scope={diffScope ? { commit: diffScope.commit } : undefined}",
    );
    expect(diffViewSource).toContain("session.bridge.diffView");
    expect(contextSource).not.toContain("includePatch: true");
  });
});

/**
 * The reserved gutter in styles.css and the card constants above are two halves
 * of one geometry. These tests re-derive the stylesheet's numbers from the
 * stylesheet's own layout values plus MARGIN_CARDS_MIN_GUTTER, so changing
 * either half without the other fails here rather than silently pushing every
 * reader back into markers mode.
 */
describe("reserved thread gutter", () => {
  const styles = readFileSync(new URL("./styles.css", import.meta.url), {
    encoding: "utf8",
  });

  // The operative `.review-document` rule is the one that declares the prose
  // measure; an earlier legacy block reuses the same selector.
  const ruleContaining = (selector: string, declaration: string): string =>
    new RegExp(`\\n\\.${selector}\\s*{([^}]*?${declaration}[^}]*?)\\n}`).exec(
      styles,
    )?.[1] ?? "";
  const documentRule = ruleContaining(
    "review-document",
    "--review-prose-max-width",
  );
  const regionRule = ruleContaining(
    "review-view-region--review",
    "--review-thread-gutter",
  );
  const px = (source: string, pattern: RegExp): number => {
    const match = pattern.exec(source);
    if (!match) throw new Error(`expected ${pattern} in stylesheet`);
    return Number(match[1]);
  };

  const documentMaxWidth = px(documentRule, /\n\s*max-width:\s*(\d+)px;/);
  const proseMaxWidth = px(
    documentRule,
    /--review-prose-max-width:\s*(\d+)px;/,
  );
  const regionPadding = px(
    regionRule,
    /padding:\s*var\(--review-page-top\) calc\((\d+)px \+/,
  );
  const [threshold, squeeze, cap] = (() => {
    const match =
      /--review-thread-gutter:\s*clamp\(\s*0px,\s*min\((\d+)px - 100cqi,\s*100cqi - (\d+)px\),\s*(\d+)px\s*\)/.exec(
        styles,
      );
    if (!match)
      throw new Error("expected --review-thread-gutter in stylesheet");
    return match.slice(1).map(Number);
  })();

  it("derives the reserve from the thread constants", () => {
    // The prose measure is centred in the region, so the gutter the annotation
    // layer sees is (R - proseMaxWidth) / 2 + reserve / 2: the reserve covers
    // twice the shortfall against the card threshold...
    expect(threshold).toBe(2 * MARGIN_CARDS_MIN_GUTTER + proseMaxWidth);
    // ...but never so much that the document itself has to narrow.
    expect(squeeze).toBe(documentMaxWidth + 2 * regionPadding);
    expect(cap).toBe(MARGIN_CARDS_MIN_GUTTER);
  });

  it("keeps the card height estimate in step with the rendered body", () => {
    // threadFitsExpandedCard measures in the stylesheet's units; if the body's
    // line-height moves, the estimate silently mis-sizes every card.
    expect(styles).toMatch(
      new RegExp(
        `\\.thread-message-body\\s*{[^}]*line-height:\\s*${CARD_BODY_LINE_HEIGHT}px;`,
        "s",
      ),
    );
  });

  it("puts common window widths in the expected thread mode", () => {
    const modeAt = (region: number) => {
      const gutter = Math.min(
        cap,
        Math.max(0, Math.min(threshold - region, region - squeeze)),
      );
      const available = (region - proseMaxWidth) / 2 + gutter / 2;
      return gutterForAvailable(available, 700);
    };

    expect(modeAt(1000).mode).toBe("markers");
    expect(modeAt(1100).mode).toBe("markers");
    // The reserve holds the card at its minimum across the band where the
    // window alone could not afford one (unreserved, cards needed ~1400).
    for (const region of [1180, 1240, 1320, 1392]) {
      expect(modeAt(region), `region ${region}`).toMatchObject({
        mode: "cards",
        width: CARD_MIN_WIDTH,
      });
    }
    // Past the band the reserve is gone and cards simply fill the gutter.
    expect(modeAt(1600).width).toBeGreaterThan(modeAt(1440).width);
    expect(modeAt(3000)).toMatchObject({
      mode: "cards",
      width: CARD_MAX_WIDTH,
    });
  });
});
