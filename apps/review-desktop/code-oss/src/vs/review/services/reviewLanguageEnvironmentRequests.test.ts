import assert from "node:assert/strict";
import test from "node:test";
import { ReviewLanguageEnvironmentRequests } from "./reviewLanguageEnvironmentRequests.js";
import { withCurrentLocalContext } from "./reviewLocalRequest.js";

const view = { reviewId: "review", version: 3 };
const ready = { rootPath: "/project", identity: "first" };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

test("simultaneous providers share one environment lookup across source refresh tokens", async () => {
	const requests = new ReviewLanguageEnvironmentRequests();
	const response = deferred<typeof ready>();
	let count = 0;
	const load = () => { count++; return response.promise; };
	const wave = Array.from({ length: 20 }, (_, index) => requests.read("session", { ...view, generation: String(index) }, "head", load));
	await Promise.resolve();
	assert.equal(count, 1);
	response.resolve(ready);
	assert.deepEqual(await Promise.all(wave), Array(20).fill(ready));
	await requests.read("session", view, "head", load);
	assert.equal(count, 2, "completed lookups are revalidated until lifecycle events are authoritative");
});

test("a post-query check never joins an HTTP request that started before the provider finished", async () => {
	const requests = new ReviewLanguageEnvironmentRequests();
	const first = deferred<typeof ready>();
	const next = deferred<typeof ready>();
	let count = 0;
	const load = () => ++count === 1 ? first.promise : next.promise;
	const before = requests.read("session", view, "head", load);
	await Promise.resolve();
	const validations = Array.from({ length: 10 }, () => requests.read("session", view, "head", load, true));
	await Promise.resolve();
	assert.equal(count, 2);
	first.resolve(ready);
	assert.deepEqual(await before, ready);
	next.resolve({ ...ready, identity: "replaced" });
	assert.ok((await Promise.all(validations)).every(result => result?.identity === "replaced"));
});

test("sessions, authored versions, sides and selected commits never share lookups", async () => {
	const requests = new ReviewLanguageEnvironmentRequests();
	let count = 0;
	const load = async () => ({ ...ready, identity: String(++count) });
	const results = await Promise.all([
		requests.read("one", view, "head", load),
		requests.read("two", view, "head", load),
		requests.read("one", { ...view, version: 4 }, "head", load),
		requests.read("one", view, "base", load),
		requests.read("one", { ...view, commit: "selected" }, "head", load),
		requests.read("one", { ...view, reviewId: "other" }, "head", load),
	]);
	assert.equal(new Set(results.map(result => result?.identity)).size, 6);
});

test("unavailable and failed lookups recover on the next query", async () => {
	const requests = new ReviewLanguageEnvironmentRequests();
	assert.equal(await requests.read("session", view, "head", async () => undefined), undefined);
	await assert.rejects(requests.read("session", view, "head", async () => { throw new Error("offline"); }), /offline/);
	assert.deepEqual(await requests.read("session", view, "head", async () => ready), ready);
});

test("disconnect discards a pending response and a delayed provider even when identity is unchanged", async () => {
	const requests = new ReviewLanguageEnvironmentRequests();
	const response = deferred<typeof ready>();
	const pending = requests.read("session", view, "head", () => response.promise);
	await Promise.resolve();
	const provider = deferred<string>();
	const result = withCurrentLocalContext([{ getVersionId: () => 1, isDisposed: () => false }], { isCancellationRequested: false }, () => requests.generation, () => provider.promise);
	requests.invalidate();
	response.resolve(ready);
	provider.resolve("stale hover");
	assert.equal(await pending, undefined);
	assert.equal(await result, undefined);
	assert.deepEqual(await requests.read("session", view, "head", async () => ready), ready);
});
