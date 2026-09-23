import type { WhiteboardLanguageEnvironment, WhiteboardSourceView } from "../common/whiteboardProtocol.js";

/** In-flight reuse only: the event channel does not yet order environment changes. */
export class WhiteboardLanguageEnvironmentRequests {
	private readonly pending = new Map<string, { started: boolean; promise: Promise<WhiteboardLanguageEnvironment | undefined> }>();
	private epoch = 0;

	get generation(): number { return this.epoch; }

	invalidate(): void {
		this.epoch++;
		this.pending.clear();
	}

	read(session: string, view: WhiteboardSourceView, side: string, load: () => Promise<WhiteboardLanguageEnvironment | undefined>, validate = false): Promise<WhiteboardLanguageEnvironment | undefined> {
		// Source generations separate display models, not language environments.
		const key = JSON.stringify([session, view.sessionId, view.version, side, view.commit]);
		const cached = this.pending.get(key);
		// Post-provider validation must start AFTER that provider finished. A queued
		// request can coalesce a wave of validations; an already-started one cannot.
		if (cached && (!validate || !cached.started)) return cached.promise;
		const epoch = this.epoch;
		const entry = { started: false, promise: undefined! as Promise<WhiteboardLanguageEnvironment | undefined> };
		entry.promise = Promise.resolve().then(async () => {
			entry.started = true;
			if (epoch !== this.epoch) return undefined;
			const result = await load();
			return epoch === this.epoch ? result : undefined;
		}).finally(() => {
			if (this.pending.get(key) === entry) this.pending.delete(key);
		});
		this.pending.set(key, entry);
		return entry.promise;
	}
}
