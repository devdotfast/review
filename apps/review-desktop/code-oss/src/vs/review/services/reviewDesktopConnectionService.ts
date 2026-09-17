/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter,Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../platform/ipc/common/mainProcessService.js";
import { IStorageService,StorageScope,StorageTarget } from "../../platform/storage/common/storage.js";
import {
REVIEW_DESKTOP_CHANNEL,
REVIEW_DESKTOP_CONNECTION_VERSION,
type ReviewDesktopConnection,
} from "../common/reviewDesktopBootstrap.js";
import { consumeReviewEventStream } from "../common/reviewEventStream.js";
import {
type JsonValue,
parseReviewCliInstallApplyResponse,
parseReviewCliInstallStatus,
parseReviewDesktopVerbFrame,
parseReviewTutorialOpenResponse,
type ReviewCliInstallApplyResponse,
type ReviewCliInstallStatus,
type ReviewCliInstallTarget,
type ReviewTutorialOpenResponse,
type ReviewVerbResponse
} from "../common/reviewProtocol.js";
import { reconnectUntilAborted } from "../common/reviewReconnect.js";

const REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY = "review.tutorial.autoPrepareSuppressed.v1";

export interface ReviewServerConnection {
	readonly serverUrl: string;
	readonly token: string;
}


export const IReviewDesktopConnectionService = createDecorator<IReviewDesktopConnectionService>(
	"reviewDesktopConnectionService",
);

export interface IReviewDesktopConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidFail: Event<Error>;
	readonly onDidChangeLists: Event<void>;
	initialize(): Promise<void>;
	getConnection(): Promise<ReviewServerConnection>;
	getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }>;
	prepareTutorial(): Promise<void>;
	openTutorial(): Promise<ReviewTutorialOpenResponse>;
	deleteTutorial(): Promise<void>;
	getCliInstallStatus(): Promise<ReviewCliInstallStatus>;
	applyCliInstall(request: {
		autoUpdate?: boolean;
		targets: readonly ReviewCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse>;
	removeCliInstall(request: {
		targets: readonly ReviewCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true;
	}): Promise<void>;
	declineCliInstall(): Promise<void>;
	skipCliInstallPrompts(): Promise<void>;
	resetCliInstallPrompts(): Promise<void>;
	attachControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): void;
}

