import assert from "node:assert/strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import { FileOperationError, FileOperationResult } from "../../platform/files/common/files.js";
import { REVIEW_UNIFIED_SCHEME } from "../common/reviewCodeResources.js";
import { reviewPeekLineMappings } from "../common/reviewPeek.js";
import { ReviewCodeResourceService } from "./reviewCodeResourceService.js";

const unifiedDiffFile = {
	path: "src/example.ts",
	status: "modified" as const,
	additions: 1,
	deletions: 1,
	patch: ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 3;", " const c = 4;", ""].join("\n"),
};
const baseLines = ["const a = 1;", "const b = 2;", "const c = 4;"];
const headLines = ["const a = 1;", "const b = 3;", "const c = 4;"];

interface StubModel {
	readonly uri: URI;
	getLinesContent(): readonly string[];
	getLineCount(): number;
	getLanguageId(): string;
	setLanguage(languageId: string): void;
	onDidChangeLanguage(listener: (event: { newLanguage: string }) => void): { dispose(): void };
}

/**
 * Builds a `ReviewCodeResourceService` over the smallest text-model stack the
 * unified path needs: a model service that remembers what it created, a
 * resolver that hands back file-backed models, and a one-file diff service.
 */
function createUnifiedHarness(beforeAcquire?: (resource: URI) => Promise<void>) {
	const models = new Map<string, StubModel>();
	const registrations: Array<{
		readonly scheme: string;
		readonly provider: {
			provideTextContent(resource: URI): Promise<StubModel | null>;
		};
		disposed: boolean;
	}> = [];
	const referenceDisposals: string[] = [];
	let openReferences = 0;

	const fileModel = (uri: URI, lines: readonly string[]): StubModel => {
		let languageId = "typescript";
		const listeners = new Set<(event: { newLanguage: string }) => void>();
		return {
			uri,
			getLinesContent: () => lines,
			getLineCount: () => lines.length,
			getLanguageId: () => languageId,
			setLanguage(next: string) {
				languageId = next;
				for (const listener of listeners) listener({ newLanguage: next });
			},
			onDidChangeLanguage(listener: (event: { newLanguage: string }) => void) {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
		};
	};
	models.set(
		URI.file("/tmp/review-base/src/example.ts").toString(),
		fileModel(URI.file("/tmp/review-base/src/example.ts"), baseLines),
	);
	models.set(
		URI.file("/tmp/review-head/src/example.ts").toString(),
		fileModel(URI.file("/tmp/review-head/src/example.ts"), headLines),
	);

	const textModelService = {
		registerTextModelContentProvider(
			scheme: string,
			provider: { provideTextContent(resource: URI): Promise<StubModel | null> },
		) {
			const registration = { scheme, provider, disposed: false };
			registrations.push(registration);
			return {
				dispose() {
					registration.disposed = true;
				},
			};
		},
		async createModelReference(resource: URI) {
			await beforeAcquire?.(resource);
			const model = models.get(resource.toString());
			if (!model) throw new Error(`No model for ${resource.toString()}`);
			openReferences += 1;
			let disposed = false;
			return {
				object: { textEditorModel: model },
				dispose() {
					if (disposed) return;
					disposed = true;
					openReferences -= 1;
					referenceDisposals.push(resource.toString());
				},
			};
		},
	};
	const modelService = {
		getModel: (resource: URI) => models.get(resource.toString()) ?? null,
		createModel(content: string, _language: unknown, resource: URI) {
			const lines = content.split("\n");
			const model = fileModel(resource, lines);
			models.set(resource.toString(), model);
			return model;
		},
	};
	const service = new ReviewCodeResourceService(
		textModelService as never,
		modelService as never,
		{ createById: (id: string) => ({ languageId: id }) } as never,
	);

	return {
		service,
		acquire: (
			path: string,
			side: "base" | "head",
			ranges: readonly import("../common/reviewProtocol.js").ReviewInlineEditorRange[],
		) =>
			service.acquireUnifiedDiffForTarget(path, side, ranges, {
				original: URI.file("/tmp/review-base/src/example.ts"),
				modified: URI.file("/tmp/review-head/src/example.ts"),
				diffFile: unifiedDiffFile,
				mappings: reviewPeekLineMappings(unifiedDiffFile.patch),
				windows: () => ({ original: [], modified: [] }),
			}),
		registrations,
		referenceDisposals,
		openReferences: () => openReferences,
		headModel: models.get(URI.file("/tmp/review-head/src/example.ts").toString())!,
	};
}

test("unified diff resources are keyed by pinned sources and side, and shared", async () => {
	const harness = createUnifiedHarness();
	const first = await harness.acquire("src/example.ts", "head", []);
	assert.ok(first);
	const resource = first.model.uri;
	assert.equal(resource.scheme, REVIEW_UNIFIED_SCHEME);
	const query = new URLSearchParams(resource.query);
	assert.equal(query.get("path"), "src/example.ts");
	assert.equal(query.get("original"), URI.file("/tmp/review-base/src/example.ts").toString());
	assert.equal(query.get("side"), "head");

	// The identity is the pinned sources, path and side — not a per-call token — so a
	// second acquire of the same CodePeek reuses one model rather than building
	// a second copy of the unified text.
	const second = await harness.acquire("src/example.ts", "head", []);
	assert.ok(second);
	assert.strictEqual(second.model, first.model);
	assert.equal(second.model.uri.toString(), resource.toString());

	const otherSide = await harness.acquire("src/example.ts", "base", []);
	assert.ok(otherSide);
	assert.notEqual(otherSide.model.uri.toString(), resource.toString());
	assert.equal(new URLSearchParams(otherSide.model.uri.query).get("side"), "base");

	otherSide.dispose();
	second.dispose();
	first.dispose();
	harness.service.dispose();
});

test("unified diff references are released only when the last holder lets go", async () => {
	const harness = createUnifiedHarness();
	const first = await harness.acquire("src/example.ts", "head", []);
	const second = await harness.acquire("src/example.ts", "head", []);
	assert.ok(first && second);
	// base checkout, head checkout, and the unified resource itself: References
	// and Peek Definition resolve the unified URI independently, so the service
	// holds its own resolver reference for as long as the CodePeek lives.
	assert.equal(harness.openReferences(), 3);
	assert.deepEqual(harness.referenceDisposals, []);

	first.dispose();
	assert.equal(harness.openReferences(), 3);

	second.dispose();
	assert.equal(harness.openReferences(), 0);
	assert.deepEqual(
		new Set(harness.referenceDisposals),
		new Set([
			first.model.uri.toString(),
			URI.file("/tmp/review-base/src/example.ts").toString(),
			URI.file("/tmp/review-head/src/example.ts").toString(),
		]),
	);
	harness.service.dispose();
});

for (const missingSide of ["base", "head"] as const) {
	test(`a missing ${missingSide} releases the other source reference and allows recovery`, async () => {
		const failure = new FileOperationError("Pinned source missing", FileOperationResult.FILE_NOT_FOUND);
		let missing = true;
		let releaseOther!: () => void;
		const otherReady = new Promise<void>((resolve) => {
			releaseOther = resolve;
		});
		const harness = createUnifiedHarness(async (resource) => {
			if (!missing || resource.scheme !== "file") return;
			if (resource.path.includes(`/review-${missingSide}/`)) throw failure;
			await otherReady;
		});
		try {
			const acquisition = harness.acquire("src/example.ts", "head", []);
			const rejected = assert.rejects(acquisition, (error) => error === failure);
			// The other side resolves after the missing-file rejection.
			await new Promise((resolve) => setImmediate(resolve));
			releaseOther();
			await rejected;
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(harness.openReferences(), 0);
			assert.equal(harness.referenceDisposals.length, 1);
			missing = false;
			const recovered = await harness.acquire("src/example.ts", "head", []);
			assert.ok(recovered);
			assert.equal(harness.openReferences(), 3);
			recovered.dispose();
			assert.equal(harness.openReferences(), 0);
		} finally {
			releaseOther();
			harness.service.dispose();
		}
	});

	test(`a missing ${missingSide} does not hide an unexpected failure on the other side`, async () => {
		const missing = new FileOperationError("Pinned source missing", FileOperationResult.FILE_NOT_FOUND);
		const unexpected = new FileOperationError("Access denied", FileOperationResult.FILE_PERMISSION_DENIED);
		const harness = createUnifiedHarness(async (resource) => {
			throw resource.path.includes(`/review-${missingSide}/`) ? missing : unexpected;
		});
		try {
			await assert.rejects(harness.acquire("src/example.ts", "head", []), (error) => error === unexpected);
			assert.equal(harness.openReferences(), 0);
		} finally {
			harness.service.dispose();
		}
	});
}

test("unified rows resolve back to the pinned base and head checkouts", async () => {
	const harness = createUnifiedHarness();
	const reference = await harness.acquire("src/example.ts", "head", []);
	assert.ok(reference);
	const info = harness.service.unifiedResource(reference.model.uri);
	assert.ok(info);
	assert.deepEqual(
		info.rows.map((row) => [row.kind, row.authorSide, row.authorLine]),
		[
			["unchanged", "head", 1],
			["deleted", "base", 2],
			["added", "head", 2],
			["unchanged", "head", 3],
		],
	);

	const deleted = info.targetForRange(2, 2);
	const added = info.targetForRange(3, 3);
	assert.deepEqual(deleted, {
		path: "src/example.ts",
		side: "base",
		startLine: 2,
		endLine: 2,
	});
	assert.deepEqual(added, {
		path: "src/example.ts",
		side: "head",
		startLine: 2,
		endLine: 2,
	});
	// A row that spans both sides has no single source line to open.
	assert.equal(info.targetForRange(2, 3), null);

	assert.equal(info.original.toString(), URI.file("/tmp/review-base/src/example.ts").toString());
	assert.equal(info.modified.toString(), URI.file("/tmp/review-head/src/example.ts").toString());

	reference.dispose();
	harness.service.dispose();
});

test("the review scheme content providers are registered and disposed with the service", async () => {
	const harness = createUnifiedHarness();
	assert.deepEqual(
		harness.registrations.map((registration) => registration.scheme),
		[REVIEW_UNIFIED_SCHEME],
	);

	const reference = await harness.acquire("src/example.ts", "head", []);
	assert.ok(reference);
	const unifiedProvider = harness.registrations.find((registration) => registration.scheme === REVIEW_UNIFIED_SCHEME);
	assert.ok(unifiedProvider);
	// The unified text lives in the model service already; the provider hands
	// the same model back so a resolver reference never rebuilds it.
	assert.strictEqual(await unifiedProvider.provider.provideTextContent(reference.model.uri), reference.model);
	assert.equal(
		reference.model.getLinesContent().join("\n"),
		["const a = 1;", "const b = 2;", "const b = 3;", "const c = 4;"].join("\n"),
	);

	reference.dispose();
	harness.service.dispose();
	assert.deepEqual(
		harness.registrations.map((registration) => registration.disposed),
		[true],
	);
});

test("the unified preview adopts its side model's language when the checkout registers", async () => {
	const harness = createUnifiedHarness();
	const acquired = await harness.acquire("src/example.ts", "head", []);
	assert.ok(acquired);
	assert.equal(acquired.model.getLanguageId(), "typescript");

	harness.headModel.setLanguage("rust");

	assert.equal(acquired.model.getLanguageId(), "rust");
});
