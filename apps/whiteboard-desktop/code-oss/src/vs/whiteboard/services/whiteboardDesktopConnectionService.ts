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
WHITEBOARD_DESKTOP_CHANNEL,
WHITEBOARD_DESKTOP_CONNECTION_VERSION,
type WhiteboardDesktopConnection,
} from "../common/whiteboardDesktopBootstrap.js";
import { consumeWhiteboardEventStream } from "../common/whiteboardEventStream.js";
import {
type JsonValue,
	type WhiteboardDiffrConfig,
	type WhiteboardDiffrSummarizerInput,
	isJsonObject,
	parseWhiteboardDiffrConfig,
parseWhiteboardCliInstallApplyResponse,
parseWhiteboardCliInstallStatus,
parseWhiteboardDesktopVerbFrame,
parseWhiteboardTutorialOpenResponse,
type WhiteboardCliInstallApplyResponse,
type WhiteboardCliInstallStatus,
type WhiteboardCliInstallTarget,
type WhiteboardTutorialOpenResponse,
type WhiteboardVerbResponse
} from "../common/whiteboardProtocol.js";
import { reconnectUntilAborted } from "../common/whiteboardReconnect.js";

const WHITEBOARD_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY = "review.tutorial.autoPrepareSuppressed.v1";

export interface WhiteboardServerConnection {
	readonly serverUrl: string;
	readonly token: string;
}


export const IWhiteboardDesktopConnectionService = createDecorator<IWhiteboardDesktopConnectionService>(
	"whiteboardDesktopConnectionService",
);

