import assert from "node:assert/strict";
import test from "node:test";
import { withCurrentLocalContext } from "./whiteboardLocalRequest.js";

for (const change of ["source", "dependency", "disposed", "cancelled", "none"] as const) {
	test(`pending language result is ${change === "none" ? "returned" : "discarded"} after ${change}`, async () => {
		let version = 1, generation = 1, disposed = false;
		const token = { isCancellationRequested: false };
		let finish!: (value: string) => void;
		const provider = new Promise<string>(resolve => { finish = resolve; });
		const result = withCurrentLocalContext([
			{ getVersionId: () => version, isDisposed: () => disposed },
		], token, () => generation, () => provider);
		if (change === "source") version++;
		if (change === "dependency") generation++;
		if (change === "disposed") disposed = true;
		if (change === "cancelled") token.isCancellationRequested = true;
		finish("definition from previous project state");
		assert.equal(await result, change === "none" ? "definition from previous project state" : undefined);
	});
}
