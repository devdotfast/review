import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../../../base/common/event.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { EditorExtensions, EditorsOrder, type IEditorFactoryRegistry } from "../../../../workbench/common/editor.js";
import { EditorGroupModel } from "../../../../workbench/common/editor/editorGroupModel.js";
import { ReviewCanvasEditorTabsService } from "../../../services/reviewCanvasEditorTabsService.js";
import { ReviewApiEditorSerializer } from "./reviewApiEditorSerializer.js";
import { ReviewCanvasEditorInput } from "./reviewCanvasEditorInput.js";

test("native group restoration preserves both reviews, order and pinned source versions without duplicate tabs", async (t) => {
	const inputs: ReviewCanvasEditorInput[] = [];
	let tabs: ReviewCanvasEditorTabsService;
	const instantiation = {
		createInstance(ctor: any, ...args: any[]) {
			if (ctor !== ReviewCanvasEditorInput) return new ctor(...args);
			const input = new ReviewCanvasEditorInput(args[0], {} as never);
			inputs.push(input);
			return input;
		},
		invokeFunction(fn: any) {
			return fn({ get: () => tabs });
		},
	};
	const groups: EditorGroupModel[] = [];
	const editors = {
		onDidCloseEditor: Event.None,
		async openEditor(input: ReviewCanvasEditorInput, options: any, group: EditorGroupModel) {
			group.openEditor(input, { pinned: options.pinned, active: !options.inactive });
		},
	};
	const groupService = { groups, mainPart: { activeGroup: undefined as EditorGroupModel | undefined } };
	const createTabs = () =>
		new ReviewCanvasEditorTabsService(instantiation as never, editors as never, groupService as never);
	tabs = createTabs();
	const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
	registry.start({ get: () => instantiation } as never);
	const registration = registry.registerEditorSerializer(ReviewCanvasEditorInput.ID, ReviewApiEditorSerializer);
	const config = { getValue: () => undefined, onDidChangeConfiguration: Event.None };
	const group = (state?: ReturnType<EditorGroupModel["serialize"]>) =>
		new EditorGroupModel(state, instantiation as never, config as never);
	const left = group(),
		right = group();
	t.after(() => {
		registration.dispose();
		tabs.dispose();
		left.dispose();
		right.dispose();
		groups.forEach((group) => group.dispose());
		inputs.forEach((input) => input.dispose());
	});
	left.openEditor(tabs.inputFor({ kind: "home" }), { pinned: true, sticky: true });
	left.openEditor(tabs.inputFor({ kind: "api", sessionId: "a", title: "Review A" }), { pinned: true, active: true });
	left.openEditor(tabs.inputFor({ kind: "api-source", sessionId: "a", title: "Review A", selection: { sessionId: "a", kind: "version", version: 7 } }), {
		pinned: true,
		active: false,
	});
	right.openEditor(tabs.inputFor({ kind: "api", sessionId: "b", title: "Review B" }), { pinned: true, active: true });
	const saved = [left.serialize(), right.serialize()];
	tabs.dispose();
	tabs = createTabs();
	groups.push(...saved.map((state) => group(state)));
	groupService.mainPart.activeGroup = groups[1];
	assert.deepEqual(
		groups.map((group) => group.getEditors(EditorsOrder.SEQUENTIAL).map((editor) => editor.getName())),
		[["Home", "Review A", "Source — Review A (v7)"], ["Review B"]],
	);
	assert.equal(groups[0]!.activeEditor!.getName(), "Review A");
	const restored = groups[0]!.activeEditor;
	assert.equal(await tabs.openApiReview("a", "Renamed A"), restored);
	assert.equal(groups[0]!.count, 3);
	assert.equal(groups[0]!.stickyCount, 1);
	assert.equal(groups[1]!.count, 1);
	assert.equal(restored!.getName(), "Renamed A");
});

test("invalid saved tabs are ignored instead of preventing the window from restoring", () => {
	const serializer = new ReviewApiEditorSerializer();
	for (const value of [
		"invalid JSON",
		"null",
		'{"kind":"api"}',
		'{"kind":"api-source","sessionId":"a","title":"A","version":-1}',
	]) {
		assert.equal(serializer.deserialize({} as never, value), undefined);
	}
});


test("current Source tabs retain identity and main version tabs still restore", () => {
  const inputs: ReviewCanvasEditorInput[] = [];
  let tabs: ReviewCanvasEditorTabsService;
  const instantiation = {
    createInstance(_ctor: unknown, target: ConstructorParameters<typeof ReviewCanvasEditorInput>[0]) {
      const input = new ReviewCanvasEditorInput(target, {} as never);
      inputs.push(input);
      return input;
    },
    invokeFunction(fn: (accessor: { get(): ReviewCanvasEditorTabsService }) => unknown) { return fn({ get: () => tabs }); },
  };
  tabs = new ReviewCanvasEditorTabsService(instantiation as never, { onDidCloseEditor: Event.None } as never, {} as never);
  try {
    const serializer = new ReviewApiEditorSerializer();
    const restored = serializer.deserialize(instantiation as never, JSON.stringify({ kind: "api-source", sessionId: "a", title: "A", selection: { sessionId: "a", kind: "current" } }));
    assert.equal(tabs.inputFor({ kind: "api-source", sessionId: "a", title: "A", selection: { sessionId: "a", kind: "current" } }), restored);
    assert.notEqual(tabs.inputFor({ kind: "api-source", sessionId: "a", title: "A", selection: { sessionId: "a", kind: "version", version: 2 } }), restored);
    const upgraded = serializer.deserialize(instantiation as never, JSON.stringify({ kind: "api-source", reviewId: "a", title: "A", selection: { reviewId: "a", kind: "current" } }));
    assert.equal(upgraded, restored);
    assert.deepEqual(JSON.parse(serializer.serialize(upgraded as ReviewCanvasEditorInput)!), { kind: "api-source", sessionId: "a", title: "A", selection: { sessionId: "a", kind: "current" } });
    const historical = serializer.deserialize(instantiation as never, JSON.stringify({ kind: "api-source", sessionId: "a", title: "A", version: 2 }));
    assert.equal((historical as ReviewCanvasEditorInput).getName(), "Source — A (v2)");
  } finally { tabs.dispose(); inputs.forEach(input => input.dispose()); }
});
