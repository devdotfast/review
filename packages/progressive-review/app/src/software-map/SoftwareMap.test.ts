import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  C4_MAP_HOTKEY_GROUPS,
  c4MapReactFlowInteractionProps,
} from "./software-map-keyboard-navigation";

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from === -1) throw new Error(`marker not found: ${start}`);
  if (to === -1) throw new Error(`marker not found: ${end}`);
  if (to < from) throw new Error(`markers out of order: ${start} after ${end}`);
  return source.slice(from, to);
}

describe("SoftwareMap inline C4 helpers", () => {
  it("lets page wheel scrolling pass through inline C4 canvases", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(c4MapReactFlowInteractionProps("inline")).toEqual({
      panOnScroll: false,
      preventScrolling: false,
      zoomOnPinch: false,
      zoomOnScroll: false,
    });
    expect(source).toContain(
      'interactionMode={showChrome ? "inline" : "standalone"}',
    );
  });

  it("resets figure margin so expanded maps stay inside the viewport", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(/\.software-map-frame\s*{[^}]*\bmargin:\s*0;/s);
  });

  it("drives expanded map overlay background from theme tokens", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-overlay\s*{[^}]*background:\s*var\(--bg\);/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-overlay\s*{[^}]*background:\s*#[0-9a-f]{3,8}/is,
    );
  });

  it("keeps the expanded map overlay above the sticky topbar", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    // The topbar sits at --review-debug-layer; the overlay portals to the end
    // of <body>, so an equal z-index paints it (and its close button) on top.
    // The variable is scoped to .review-app, which the body-level portal never
    // inherits from, so the rule must carry a literal fallback.
    expect(styles).toMatch(
      /\.software-map-overlay\s*{[^}]*z-index:\s*var\(--review-debug-layer,\s*2147483000\);/s,
    );
  });

  it("stacks C4 groups below relationship edges and cards", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__node-softwareMapC4Group\s*{[^}]*\bz-index:\s*0 !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__edges\s*{[^}]*\bz-index:\s*1;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__node-softwareMapC4\s*{[^}]*\bz-index:\s*2 !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas\s*\.react-flow__node-softwareMapC4:has\(\s*\.software-map-c4-node-shell:hover > \.comment-hover-button\s*\)\s*{[^}]*\bz-index:\s*40 !important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-canvas \.react-flow__node[^,{]*:hover\s*{[^}]*\bz-index:/s,
    );
    expect(styles).not.toMatch(
      /\.react-flow__node-softwareMapC4Group:has\([^)]*comment-hover-button[^)]*\)\s*{[^}]*\bz-index:/s,
    );
  });

  it("uses shared map panel surfaces for expanded group shells", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-group-shell\s*{[^}]*border:\s*1px solid var\(--map-line-2\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-group-shell--softwareSystem\s*{[^}]*background:\s*var\(--map-panel-1\)/s,
    );
    expect(styles).not.toMatch(
      /--software-map-c4-group-border|#f5b97c|#7c9cf5|#8ab7c6|#6fc7a8|#b6a8f5/i,
    );
  });

  it("renders data stores as flat map cards", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node,\s*\.software-map-c4-node-shell > \.software-map-node,\s*\.software-map-c4-node-shell > \.software-map-node--codeElement,\s*\.software-map-c4-node-shell > \.software-map-node--dataStore,\s*\.software-map-node--codeElement,\s*\.software-map-node--dataStore\s*{[^}]*padding:\s*12px 14px !important;[^}]*border:\s*1px solid var\(--map-card-line\) !important;[^}]*border-radius:\s*10px !important;[^}]*background:\s*var\(--map-card\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-node--dataStore::before|\.software-map-node--dataStore::after/s,
    );
    expect(styles).toMatch(
      /\.software-map-node-storage-outline,\s*\.software-map-node-storage-folder,\s*\.software-map-node--codeElement::before\s*{[^}]*display:\s*none !important;/s,
    );
  });

  it("renders inline C4 code nodes as compact monospace symbol headers", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bmin-height:\s*34px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bmax-width:\s*420px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--codeElement\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head code\s*{[^}]*font-family:\s*"Geist Mono", ui-monospace, monospace;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head code\s*{[^}]*\bflex:\s*0 1 auto;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head \.software-map-change-badge\s*{[^}]*\bwidth:\s*auto;/s,
    );
  });

  it("measures ordinary inline C4 nodes to their content width", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-measure-node\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bmin-height:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bmax-width:\s*340px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--dataStore\s*{[^}]*\bwidth:\s*280px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--dataStore > \.software-map-node\s*{[^}]*\bwidth:\s*100%;/s,
    );
  });

  it("renders schema collection nodes without duplicate outer card chrome", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection\s*{[^}]*\bborder-width:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection\s*{[^}]*\bbackground:\s*var\(--transparent\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection \.software-map-node-kicker,\s*\.software-map-node--dataStoreCollection \.software-map-node-label--world,[^{]+{[^}]*\bdisplay:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection \.software-map-data-store-schema\s*{[^}]*\bmargin:\s*0;/s,
    );
  });

  it("overlays map status messages without resizing the canvas", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-status\s*{[^}]*\bposition:\s*absolute;/s,
    );
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\btop:\s*14px;/s);
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\bleft:\s*14px;/s);
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\bmargin:\s*0;/s);
  });

  it("hides map floating refresh actions while a side peek is open", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.review-app--peek-open\s+\.software-map-floating-actions\s*{[^}]*display:\s*none;/s,
    );
  });

  it("keeps C4 graph layout swaps atomic while new snapshots are measured", () => {
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const canvasSource = sourceBetween(
      source,
      "function C4MapCanvas",
      "function c4MeasurementKey",
    );

    expect(canvasSource).toContain("C4DisplayedLayoutState");
    expect(canvasSource).toContain("displayedSnapshot");
    expect(canvasSource).toContain("measuredNodes");
    expect(canvasSource).toContain("layoutSnapshot");
    expect(canvasSource).toContain("setLayoutState({");
    expect(canvasSource).toContain("Refreshing layout...");
    expect(canvasSource).toMatch(
      /createC4MapFlowFromLayout\(displayedSnapshot,\s*layout,/s,
    );
    expect(canvasSource).toMatch(
      /<C4NodeMeasurementLayer\s+nodes={measuredNodes}/s,
    );
  });

  it("keeps hidden C4 measurement nodes off the live ResizeObserver loop", () => {
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const measurementLayerSource = sourceBetween(
      source,
      "function C4NodeMeasurementLayer",
      "function SoftwareMapC4Edge",
    );

    expect(measurementLayerSource).not.toContain("new ResizeObserver");
  });

  it("styles selected node diffs as embedded CodePeek panels", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-body--with-inspector\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 10px\s*var\(--software-map-inspector-width,\s*420px\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-resizer\s*{[^}]*min-height:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-header\s*{[^}]*justify-content:\s*space-between;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-title strong\s*{[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-actions\s*{[^}]*display:\s*flex;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-diffs\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(source).toContain("useRightPanelResize");
    expect(source).toContain('label: "Resize code inspector"');
    expect(source).toContain('? "code-inspector-width-expanded"');
    expect(source).toContain(': "code-inspector-width"');
    expect(source).toContain(
      'className="side-panel-resizer software-map-code-inspector-resizer"',
    );
    expect(source).toContain('aria-label="Close code inspector"');
    expect(source).toContain('"Collapse all diffs"');
    expect(source).toContain('"codicon-fold"');
    expect(source).toContain('"codicon-unfold"');
    expect(source).toContain("additions={node.additions}");
    expect(source).toContain("deletions={node.deletions}");
    expect(source).toContain("softwareMapNodeTypeLabel(node)");
    expect(source).toContain(
      "<strong title={node.label}>{node.label}</strong>",
    );
    expect(source).toContain("onCloseCodeInspector={handleCloseCodeInspector}");
    expect(source).toContain("softwareMapNodeDiffPeeks({");
    expect(source).toContain(
      "<CodePeekGroup peeks={diffPeeks} collapsed={diffsCollapsed} />",
    );
    expect(source).not.toContain('theme="dark"');
  });

  it("keeps SoftwareMap minimaps on the active theme tokens", () => {
    const softwareMapSource = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(softwareMapSource).toContain('maskColor="var(--minimap-mask)"');
    expect(softwareMapSource).toContain('maskStrokeColor="var(--rule-soft)"');
    expect(softwareMapSource).toContain('backgroundColor: "var(--surface)"');
    expect(softwareMapSource).toContain('border: "1px solid var(--rule)"');
    expect(softwareMapSource).toContain("nodeStrokeColor=");
    expect(softwareMapSource).toContain('"var(--selection)"');
    expect(softwareMapSource).toContain('"var(--rule-soft)"');
  });

  it("renders software map hotkeys as a shallow bottom tab", () => {
    const softwareMapSource = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const hotkeysSource = readFileSync(
      new URL("./hotkeys-tab.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(softwareMapSource).toContain("<SoftwareMapHotkeysTab");
    expect(softwareMapSource).toContain("groups={C4_MAP_HOTKEY_GROUPS}");
    expect(hotkeysSource).toContain(
      'aria-label="Minimize software map hotkeys"',
    );
    expect(hotkeysSource).toContain('aria-label="Show software map hotkeys"');
    expect(hotkeysSource).toContain("stopSoftwareMapHotkeysKeyDown");
    expect(styles).toMatch(
      /\.software-map-code-hotkeys\s*{[^}]*bottom:\s*0;[^}]*left:\s*50%;[^}]*height:\s*30px;/s,
    );
    expect(styles).toContain(
      "width: var(--software-map-hotkeys-width, max-content);",
    );
    expect(styles).toContain("max-width: calc(100% - 24px);");
    expect(styles).toContain("width 180ms cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(
      /\.software-map-code-hotkeys\s*{[^}]*border-radius:\s*8px 8px 0 0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-hotkeys-strip\s*{[^}]*overflow-x:\s*auto;/s,
    );
    expect(C4_MAP_HOTKEY_GROUPS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "c4-navigation",
          items: expect.arrayContaining([
            expect.objectContaining({
              keys: ["h", "j", "k", "l", "Arrows"],
              label: "select",
            }),
            expect.objectContaining({ keys: ["f"], label: "fit" }),
          ]),
        }),
        expect.objectContaining({
          id: "c4-structure",
          items: expect.arrayContaining([
            expect.objectContaining({ keys: ["Enter"], label: "expand/drill" }),
            expect.objectContaining({ keys: ["Tab"], label: "toggle" }),
            expect.objectContaining({ keys: ["Esc"], label: "parent" }),
          ]),
        }),
      ]),
    );
  });

  it("uses single-tone accent borders for selected map nodes", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node\.selected,\s*\.software-map-node\.selected\.software-map-node--added,\s*\.software-map-node\.selected\.software-map-node--removed,\s*\.software-map-node\.selected\.software-map-node--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*background:\s*var\(--map-active-fill\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-group-shell\.selected,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--added,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--removed,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*background:\s*var\(--map-active-fill\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--added\s*{[^}]*border:\s*1\.5px solid var\(--map-added\) !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--modified\s*{[^}]*border:\s*1\.5px solid var\(--map-changed\) !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--removed\s*{[^}]*border:\s*1\.5px dashed var\(--map-removed\) !important;[^}]*opacity:\s*0\.75;/s,
    );
    expect(styles).not.toMatch(/0 0 0 [23]px var\(--selection\)/);
  });

  it("keeps connection handles hidden and renders always-visible source bubbles", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-handle\s*{[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-(?:node|group)-shell:hover\s+\.software-map-c4-handle/,
    );
    expect(source).toMatch(/c4EdgeEndpointBubbles\(\s*points,/);
    expect(source).toContain('"software-map-c4-edge-endpoint"');
    expect(source).not.toMatch(/endpoint:\s*"target"/);
    expect(styles).toMatch(
      /\.software-map-c4-edge-endpoint\s*{[^}]*width:\s*11px\s*!important;[^}]*height:\s*11px\s*!important;[^}]*border:\s*1\.5px solid var\(--map-edge\)\s*!important;[^}]*background:\s*var\(--map-panel-2\)\s*!important;[^}]*opacity:\s*1;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-endpoint--hovered\s*{[^}]*border:\s*2px solid var\(--map-card\)\s*!important;[^}]*background:\s*var\(--accent\)\s*!important;[^}]*opacity:\s*1;/s,
    );
  });

  it("uses the accent for edges and labels attached to a selected node", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-canvas\s+\.software-map-c4-edge--selected-node\s+\.react-flow__edge-path\s*{[^}]*stroke:\s*var\(--accent\)\s*!important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-label--selected-node\s*{[^}]*border-color:\s*var\(--accent\)\s*!important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-canvas marker (?:path|polyline)[^{]*{[^}]*var\(--map-edge\)\s*!important/s,
    );
  });

  it("composes selected and changed chrome without replacing the selected frame", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    for (const [status, border] of [
      ["added", "1\\.5px solid var\\(--map-added\\)"],
      ["modified", "1\\.5px solid var\\(--map-changed\\)"],
      ["removed", "1\\.5px dashed var\\(--map-removed\\)"],
    ] as const) {
      expect(styles).toMatch(
        new RegExp(
          `\\.software-map-c4-group-shell--${status}\\s*{[^}]*border:\\s*${border} !important;`,
          "s",
        ),
      );
      expect(styles).toMatch(
        new RegExp(
          `\\.software-map-node\\.software-map-node--${status}\\s*{[^}]*border:\\s*${border} !important;`,
          "s",
        ),
      );
    }

    expect(styles).toMatch(
      /\.software-map-c4-group-shell\.selected,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--added,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--removed,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.selected,\s*\.software-map-node\.selected\.software-map-node--added,\s*\.software-map-node\.selected\.software-map-node--removed,\s*\.software-map-node\.selected\.software-map-node--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--removed \.software-map-node-label--world\s*{[^}]*text-decoration:\s*line-through;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-(?:c4-group-shell|node)\.selected[^}]*border:\s*1\.5px/s,
    );
  });

  it("allows the full-canvas Map tab to hide inline SoftwareMap chrome", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const appSource = readFileSync(
      new URL("../App.tsx", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-frame--chrome-hidden\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(appSource).toContain(
      '{softwareMapEnabled && activeView === "map" && (',
    );
    expect(appSource).toContain("Experimental");
    expect(appSource).toContain("showChrome={false}");
    expect(appSource).not.toContain("Add an inline");
    expect(source).toContain("showChrome = true");
    expect(source).toContain("{showChrome && (");
  });

  it("keeps inline software map chrome outside the body viewport", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(source.indexOf('className="software-map-header"')).toBeLessThan(
      source.indexOf('"software-map-body"'),
    );
    expect(styles).toMatch(
      /\.software-map-frame\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.software-map-body\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.software-map-canvas\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("renders C4 detail in world space without zoom-specific overlays", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).not.toContain("C4NodeLabelOverlay");
    expect(source).not.toContain("descriptionThresholds");
    expect(styles).not.toContain("detail-compact");
    expect(styles).not.toContain("compact-screen-scale");
  });

  it("refits the C4 viewport when a new expanded layout or canvas resize is applied", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toMatch(
      /useEffect\(\(\) => \{[^}]*if \(!flowInstance \|\| !layout\) return;[^}]*requestAnimationFrame\(\(\) => \{[^}]*fitC4MapView\(flowRef\.current\);/s,
    );
    expect(source).toContain("const canvas = keyboardTargetRef.current");
    expect(source).toContain(
      "const resizeObserver = new ResizeObserver(scheduleFit)",
    );
    expect(source).toContain("resizeObserver.observe(canvas)");
  });

  it("can hide removed topology while preserving live changed nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
              components: {
                liveComponent: {
                  codeElements: {
                    liveSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
                removedComponent: {
                  changeStatus: "removed",
                  codeElements: {
                    removedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "removed",
                    },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "progressiveReview.reviewApp.liveComponent.liveSymbol",
          to: "progressiveReview.reviewApp.removedComponent.removedSymbol",
          label: "called old code",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "progressiveReview",
        "progressiveReview.reviewApp",
        "progressiveReview.reviewApp.liveComponent",
        "progressiveReview.reviewApp.removedComponent",
      ]),
      showRemovedNodes: false,
    });

    expect(projection.nodes.map((node) => node.id)).toContain(
      "progressiveReview.reviewApp.liveComponent.liveSymbol",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent.removedSymbol",
    );
    expect(projection.relationships).toHaveLength(0);
  });

  it("keeps node comment buttons beside world-space nodes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.software-map-c4-node-shell::after,\s*\.software-map-c4-group-shell::after\s*{[^}]*top:\s*50%;[^}]*right:\s*-34px;[^}]*width:\s*38px;[^}]*height:\s*48px;[^}]*transform:\s*translateY\(-50%\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-node-shell > \.comment-hover-button,\s*\.software-map-c4-group-shell > \.comment-hover-button\s*{[^}]*top:\s*50%;[^}]*right:\s*auto;[^}]*left:\s*calc\(100% \+ 5px\);[^}]*z-index:\s*41;[^}]*width:\s*auto;[^}]*min-width:\s*30px;[^}]*height:\s*30px;[^}]*transform:\s*translateY\(-50%\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-comment-target\s*{[^}]*z-index:\s*40;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-comment-target > \.comment-hover-button\s*{[^}]*z-index:\s*41;/s,
    );
    expect(styles).not.toContain("software-map-c4-compact-screen-scale");
    expect(styles).toMatch(
      /\.software-map-c4-node-shell:hover > \.comment-hover-button,\s*\.software-map-c4-group-shell:hover > \.comment-hover-button,/s,
    );
  });

  it("re-applies refresh-fetched resolved data for an unchanged model signature", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const fetchSuccessSource = sourceBetween(
      source,
      "void fetchSoftwareMapResolvedData(",
      ".catch((cause: unknown) => {",
    );

    // The success branch must apply the resolved-data payload whenever the
    // effect run is still current. The per-run `cancelled` flag is the only
    // supersession guard: the old `appliedResolvedDataKeyRef.current !==
    // resolvedDataKey` check dropped every refresh-triggered re-fetch for an
    // already-applied key, contradicting the refresh path's deliberate bypass
    // of the same-key dedupe early-return below.
    expect(fetchSuccessSource).toContain("if (!cancelled) {");
    expect(fetchSuccessSource).toContain("applyResolvedDataState({");
    expect(fetchSuccessSource).not.toContain(
      "appliedResolvedDataKeyRef.current !== resolvedDataKey",
    );

    // The dedupe early-return still short-circuits ordinary re-render
    // re-fetches (refreshEpoch === 0) for an already-applied key; only a
    // refresh (refreshEpoch !== 0) is meant to re-fetch and re-apply.
    const dedupeSource = sourceBetween(
      source,
      "appliedResolvedDataKeyRef.current === resolvedDataKey &&",
      "const initialEntry = initialData?.softwareMapResolvedData.find",
    );
    expect(dedupeSource).toContain("refreshEpoch === 0");
    expect(dedupeSource).toContain("return;");
  });
});
