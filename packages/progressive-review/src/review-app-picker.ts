import { emitKeypressEvents } from "node:readline";
import type { Writable } from "node:stream";

import { fuzzyRank } from "./fuzzy-match";

export interface ReviewPickerItem {
  uuid: string;
  title: string;
  status: string;
  lastPublishedAt: string | null;
}

const MAX_VISIBLE_ROWS = 10;

/**
 * Minimal filter-as-you-type picker over the repository's reviews. Raw-mode
 * stdin, ANSI redraw, no dependencies. Resolves the chosen item, or null when
 * the reviewer cancels (Escape / Ctrl-C).
 */
export function pickReview(
  items: readonly ReviewPickerItem[],
  io: { stdin: NodeJS.ReadStream; stdout: Writable },
): Promise<ReviewPickerItem | null> {
  const { stdin, stdout } = io;
  return new Promise((resolve, reject) => {
    let query = "";
    let cursor = 0;
    let renderedLines = 0;

    const filtered = (): ReviewPickerItem[] =>
      fuzzyRank(query, items, (item) => [item.title, item.status, item.uuid]);

    const clearRendered = () => {
      if (renderedLines === 0) return;
      stdout.write(`[${renderedLines}A[J`);
      renderedLines = 0;
    };

    const render = () => {
      clearRendered();
      const matches = filtered();
      if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
      const lines = [`? Switch Review Desktop to: ${query}█`];
      const visible = matches.slice(0, MAX_VISIBLE_ROWS);
      for (const [index, item] of visible.entries()) {
        const marker = index === cursor ? "[7m" : "";
        const reset = index === cursor ? "[27m" : "";
        const age = relativeTime(item.lastPublishedAt);
        lines.push(
          `${marker}  ${item.title}  [2m${item.status}${age ? ` · ${age}` : ""}[22m${reset}`,
        );
      }
      if (matches.length === 0) lines.push("  [2mno matches[22m");
      if (matches.length > visible.length) {
        lines.push(
          `  [2m… ${matches.length - visible.length} more; keep typing[22m`,
        );
      }
      stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    const finish = (result: ReviewPickerItem | null) => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      stdin.pause();
      clearRendered();
      resolve(result);
    };

    const onKeypress = (
      character: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      try {
        const matches = filtered();
        /* With no matches the row limit is -1. Clamping keeps the cursor on a
           real row, so a later Enter cannot resolve matches[-1] to undefined
           and cancel the picker instead of opening a review. */
        const stepDown = () =>
          Math.max(
            0,
            Math.min(
              Math.min(matches.length, MAX_VISIBLE_ROWS) - 1,
              cursor + 1,
            ),
          );
        if (key?.ctrl && key.name === "c") return finish(null);
        switch (key?.name) {
          case "escape":
            return finish(null);
          case "return":
            return finish(matches[cursor] ?? null);
          case "up":
            cursor = Math.max(0, cursor - 1);
            return render();
          case "down":
            cursor = stepDown();
            return render();
          case "backspace":
            query = query.slice(0, -1);
            return render();
        }
        if (key?.ctrl) {
          if (key.name === "p") {
            cursor = Math.max(0, cursor - 1);
            return render();
          }
          if (key.name === "n") {
            cursor = stepDown();
            return render();
          }
          return;
        }
        if (character && character >= " " && character !== "") {
          query += character;
          cursor = 0;
          render();
        }
      } catch (error) {
        stdin.off("keypress", onKeypress);
        stdin.setRawMode?.(false);
        stdin.pause();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
