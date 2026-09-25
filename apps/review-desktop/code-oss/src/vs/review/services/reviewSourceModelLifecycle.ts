import { DisposableStore, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import type { ITextModel } from "../../editor/common/model.js";
import type { IModelService } from "../../editor/common/services/model.js";

/** Tracks only review models currently attached to an editor. */
export function watchAttachedReviewModels(
	models: Pick<IModelService, "onModelAdded" | "getModels">,
	schemes: readonly string[],
	attached: (model: ITextModel) => void,
	detached: (model: ITextModel) => void,
): IDisposable {
	const store = new DisposableStore();
	const active = new Set<ITextModel>();
	store.add(toDisposable(() => {
		for (const model of active) detached(model);
		active.clear();
	}));
	const watch = (model: ITextModel) => {
		if (!schemes.includes(model.uri.scheme)) return;
		const owned = store.add(new DisposableStore());
		const update = () => {
			if (model.isAttachedToEditor()) {
				if (!active.has(model)) { active.add(model); attached(model); }
			} else if (active.delete(model)) detached(model);
		};
		owned.add(model.onDidChangeAttached(update));
		owned.add(model.onWillDispose(() => {
			if (active.delete(model)) detached(model);
			store.delete(owned);
			owned.dispose();
		}));
		update();
	};
	store.add(models.onModelAdded(watch));
	models.getModels().forEach(watch);
	return store;
}

export async function withRetainedSource<T>(source: { retain(): IDisposable | undefined }, run: () => Promise<T>): Promise<T | undefined> {
	const reference = source.retain();
	if (!reference) return undefined;
	try {
		return await run();
	} finally {
		reference.dispose();
	}
}
