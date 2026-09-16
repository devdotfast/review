import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { structuralFilePath, STRUCTURAL_WIRE_VERSION, type StructuralEvent, type StructuralRegion, type StructuralTextDiff } from "../common/reviewStructuralDiff.js";
import type { StructuralDiff } from "../common/reviewProtocol.js";
import type { StructuralDiffStream } from "./reviewStructuralDiffClient.js";

export interface StructuralFileResult {
	diff?: StructuralDiff;
	error?: string;
	hidden?: string;
}

/** One comparison, owned by the review. Views only observe it and change fold state. */
export class StructuralDiffSession extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
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
		this.changed.fire();
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
				this.changed.fire();
			}
		}
	}

	private applyEvent(event: StructuralEvent): void {
		if (this.finished) throw new Error("diffr emitted data after completion.");
		if (!this.manifest) {
			if (event.type !== "start" || event.version !== STRUCTURAL_WIRE_VERSION) throw new Error("Unsupported diffr stream protocol.");
			this.acceptManifest(event);
		} else if (event.type === "file") this.storeFileResult(event);
		else if (event.type === "complete") this.finishLoading(event);
		else throw new Error(`Unexpected diffr event: ${event.type}`);
		this.changed.fire();
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

	private finishLoading(event: Extract<StructuralEvent, { type: "complete" }>): void {
		for (const path of this.manifest!) if (!this.results.has(path)) this.results.set(path, { error: "diffr did not supply a result for this file." });
		this.finished = true;
		if (event.aborted) this.error = `diffr stopped early: ${event.aborted.message}`;
	}

	override dispose(): void {
		this.disposed = true;
		this.abort.abort();
		this.results.clear();
		this.folds.clear();
		super.dispose();
	}
}
