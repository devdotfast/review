import { Queue } from "../../base/common/async.js";
import type { IDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import type { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";

const sessions = new WeakMap<IWorkspaceEditingService, { queue: Queue<void>; roots: Map<string, number> }>();

/** Native live files and retained-source language adapters share folder ownership. */
export async function acquireWhiteboardLanguageRoot(workspace: IWorkspaceEditingService, root: URI): Promise<IDisposable> {
	let session = sessions.get(workspace);
	if (!session) {
		session = { queue: new Queue<void>(), roots: new Map() };
		sessions.set(workspace, session);
	}
	const { queue, roots } = session;
	const key = root.toString();
	await queue.queue(async () => {
		if (!roots.has(key)) await workspace.addFolders([{ uri: root }]);
		roots.set(key, (roots.get(key) ?? 0) + 1);
	});
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			void queue.queue(async () => {
				const count = (roots.get(key) ?? 1) - 1;
				if (count > 0) roots.set(key, count);
				else { roots.delete(key); await workspace.removeFolders([root]); }
			});
		}
	};
}
