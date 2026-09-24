import { RunOnceScheduler } from "../../base/common/async.js";
import { observableValue, transaction, type IObservable, type ISettableObservable } from "../../base/common/observable.js";
import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { structuralFilePath, STRUCTURAL_WIRE_VERSION, type StructuralEvent, type StructuralRegion, type StructuralTextDiff } from "../common/reviewStructuralDiff.js";
import type { StructuralDiff } from "../common/reviewProtocol.js";
import type { StructuralDiffStream } from "./reviewStructuralDiffClient.js";

export interface StructuralFileResult {
	diff?: StructuralDiff;
	error?: string;
	hidden?: string;
	annotationError?: string;
}

export interface StructuralSessionChange {
	/** Files whose diff or fold state changed. */
	readonly files: ReadonlySet<string>;
	/** Files with new summary labels or summary errors; their diff is unchanged. */
	readonly labels: ReadonlySet<string>;
	readonly status: boolean;
}

/** One comparison, owned by the review. Views only observe it and change fold state. */
export class StructuralDiffSession extends Disposable {
	private readonly changed = this._register(new Emitter<StructuralSessionChange>());
	readonly onDidChange = this.changed.event;
	private readonly pendingFiles = new Set<string>();
	private readonly pendingLabels = new Set<string>();
	private pendingStatus = false;
	private readonly regions = new Map<string, StructuralRegion>();
	private readonly labels = new Map<string, ISettableObservable<string | undefined>>();
	private readonly pendingLabelValues = new Map<string, string>();
	private readonly notification = this._register(new RunOnceScheduler(() => this.flushChanges(), 16));
	private readonly abort = new AbortController();
	private readonly results = new Map<string, StructuralFileResult>();
	private readonly folds = new Map<string, boolean>();
	private manifest: Set<string> | undefined;
	private task: Promise<void> | undefined;
	private finished = false;
	private disposed = false;
	error: string | undefined;
	get complete(): boolean { return this.finished; }

	constructor(private readonly client: StructuralDiffStream) { super(); }

	start(): Promise<void> { return this.task ??= this.consume(); }
	/** Whether diffr lists the file; undefined until it has listed the comparison's files. */
	covers(path: string): boolean | undefined { return this.manifest?.has(path); }
	getFileResult(path: string): StructuralFileResult | undefined { return this.results.get(path); }
	getTextDiff(path: string): StructuralTextDiff | undefined {
		const diff = this.results.get(path)?.diff;
		return diff?.type === "text" ? diff : undefined;
	}
	isRegionCollapsed(path: string, id: number): boolean | undefined { return this.folds.get(`${path}:${id}`); }
	setRegionCollapsed(path: string, id: number, collapsed: boolean): void {
		const key = `${path}:${id}`;
		if (this.disposed || this.folds.get(key) === collapsed) return;
		this.folds.set(key, collapsed);
		this.notify(path);
	}

	private async consume(): Promise<void> {
		try {
			for await (const event of this.client.streamComparison(this.abort.signal)) {
				if (this.disposed) return;
				this.applyEvent(event);
			}
			if (!this.finished) throw new Error("diffr stream ended before completion.");
		} catch (error) {
			if (!this.disposed) {
				this.error = error instanceof Error ? error.message : String(error);
				this.finished = true;
				this.notify(undefined, true);
			}
		} finally {
			this.notification.cancel();
			if (!this.disposed) this.flushChanges();
		}
	}

	private applyEvent(event: StructuralEvent): void {
		if (this.finished) throw new Error("diffr emitted data after completion.");
		if (!this.manifest) {
			if (event.type !== "start" || event.version !== STRUCTURAL_WIRE_VERSION) throw new Error("Unsupported diffr stream protocol.");
			this.acceptManifest(event);
		} else if (event.type === "file") this.storeFileResult(event);
		else if (event.type === "annotations") this.applyAnnotations(event);
		else if (event.type === "complete") this.finishLoading(event);
		else throw new Error(`Unexpected diffr event: ${event.type}`);
		if (event.type === "file") this.notify(structuralFilePath(event.file));
		else if (event.type === "annotations") {
			this.pendingLabels.add(structuralFilePath(event.file));
			this.notify();
		} else this.notify(undefined, true);
	}