export class ReviewDesktopConnectionService extends Disposable implements IReviewDesktopConnectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLists = this._register(new Emitter<void>());
	readonly onDidChangeLists = this._onDidChangeLists.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;

	private initializePromise: Promise<void> | null = null;
	private tutorialPreparePromise: Promise<void> | undefined;
	private tutorialPrepareAttempted = false;
	private cliInstallStatus: ReviewCliInstallStatus | undefined;
	private cliInstallStatusPromise: Promise<ReviewCliInstallStatus> | undefined;
	private readonly controller = new AbortController();
	private controlAttached = false;
	private controlDispatch: ((value: JsonValue) => Promise<ReviewVerbResponse>) | undefined;
	/**
	 * The main process owns the embedded server's endpoint and credentials and
	 * publishes them only once it has validated the server's ready event.
	 */
	private connection: ReviewDesktopConnection | undefined;
	private get serverUrl(): string {
		return this.requireConnection().url;
	}
	private get token(): string {
		return this.requireConnection().token;
	}
	private get instanceId(): string {
		return this.requireConnection().instanceId;
	}

	constructor(
		@IMainProcessService
		private readonly mainProcessService: IMainProcessService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	private requireConnection(): ReviewDesktopConnection {
		if (!this.connection) {
			throw new Error("The Review Desktop connection is not established yet.");
		}
		return this.connection;
	}

	private async connect(): Promise<void> {
		if (this.connection) return;
		const connection = (await this.mainProcessService
			.getChannel(REVIEW_DESKTOP_CHANNEL)
			.call("getConnection")) as ReviewDesktopConnection;
		if (connection?.version !== REVIEW_DESKTOP_CONNECTION_VERSION) {
			throw new Error(`Unsupported Review Desktop connection version: ${String(connection?.version)}.`);
		}
		this.connection = connection;
	}

	initialize(): Promise<void> {
		this.initializePromise ??= this.initializeGlobalState().catch((error) => {
			this.initializePromise = null;
			throw error;
		});
		return this.initializePromise;
	}

	async getConnection(): Promise<ReviewServerConnection> {
		await this.initialize();
		return { serverUrl: this.serverUrl, token: this.token };
	}

	/**
	 * The dismissed review retention window. It is a server preference rather
	 * than a workbench setting because the reaper runs inside the review server.
	 * `null` means never reap.
	 */
	async getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/status`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
		await this.requireOk(response, "Review tutorial status");
		const payload = (await response.json()) as {
			version?: unknown;
			reviewUuid?: unknown;
		};
		if (payload.version !== 1 || (payload.reviewUuid !== null && typeof payload.reviewUuid !== "string")) {
			throw new Error("Review tutorial status is invalid.");
		}
		return { version: 1, reviewUuid: payload.reviewUuid as string | null };
	}

	prepareTutorial(): Promise<void> {
		if (this.storageService.getBoolean(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION, false)) {
			return Promise.resolve();
		}
		if (this.tutorialPreparePromise) return this.tutorialPreparePromise;
		if (this.tutorialPrepareAttempted) return Promise.resolve();
		this.tutorialPrepareAttempted = true;
		const operation = this.requestTutorialPreparation();
		this.tutorialPreparePromise = operation;
		const clearOperation = () => {
			if (this.tutorialPreparePromise === operation) {
				this.tutorialPreparePromise = undefined;
			}
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	private async requestTutorialPreparation(): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/prepare`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "Review tutorial preparation");
	}

	async openTutorial(): Promise<ReviewTutorialOpenResponse> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/open`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "Review tutorial open");
		const payload = parseReviewTutorialOpenResponse(await response.json());
		this.tutorialPrepareAttempted = true;
		this.storageService.remove(REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION);
		return payload;
	}

	async deleteTutorial(): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial`, {
			method: "DELETE",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "Review tutorial delete");
		this.tutorialPreparePromise = undefined;
		this.tutorialPrepareAttempted = true;
		this.storageService.store(
			REVIEW_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY,
			true,
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		this._onDidChangeLists.fire();
	}

	/** Raises the server's own error message when it sends one. */
	private async requireOk(response: Response, what: string): Promise<void> {
		if (response.ok) {
			return;
		}
		const payload = (await response.json().catch(() => ({}))) as {
			error?: unknown;
		};
		throw new Error(typeof payload.error === "string" ? payload.error : `${what} returned ${response.status}.`);
	}

	async getCliInstallStatus(): Promise<ReviewCliInstallStatus> {
		await this.initialize();
		if (this.cliInstallStatus) return this.cliInstallStatus;
		this.cliInstallStatusPromise ??= (async () => {
			const response = await fetch(`${this.serverUrl}/install/status`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) {
				throw new Error(`Review install status returned ${response.status}.`);
			}
			const status = parseReviewCliInstallStatus(await response.json());
			this.cliInstallStatus = status;
			return status;
		})().finally(() => {
			this.cliInstallStatusPromise = undefined;
		});
		return this.cliInstallStatusPromise;
	}

	async applyCliInstall(request: {
		autoUpdate?: boolean;
		targets: readonly ReviewCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<ReviewCliInstallApplyResponse> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/apply`, {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				targets: request.targets,
				...(request.autoUpdate ? { autoUpdate: true } : {}),
				...(request.shim !== undefined ? { shim: request.shim } : {}),
				...(request.fff ? { fff: true } : {}),
				...(request.trace !== undefined ? { trace: request.trace } : {}),
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const payload: JsonValue = await response.json().catch(() => ({}));
		this.cliInstallStatus = undefined;
		if (!response.ok) {
			const detail = payload as { output?: unknown; error?: unknown };
			throw new Error(
				typeof detail.output === "string" && detail.output
					? detail.output
					: typeof detail.error === "string"
						? detail.error
						: `Review install returned ${response.status}.`,
			);
		}
		return parseReviewCliInstallApplyResponse(payload);
	}

	async removeCliInstall(request: {
		targets: readonly ReviewCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true;
	}): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/remove`, {
			method: "POST",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				targets: request.targets,
				...(request.shim ? { shim: true } : {}),
				...(request.fff ? { fff: true } : {}),
				...(request.trace ? { trace: true } : {}),
			}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Review install remove returned ${response.status}.`);
		}
		this.cliInstallStatus = undefined;
	}

	async declineCliInstall(): Promise<void> {
		await this.postCliInstallVerb("decline");
	}

	async skipCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("skip");
	}

	async resetCliInstallPrompts(): Promise<void> {
		await this.postCliInstallVerb("reset");
	}

	private async postCliInstallVerb(verb: "decline" | "skip" | "reset"): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/${verb}`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Review install ${verb} returned ${response.status}.`);
		}
		this.cliInstallStatus = undefined;
	}

	attachControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): void {
		this.controlDispatch = dispatch;
		if (this.controlAttached) return;
		this.controlAttached = true;
		void this.initializeAndMaintainControl((value) => {
			const current = this.controlDispatch;
			return current
				? current(value)
				: Promise.resolve({
						ok: false,
						error: "Review Desktop control handler is unavailable.",
					});
		});
	}

	override dispose(): void {
		this.controller.abort();
		super.dispose();
	}

	private async initializeGlobalState(): Promise<void> {
    await this.connect();
    await this.waitForHealth();
  }

	private async initializeAndMaintainControl(
		dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>,
	): Promise<void> {
		await reconnectUntilAborted(
			this.controller.signal,
			async () => {
				await this.initialize();
				await this.maintainControl(dispatch);
			},
			{
				onRetry: (error) => console.error("[Review Desktop] control channel stopped", error),
			},
		);
	}

	private async waitForHealth(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${this.serverUrl}/health`, {
					signal: AbortSignal.timeout(1_000),
				});
				const value = (await response.json()) as { instanceId?: unknown };
				if (response.ok && value.instanceId === this.instanceId) return;
			} catch {
				// The utility host may still be starting.
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("The embedded Review server did not become healthy.");
	}


	private async maintainControl(dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>): Promise<void> {
		await reconnectUntilAborted(
			this.controller.signal,
			async (onConnected) => {
				await this.consumeControl(dispatch, onConnected);
				if (this.controller.signal.aborted) return;
				throw new Error("The Review Desktop control stream ended.");
			},
			{
				onExhausted: (error) => {
					throw error;
				},
			},
		);
	}

	private async consumeControl(
		dispatch: (value: JsonValue) => Promise<ReviewVerbResponse>,
		onConnected: () => void,
	): Promise<void> {
		const url = new URL("/control", this.serverUrl);
		url.searchParams.set("token", this.token);
		const response = await fetch(url, { signal: this.controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Desktop control returned ${response.status}.`);
		}
		onConnected();
		await consumeReviewEventStream(
			response.body,
			async (value) => {
				const frame = parseReviewDesktopVerbFrame(value);
				let verbResponse: ReviewVerbResponse;
				try {
					verbResponse = await dispatch(frame.request);
				} catch (error) {
					verbResponse = {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
				await fetch(`${this.serverUrl}/control/result`, {
					method: "POST",
					headers: {
						...this.authHeaders(),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						id: frame.id,
						response: verbResponse,
					}),
					signal: this.controller.signal,
				});
			},
			this.controller.signal,
		);
	}

	private authHeaders(): Record<string, string> {
		return { "x-review-token": this.token };
	}
}

export async function reviewResponseError(response: Response, fallback: string): Promise<Error> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(typeof payload?.error === "string" && payload.error ? payload.error : fallback);
}
