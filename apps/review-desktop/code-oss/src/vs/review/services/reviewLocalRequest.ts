import type { CancellationToken } from "../../base/common/cancellation.js";
import type { ITextModel } from "../../editor/common/model.js";

type VersionedModel = Pick<ITextModel, "getVersionId" | "isDisposed">;

/** Never publish an answer computed against a superseded local project. */
export async function withCurrentLocalContext<T>(
	models: readonly VersionedModel[],
	token: Pick<CancellationToken, "isCancellationRequested">,
	generation: () => number,
	resolve: (isCurrent: () => boolean) => Promise<T>,
): Promise<T | undefined> {
	if (token.isCancellationRequested || models.some(model => model.isDisposed())) return undefined;
	const versions = models.map(model => model.getVersionId());
	const project = generation();
	const current = () => !token.isCancellationRequested && project === generation() &&
		models.every((model, index) => !model.isDisposed() && model.getVersionId() === versions[index]);
	const result = await resolve(current);
	return current() ? result : undefined;
}
