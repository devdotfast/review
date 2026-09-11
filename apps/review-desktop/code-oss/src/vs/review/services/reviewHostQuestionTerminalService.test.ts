import assert from "node:assert/strict";
import test from "node:test";

import { Emitter } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import { type ITerminalService } from "../../workbench/contrib/terminal/browser/terminal.js";
import { GroupDirection } from "../../workbench/services/editor/common/editorGroupsService.js";
import type { HostQuestionTerminalRequest } from "./reviewHostQuestionTerminalService.js";

const input: HostQuestionTerminalRequest = {
  runId: "27768987-4d4d-4c6f-885c-4bf783f44c27", questionId: "8afbc67c-089e-4d84-95d1-16d5e4710484", reviewId: "381427b2-36bc-4d40-a043-915860ca46d0",
  session: { harness: "codex", sessionId: "session-one" }, command: { executable: "codex", args: ["resume", "session-one"], cwd: "/workspace", env: { REVIEW_RUN_ID: "run-one" } },
};

test("host questions reuse one group beside their canvas, deduplicate replay, and recover when the group closes", async (t) => {
  Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: class extends Event {} });
  t.after(() => { Reflect.deleteProperty(globalThis, "MouseEvent"); });
  const { ReviewHostQuestionTerminalService } = await import("./reviewHostQuestionTerminalService.js");
  const disposed = new Emitter<void>();
  t.after(() => disposed.dispose());
  const created: Parameters<ITerminalService["createTerminal"]>[0][] = [];
  const opened: number[] = [];
  const notices: string[] = [];
  let focused = 0;
  const terminal = { onDisposed: disposed.event, focusWhenReady: async () => { focused++; } };
  const reviewGroup = { id: 41, editors: [{ resource: URI.from({ scheme: "devfast-review-canvas", authority: "host-review", path: `/${input.reviewId}` }) }] };
  const otherGroup = { id: 82, editors: [] };
  const groups = [reviewGroup, otherGroup];
  let activeGroup: typeof reviewGroup = otherGroup;
  const splits: { beside: number; direction: GroupDirection }[] = [];
  const editorGroups = {
    get activeGroup() { return activeGroup; },
    get groups() { return groups; },
    mainPart: { activeGroup: reviewGroup },
    getGroup: (id: number) => groups.find(group => group.id === id),
    getGroups: () => groups,
    addGroup: (beside: typeof reviewGroup, direction: GroupDirection) => {
      splits.push({ beside: beside.id, direction });
      const group = { id: 100 + splits.length, editors: [] };
      groups.splice(groups.indexOf(beside) + 1, 0, group);
      return group;
    },
  };
  const service = new ReviewHostQuestionTerminalService(
    { createTerminal: async (options: typeof created[number]) => { created.push(options); return terminal; }, setActiveInstance: (instance: typeof terminal) => assert.equal(instance, terminal) } as never,
    { openEditor: async (instance: typeof terminal, options: { viewColumn: number }) => { assert.equal(instance, terminal); opened.push(options.viewColumn); } } as never,
    editorGroups as never,
    { error: (message: string) => notices.push(message) } as never,
  );
  t.after(() => service.dispose());
  await Promise.all([service.open(input), service.open(input)]);
  assert.equal(created.length, 1);
  assert.deepEqual(splits, [{ beside: reviewGroup.id, direction: GroupDirection.RIGHT }]);
  assert.deepEqual(created[0]?.location, { viewColumn: 1 });
  assert.deepEqual(opened, [101, 101]);
  assert.equal(focused, 2);
  const config = created[0]?.config;
  assert.ok(config && "executable" in config);
  assert.equal(config.executable, "codex");
  assert.deepEqual(config.args, ["resume", "session-one"]);
  assert.equal(config.env?.REVIEW_RUN_ID, "run-one");
  await service.reveal(input.reviewId, input.runId);
  assert.equal(created.length, 1);
  assert.equal(focused, 3);
  await assert.rejects(service.reveal("different-review", input.runId), /no longer open/);
  assert.match(notices.at(-1)!, /Start a new Ask/);
  activeGroup = groups[1];
  await service.open({ ...input, runId: "481427b2-36bc-4d40-a043-915860ca46d0", questionId: "581427b2-36bc-4d40-a043-915860ca46d0", session: { harness: "claude-code", sessionId: "session-two" } });
  assert.equal(created.length, 2);
  assert.equal(splits.length, 1);
  assert.equal(groups.length, 3);
  assert.deepEqual(created[1]?.location, { viewColumn: 1 });
  assert.equal(opened.at(-1), 101);

  groups.splice(groups.findIndex(group => group.id === 101), 1);
  disposed.fire();
  await assert.rejects(service.reveal(input.reviewId, input.runId), /no longer open/);
  assert.equal(created.length, 2);
  activeGroup = otherGroup;
  await service.open(input);
  assert.equal(created.length, 3);
  assert.equal(splits.length, 2);
  assert.equal(splits[1].beside, reviewGroup.id);
  assert.equal(opened.at(-1), 102);
});