	/** Stable presentation state, shared by all editors displaying this region. */
	regionLabel(path: string, id: number): IObservable<string | undefined> {
		const key = `${path}:${id}`;
		let label = this.labels.get(key);
		if (!label) {
			label = observableValue<string | undefined>(this, this.regions.get(key)?.visibility?.label);
			this.labels.set(key, label);
		}
		return label;
	}

	private notify(path?: string, status = false): void {
		if (path) this.pendingFiles.add(path);
		this.pendingStatus ||= status;
		if (!this.notification.isScheduled()) this.notification.schedule();
	}

	private flushChanges(): void {
		if (!this.pendingFiles.size && !this.pendingLabels.size && !this.pendingStatus) return;
		const change: StructuralSessionChange = {
			files: new Set(this.pendingFiles), labels: new Set(this.pendingLabels), status: this.pendingStatus,
		};
		const labels = new Map(this.pendingLabelValues);
		this.pendingFiles.clear(); this.pendingLabels.clear(); this.pendingLabelValues.clear(); this.pendingStatus = false;
		transaction(tx => {
			for (const [key, value] of labels) this.labels.get(key)?.set(value, tx);
		});
		this.changed.fire(change);
	}

	private acceptManifest(event: Extract<StructuralEvent, { type: "start" }>): void {
		this.manifest = new Set(event.files.map(file => structuralFilePath(file.file)));
		if (this.manifest.size !== event.files.length) throw new Error("diffr repeated a file in its manifest.");
	}

	private storeFileResult(event: Extract<StructuralEvent, { type: "file" }>): void {
		const path = structuralFilePath(event.file);
		if (!this.manifest!.has(path) || this.results.has(path)) throw new Error(`Unexpected or repeated diffr result: ${path}`);
		if (event.error) { this.results.set(path, { error: event.error.message }); return; }
		const diff = event.diff;
		if (diff.type === "text") {
			const seed = (region: StructuralRegion) => {
				this.regions.set(`${path}:${region.id}`, region);
				const key = `${path}:${region.fold_state_id}`;
				if (!this.folds.has(key)) this.folds.set(key, region.visibility?.collapsed === true);
				if (region.kind === "fold") region.children.forEach(seed);
			};
			for (const side of [diff.lhs, diff.rhs]) side?.regions?.forEach(seed);
		}
		this.results.set(path, {
			diff,
			hidden: event.visibility?.collapsed ? event.visibility.label || "Hidden by default" : undefined
		});
	}

	private applyAnnotations(event: Extract<StructuralEvent, { type: "annotations" }>): void {
		const path = structuralFilePath(event.file);
		const result = this.results.get(path);
		if (result?.diff?.type !== "text") throw new Error(`Annotations precede a text result: ${path}`);
		// Validate the entire batch before applying it. Labels do not replace the
		// source, correspondence, region identities, or the reader's fold choices.
		for (const annotation of event.annotations) {
			if (!this.regions.has(`${path}:${annotation.region_id}`)) throw new Error(`Unknown annotation region: ${annotation.region_id}`);
		}
		for (const annotation of event.annotations) {
			const region = this.regions.get(`${path}:${annotation.region_id}`)!;
			region.visibility = { ...region.visibility, label: annotation.label };
			this.pendingLabelValues.set(`${path}:${region.id}`, annotation.label);
		}
		result.annotationError = event.error?.message;
	}

	private finishLoading(event: Extract<StructuralEvent, { type: "complete" }>): void {
		for (const path of this.manifest!) if (!this.results.has(path)) { this.results.set(path, { error: "diffr did not supply a result for this file." }); this.pendingFiles.add(path); }
		this.finished = true;
		if (event.aborted) this.error = `diffr stopped early: ${event.aborted.message}`;
	}

	override dispose(): void {
		this.disposed = true;
		this.abort.abort();
		this.results.clear();
		this.folds.clear();
		this.labels.clear();
		this.regions.clear();
		this.pendingFiles.clear();
		this.pendingLabels.clear();
		this.pendingLabelValues.clear();
		super.dispose();
	}
}