export interface IWhiteboardDesktopConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidFail: Event<Error>;
	readonly onDidChangeLists: Event<void>;
	/** Fires at control-stream connection/disconnection boundaries, before reuse. */
	readonly onDidChangeConnection: Event<void>;
	initialize(): Promise<void>;
	getConnection(): Promise<WhiteboardServerConnection>;
	readDiffrConfig(): Promise<WhiteboardDiffrConfig>;
	saveDiffrSummarizer(input: WhiteboardDiffrSummarizerInput): Promise<WhiteboardDiffrConfig>;
	testDiffrSummarizer(input: WhiteboardDiffrSummarizerInput): Promise<string>;
	setDiffrConfigValue(key: string, value: JsonValue): Promise<WhiteboardDiffrConfig>;
	/** The scratchpad preference: a server preference, since `review install` reads it too. */
	readScratchpadEnabled(): Promise<boolean>;
	setScratchpadEnabled(enabled: boolean): Promise<boolean>;
	getTutorialStatus(): Promise<{ version: 1; sessionId: string | null }>;
	prepareTutorial(): Promise<void>;
	openTutorial(): Promise<WhiteboardTutorialOpenResponse>;
	deleteTutorial(): Promise<void>;
	getCliInstallStatus(): Promise<WhiteboardCliInstallStatus>;
	applyCliInstall(request: {
		autoUpdate?: boolean;
		targets: readonly WhiteboardCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<WhiteboardCliInstallApplyResponse>;
	removeCliInstall(request: {
		targets: readonly WhiteboardCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true;
	}): Promise<void>;
	declineCliInstall(): Promise<void>;
	skipCliInstallPrompts(): Promise<void>;
	resetCliInstallPrompts(): Promise<void>;
	attachControl(dispatch: (value: JsonValue) => Promise<WhiteboardVerbResponse>): void;
}

export class WhiteboardDesktopConnectionService extends Disposable implements IWhiteboardDesktopConnectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLists = this._register(new Emitter<void>());
	readonly onDidChangeLists = this._onDidChangeLists.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;
	private readonly connectionChanged = this._register(new Emitter<void>());
	readonly onDidChangeConnection = this.connectionChanged.event;

	private initializePromise: Promise<void> | null = null;
	private tutorialPreparePromise: Promise<void> | undefined;
	private tutorialPrepareAttempted = false;
	private cliInstallStatusPromise: Promise<WhiteboardCliInstallStatus> | undefined;
	private readonly controller = new AbortController();
	private controlAttached = false;
	private controlDispatch: ((value: JsonValue) => Promise<WhiteboardVerbResponse>) | undefined;
	/**
	 * The main process owns the embedded server's endpoint and credentials and
	 * publishes them only once it has validated the server's ready event.
	 */
	private connection: WhiteboardDesktopConnection | undefined;
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

	private requireConnection(): WhiteboardDesktopConnection {
		if (!this.connection) {
			throw new Error("The Whiteboard connection is not established yet.");
		}
		return this.connection;
	}

	private async connect(): Promise<void> {
		if (this.connection) return;
		const connection = (await this.mainProcessService
			.getChannel(WHITEBOARD_DESKTOP_CHANNEL)
			.call("getConnection")) as WhiteboardDesktopConnection;
		if (connection?.version !== WHITEBOARD_DESKTOP_CONNECTION_VERSION) {
			throw new Error(`Unsupported Whiteboard connection version: ${String(connection?.version)}.`);
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

	async getConnection(): Promise<WhiteboardServerConnection> {
		await this.initialize();
		return { serverUrl: this.serverUrl, token: this.token };
	}

	/**
	 * The dismissed review retention window. It is a server preference rather
	 * than a workbench setting because the reaper runs inside the review server.
	 * `null` means never reap.
	 */
	async readDiffrConfig(): Promise<WhiteboardDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "diffr configuration");
		return parseWhiteboardDiffrConfig(await response.json());
	}

	async setDiffrConfigValue(key: string, value: JsonValue): Promise<WhiteboardDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config`, {
			method: "PUT",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({ key, value }),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "diffr configuration");
		return parseWhiteboardDiffrConfig(await response.json());
	}

	async readScratchpadEnabled(): Promise<boolean> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences/scratchpad`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "scratchpad preference");
		return parseScratchpadPreference(await response.json());
	}

	async setScratchpadEnabled(enabled: boolean): Promise<boolean> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences/scratchpad`, {
			method: "PUT",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
			// Also installs or removes the scratchpad skill for every agent.
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "scratchpad preference");
		return parseScratchpadPreference(await response.json());
	}

	async saveDiffrSummarizer(input: WhiteboardDiffrSummarizerInput): Promise<WhiteboardDiffrConfig> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config/summarizer`, {
			method: "PUT",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "summary settings");
		return parseWhiteboardDiffrConfig(await response.json());
	}

	async testDiffrSummarizer(input: WhiteboardDiffrSummarizerInput): Promise<string> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/diffr-config/summarizer/test`, {
			method: "POST",
			headers: { ...this.authHeaders(), "content-type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(95_000),
		});
		await this.requireOk(response, "summary test");
		const result: unknown = await response.json();
		if (!isJsonObject(result) || typeof result.summary !== "string") throw new Error("Malformed summary test response.");
		return result.summary;
	}

	async getTutorialStatus(): Promise<{ version: 1; sessionId: string | null }> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/status`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
		await this.requireOk(response, "Whiteboard tutorial status");
		const payload = (await response.json()) as {
			version?: unknown;
			sessionId?: unknown;
		};
		if (payload.version !== 1 || (payload.sessionId !== null && typeof payload.sessionId !== "string")) {
			throw new Error("Whiteboard tutorial status is invalid.");
		}
		return { version: 1, sessionId: payload.sessionId as string | null };
	}

	prepareTutorial(): Promise<void> {
		if (this.storageService.getBoolean(WHITEBOARD_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION, false)) {
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
		await this.requireOk(response, "Whiteboard tutorial preparation");
	}

	async openTutorial(): Promise<WhiteboardTutorialOpenResponse> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial/open`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(120_000),
		});
		await this.requireOk(response, "Whiteboard tutorial open");
		const payload = parseWhiteboardTutorialOpenResponse(await response.json());
		this.tutorialPrepareAttempted = true;
		this.storageService.remove(WHITEBOARD_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY, StorageScope.APPLICATION);
		return payload;
	}

	async deleteTutorial(): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/tutorial`, {
			method: "DELETE",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "Whiteboard tutorial delete");
		this.tutorialPreparePromise = undefined;
		this.tutorialPrepareAttempted = true;
		this.storageService.store(
			WHITEBOARD_TUTORIAL_AUTOPREPARE_SUPPRESSED_KEY,
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

	async getCliInstallStatus(): Promise<WhiteboardCliInstallStatus> {
		await this.initialize();
		this.cliInstallStatusPromise ??= (async () => {
			const response = await fetch(`${this.serverUrl}/install/status`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			});
			await this.requireOk(response, "Whiteboard install status");
			return parseWhiteboardCliInstallStatus(await response.json());
		})().finally(() => {
			this.cliInstallStatusPromise = undefined;
		});
		return this.cliInstallStatusPromise;
	}

	async applyCliInstall(request: {
		autoUpdate?: boolean;
		targets: readonly WhiteboardCliInstallTarget[];
		shim?: boolean;
		fff?: boolean;
		trace?: true | { endpoint?: string; bucket?: string; key?: string; secret?: string };
	}): Promise<WhiteboardCliInstallApplyResponse> {
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
		if (!response.ok) {
			const detail = payload as { output?: unknown; error?: unknown };
			throw new Error(
				typeof detail.output === "string" && detail.output
					? detail.output
					: typeof detail.error === "string"
						? detail.error
						: `Whiteboard install returned ${response.status}.`,
			);
		}
		return parseWhiteboardCliInstallApplyResponse(payload);
	}

	async removeCliInstall(request: {
		targets: readonly WhiteboardCliInstallTarget[];
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
			throw new Error(`Whiteboard install remove returned ${response.status}.`);
		}
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
			throw new Error(`Whiteboard install ${verb} returned ${response.status}.`);
		}
	}

	attachControl(dispatch: (value: JsonValue) => Promise<WhiteboardVerbResponse>): void {
		this.controlDispatch = dispatch;
		if (this.controlAttached) return;
		this.controlAttached = true;
		void this.initializeAndMaintainControl((value) => {
			const current = this.controlDispatch;
			return current
				? current(value)
				: Promise.resolve({
						ok: false,
						error: "Whiteboard control handler is unavailable.",
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
		dispatch: (value: JsonValue) => Promise<WhiteboardVerbResponse>,
	): Promise<void> {
		await reconnectUntilAborted(
			this.controller.signal,
			async () => {
				await this.initialize();
				await this.maintainControl(dispatch);
			},
			{
				onRetry: (error) => console.error("[Whiteboard] control channel stopped", error),
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
		throw new Error("The embedded Whiteboard server did not become healthy.");
	}


	private async maintainControl(dispatch: (value: JsonValue) => Promise<WhiteboardVerbResponse>): Promise<void> {
		await reconnectUntilAborted(
			this.controller.signal,
			async (onConnected) => {
				await this.consumeControl(dispatch, onConnected);
				if (this.controller.signal.aborted) return;
				throw new Error("The Whiteboard control stream ended.");
			},
			{
				onExhausted: (error) => {
					throw error;
				},
			},
		);
	}

	private async consumeControl(
		dispatch: (value: JsonValue) => Promise<WhiteboardVerbResponse>,
		onConnected: () => void,
	): Promise<void> {
		const url = new URL("/control", this.serverUrl);
		url.searchParams.set("token", this.token);
		const response = await fetch(url, { signal: this.controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Desktop control returned ${response.status}.`);
		}
		this.connectionChanged.fire();
		onConnected();
		await consumeWhiteboardEventStream(
			response.body,
			async (value) => {
				const frame = parseWhiteboardDesktopVerbFrame(value);
				let verbResponse: WhiteboardVerbResponse;
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
		).finally(() => this.connectionChanged.fire());
	}

	private authHeaders(): Record<string, string> {
		return { "x-whiteboard-token": this.token };
	}
}

export async function whiteboardResponseError(response: Response, fallback: string): Promise<Error> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(typeof payload?.error === "string" && payload.error ? payload.error : fallback);
}

function parseScratchpadPreference(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("enabled" in value) || typeof value.enabled !== "boolean") {
		throw new Error("scratchpad preference response is malformed.");
	}
	return value.enabled;
}
