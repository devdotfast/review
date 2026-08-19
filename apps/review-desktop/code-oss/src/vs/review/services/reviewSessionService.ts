/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../platform/ipc/common/mainProcessService.js";
import {
	REVIEW_DESKTOP_CHANNEL,
	REVIEW_DESKTOP_CONNECTION_VERSION,
	type ReviewDesktopConnection,
} from "../common/reviewDesktopBootstrap.js";
import {
	type ReviewCliInstallApplyResponse,
	type ReviewCliInstallStatus,
	type ReviewCliInstallTarget,
	type ReviewDescriptor,
	type ReviewDesktopGlobalEvent,
	type ReviewListError,
	type ReviewSessionDescriptor,
	type ReviewTutorialOpenResponse,
	type ReviewVerbResponse,
	parseReviewCliInstallApplyResponse,
	parseReviewCliInstallStatus,
	parseReviewDesktopGlobalEvent,
	parseReviewDesktopVerbFrame,
	parseReviewListResponse,
	parseReviewOpenResponse,
	parseReviewTutorialOpenResponse,
} from "../common/reviewProtocol.js";
import { consumeReviewEventStream } from "../common/reviewEventStream.js";
import { REVIEW_CLIENT_RECONNECT_DELAYS } from "../common/reviewReconnect.js";
import { IReviewTelemetryService } from "./reviewTelemetryService.js";

const REVIEW_LIST_TIMEOUT_MS = 30_000;

export interface ReviewSessionConnection {
	readonly serverUrl: string;
	readonly token: string;
}

export type ReviewDataChangedEvent = Extract<
	ReviewDesktopGlobalEvent,
	{ event: "review-data-changed" }
>;

export type ReviewThreadsCommittedEvent = Extract<
	ReviewDesktopGlobalEvent,
	{ event: "review-threads-committed" }
>;

export interface ReviewSessionClosedEvent {
	readonly session: ReviewSessionDescriptor;
	readonly review: ReviewDescriptor | undefined;
	readonly reason: string;
}

export interface ReviewSessionRegisteredEvent {
	readonly session: ReviewSessionDescriptor;
	/**
	 * The session was opened for a non-document surface (the Source tab
	 * rooting its file tree); the review document tab must not surface.
	 * Carried on the server event itself so suppression is data, not timing.
	 */
	readonly background: boolean;
}

export const IReviewSessionService = createDecorator<IReviewSessionService>(
	"reviewSessionService",
);

export interface IReviewSessionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeLists: Event<void>;
	readonly onDidChangeReviewData: Event<ReviewDataChangedEvent>;
	readonly onDidCommitReviewThreads: Event<ReviewThreadsCommittedEvent>;
	readonly onDidCloseSession: Event<ReviewSessionClosedEvent>;
	readonly onDidRegisterSession: Event<ReviewSessionRegisteredEvent>;
	readonly onDidDismissReview: Event<string>;
	readonly onDidDeleteReview: Event<string>;
	readonly onDidFail: Event<Error>;
	readonly sessions: readonly ReviewSessionDescriptor[];
	readonly reviews: readonly ReviewDescriptor[];
	readonly reviewErrors: readonly ReviewListError[];
	readonly tutorialReview: ReviewDescriptor | undefined;
	initialize(): Promise<void>;
	getConnection(): Promise<ReviewSessionConnection>;
	refresh(): Promise<void>;
	openReview(
		uuid: string,
		options?: { background?: boolean; revision?: string },
	): Promise<ReviewSessionDescriptor>;
	closeSession(sessionId: string): Promise<void>;
	deleteReview(uuid: string): Promise<void>;
	dismissReview(uuid: string): Promise<void>;
	restoreReview(uuid: string): Promise<void>;
	readDismissedRetentionDays(): Promise<number | null>;
	setDismissedRetentionDays(days: number | null): Promise<number | null>;
	getTutorialStatus(): Promise<{ version: 1; reviewUuid: string | null }>;
	openTutorial(): Promise<ReviewTutorialOpenResponse>;
	deleteTutorial(): Promise<void>;
	getCliInstallStatus(): Promise<ReviewCliInstallStatus>;
	applyCliInstall(request: {
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
	attachControl(
		dispatch: (
			sessionId: string,
			value: unknown,
		) => Promise<ReviewVerbResponse>,
	): void;
}

export class ReviewSessionService
	extends Disposable
	implements IReviewSessionService
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeLists = this._register(new Emitter<void>());
	readonly onDidChangeLists = this._onDidChangeLists.event;
	private readonly _onDidChangeReviewData = this._register(
		new Emitter<ReviewDataChangedEvent>(),
	);
	readonly onDidChangeReviewData = this._onDidChangeReviewData.event;
	private readonly _onDidCommitReviewThreads = this._register(
		new Emitter<ReviewThreadsCommittedEvent>(),
	);
	readonly onDidCommitReviewThreads = this._onDidCommitReviewThreads.event;
	private readonly _onDidCloseSession = this._register(
		new Emitter<ReviewSessionClosedEvent>(),
	);
	readonly onDidCloseSession = this._onDidCloseSession.event;
	private readonly _onDidRegisterSession = this._register(
		new Emitter<ReviewSessionRegisteredEvent>(),
	);
	readonly onDidRegisterSession = this._onDidRegisterSession.event;
	private readonly _onDidDismissReview = this._register(new Emitter<string>());
	readonly onDidDismissReview = this._onDidDismissReview.event;
	private readonly _onDidDeleteReview = this._register(new Emitter<string>());
	readonly onDidDeleteReview = this._onDidDeleteReview.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;

	private _sessionRecords: ReviewSessionDescriptor[] = [];
	get sessions(): readonly ReviewSessionDescriptor[] {
		return this._sessionRecords;
	}
	private _reviews: ReviewDescriptor[] = [];
	get reviews(): readonly ReviewDescriptor[] {
		return this._reviews;
	}
	private _reviewErrors: ReviewListError[] = [];
	get reviewErrors(): readonly ReviewListError[] {
		return this._reviewErrors;
	}
	/* The tutorial Review lives outside the review store, so it is never in
	   `reviews`. Open caches its descriptor here for tab and model fallbacks. */
	private _tutorialReview: ReviewDescriptor | undefined;
	get tutorialReview(): ReviewDescriptor | undefined {
		return this._tutorialReview;
	}

	private initializePromise: Promise<void> | null = null;
	private readonly controller = new AbortController();
	private controlAttached = false;
	private controlDispatch:
		| ((sessionId: string, value: unknown) => Promise<ReviewVerbResponse>)
		| undefined;
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
		@IReviewTelemetryService
		private readonly reviewTelemetryService: IReviewTelemetryService,
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
			throw new Error(
				`Unsupported Review Desktop connection version: ${String(connection?.version)}.`,
			);
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

	async getConnection(): Promise<ReviewSessionConnection> {
		await this.initialize();
		return { serverUrl: this.serverUrl, token: this.token };
	}

	async refresh(): Promise<void> {
		await this.initialize();
		await this.refreshLists();
	}

	async openReview(
		uuid: string,
		options?: { background?: boolean; revision?: string },
	): Promise<ReviewSessionDescriptor> {
		await this.initialize();
		if (uuid === this._tutorialReview?.uuid) {
			// The store has no record for the tutorial, so the normal open
			// endpoint would 404. The tutorial endpoint re-mounts it instead.
			const opened = await this.openTutorial();
			const descriptor = this._sessionRecords.find(
				(candidate) => candidate.sessionId === opened.sessionId,
			);
			if (!descriptor) {
				throw new Error(`Review session is unavailable: ${opened.sessionId}`);
			}
			return descriptor;
		}
		const response = await fetch(
			`${this.serverUrl}/reviews/${encodeURIComponent(uuid)}/open`,
			{
				method: "POST",
				headers: {
					...this.authHeaders(),
					"x-review-app-session-id": this.reviewTelemetryService.appSessionId,
					"content-type": "application/json",
				},
				// `background` opens the session without focusing its canvas:
				// the Source tab acquires sessions purely to root its file tree.
				body: JSON.stringify({
					background: options?.background === true,
					...(options?.revision ? { revision: options.revision } : {}),
				}),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) {
			const payload = (await response.json()) as { error?: unknown };
			throw new Error(
				typeof payload.error === "string"
					? payload.error
					: `Review open returned ${response.status}.`,
			);
		}
		const payload = parseReviewOpenResponse(await response.json());
		await this.refreshLists();
		const descriptor = this._sessionRecords.find(
			(candidate) => candidate.sessionId === payload.sessionId,
		);
		if (!descriptor) {
			throw new Error(`Review session is unavailable: ${payload.sessionId}`);
		}
		return descriptor;
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.initialize();
		await fetch(
			`${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}`,
			{
				method: "DELETE",
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			},
		).catch(() => undefined);
		await this.refreshLists().catch(() => undefined);
	}

	async deleteReview(uuid: string): Promise<void> {
		await this.initialize();
		const response = await fetch(
			`${this.serverUrl}/reviews/${encodeURIComponent(uuid)}`,
			{
				method: "DELETE",
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) {
			const payload = (await response.json().catch(() => ({}))) as {
				error?: unknown;
			};
			throw new Error(
				typeof payload.error === "string"
					? payload.error
					: `Review delete returned ${response.status}.`,
			);
		}
		await this.refreshLists();
	}

	/**
	 * Dismissal and its undo. Both only stamp the review, so unlike deleteReview
	 * they leave the directory and any open session alone.
	 */
	async dismissReview(uuid: string): Promise<void> {
		await this.postReviewAttention(uuid, 'dismiss');
	}

	async restoreReview(uuid: string): Promise<void> {
		await this.postReviewAttention(uuid, 'restore');
	}

	private async postReviewAttention(
		uuid: string,
		action: 'dismiss' | 'restore',
	): Promise<void> {
		await this.initialize();
		const response = await fetch(
			`${this.serverUrl}/reviews/${encodeURIComponent(uuid)}/${action}`,
			{
				method: "POST",
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(30_000),
			},
		);
		await this.requireOk(response, `Review ${action}`);
		await this.refreshLists();
	}

	/**
	 * The dismissed review retention window. It is a server preference rather
	 * than a workbench setting because the reaper runs inside the review server.
	 * `null` means never reap.
	 */
	async readDismissedRetentionDays(): Promise<number | null> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "Review preferences");
		const payload = (await response.json()) as {
			dismissedRetentionDays?: unknown;
		};
		return typeof payload.dismissedRetentionDays === "number"
			? payload.dismissedRetentionDays
			: null;
	}

	/**
	 * Returns the value the server stored, which it clamps. The list refresh
	 * comes from the `preferences-changed` broadcast, not from here.
	 */
	async setDismissedRetentionDays(days: number | null): Promise<number | null> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/preferences`, {
			method: "PUT",
			headers: {
				...this.authHeaders(),
				"content-type": "application/json",
			},
			body: JSON.stringify({ dismissedRetentionDays: days }),
			signal: AbortSignal.timeout(30_000),
		});
		await this.requireOk(response, "Review preferences");
		const payload = (await response.json()) as {
			dismissedRetentionDays?: unknown;
		};
		return typeof payload.dismissedRetentionDays === "number"
			? payload.dismissedRetentionDays
			: null;
	}

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
		if (
			payload.version !== 1 ||
			(payload.reviewUuid !== null && typeof payload.reviewUuid !== "string")
		) {
			throw new Error("Review tutorial status is invalid.");
		}
		return { version: 1, reviewUuid: payload.reviewUuid as string | null };
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
		this._tutorialReview = payload.review;
		// The sessions list must carry the new session before the tab resolves
		// its model. The reviews list never lists the tutorial.
		await this.refreshLists();
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
		this._tutorialReview = undefined;
		await this.refreshLists();
	}

	/** Raises the server's own error message when it sends one. */
	private async requireOk(response: Response, what: string): Promise<void> {
		if (response.ok) {
			return;
		}
		const payload = (await response.json().catch(() => ({}))) as {
			error?: unknown;
		};
		throw new Error(
			typeof payload.error === "string"
				? payload.error
				: `${what} returned ${response.status}.`,
		);
	}

	async getCliInstallStatus(): Promise<ReviewCliInstallStatus> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/status`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Review install status returned ${response.status}.`);
		}
		return parseReviewCliInstallStatus(await response.json());
	}

	async applyCliInstall(request: {
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
				...(request.shim ? { shim: true } : {}),
				...(request.fff ? { fff: true } : {}),
				...(request.trace !== undefined ? { trace: request.trace } : {}),
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const payload: unknown = await response.json().catch(() => ({}));
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

	private async postCliInstallVerb(
		verb: "decline" | "skip" | "reset",
	): Promise<void> {
		await this.initialize();
		const response = await fetch(`${this.serverUrl}/install/${verb}`, {
			method: "POST",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`Review install ${verb} returned ${response.status}.`);
		}
	}

	attachControl(
		dispatch: (
			sessionId: string,
			value: unknown,
		) => Promise<ReviewVerbResponse>,
	): void {
		this.controlDispatch = dispatch;
		if (this.controlAttached) return;
		this.controlAttached = true;
		void this.initializeAndMaintainControl((sessionId, value) => {
			const current = this.controlDispatch;
			return current
				? current(sessionId, value)
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
		await this.refreshLists();
		void this.maintainGlobalEvents().catch((error) => {
			if (this.controller.signal.aborted) return;
			this._onDidFail.fire(
				error instanceof Error ? error : new Error(String(error)),
			);
		});
	}

	private async initializeAndMaintainControl(
		dispatch: (
			sessionId: string,
			value: unknown,
		) => Promise<ReviewVerbResponse>,
	): Promise<void> {
		let attempt = 0;
		while (!this.controller.signal.aborted) {
			try {
				await this.initialize();
				await this.maintainControl(dispatch);
				return;
			} catch (error) {
				if (this.controller.signal.aborted) return;
				console.error("[Review Desktop] control channel stopped", error);
				const delay =
					REVIEW_CLIENT_RECONNECT_DELAYS[
						Math.min(attempt++, REVIEW_CLIENT_RECONNECT_DELAYS.length - 1)
					] ?? 1_000;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
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

	private async refreshLists(): Promise<void> {
		const [sessionsResponse, reviewsResponse] = await Promise.all([
			fetch(`${this.serverUrl}/sessions?limit=100`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(REVIEW_LIST_TIMEOUT_MS),
			}),
			fetch(`${this.serverUrl}/reviews?limit=100`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(REVIEW_LIST_TIMEOUT_MS),
			}),
		]);
		if (!sessionsResponse.ok) {
			throw await reviewResponseError(
				sessionsResponse,
				`Review session list returned ${sessionsResponse.status}.`,
			);
		}
		if (!reviewsResponse.ok) {
			throw await reviewResponseError(
				reviewsResponse,
				`Review list returned ${reviewsResponse.status}.`,
			);
		}
		this._sessionRecords = (
			(await sessionsResponse.json()) as { items: ReviewSessionDescriptor[] }
		).items;
		this.applyReviewList(await reviewsResponse.json());
		this._onDidChangeLists.fire();
	}

	private async refreshReviews(): Promise<void> {
		const response = await fetch(`${this.serverUrl}/reviews?limit=100`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(REVIEW_LIST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw await reviewResponseError(
				response,
				`Review list returned ${response.status}.`,
			);
		}
		this.applyReviewList(await response.json());
		this._onDidChangeLists.fire();
	}

	/**
	 * The server lists every review, drafts included. A review stays a draft
	 * until its first publish, so it belongs to no picker or list event yet.
	 */
	private applyReviewList(payload: unknown): void {
		const parsed = parseReviewListResponse(payload);
		this._reviews = parsed.reviews.filter(
			(review) => review.status !== "draft",
		);
		this._reviewErrors = parsed.errors;
	}

	private async maintainGlobalEvents(): Promise<void> {
		let attempt = 0;
		while (!this.controller.signal.aborted) {
			try {
				await this.watchGlobalEvents(() => {
					attempt = 0;
				});
				if (this.controller.signal.aborted) return;
				throw new Error("The embedded Review server event stream ended.");
			} catch (error) {
				if (this.controller.signal.aborted) return;
				const delay = REVIEW_CLIENT_RECONNECT_DELAYS[attempt++];
				if (delay === undefined) {
					throw new Error(
						"The embedded Review server exhausted its restart attempts.",
						{ cause: error },
					);
				}
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	private async watchGlobalEvents(onConnected: () => void): Promise<void> {
		const url = new URL("/events", this.serverUrl);
		url.searchParams.set("token", this.token);
		const response = await fetch(url, { signal: this.controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Review events returned ${response.status}.`);
		}
		try {
			await this.refreshLists();
		} catch (error) {
			await response.body.cancel().catch(() => undefined);
			throw error;
		}
		onConnected();
		await consumeReviewEventStream(
			response.body,
			async (value) => {
				const event = parseReviewDesktopGlobalEvent(value);
				if (event.event === "review-data-changed") {
					this._onDidChangeReviewData.fire(event);
					return;
				}
				if (event.event === "review-threads-committed") {
					this._onDidCommitReviewThreads.fire(event);
					return;
				}
				if (event.event === "session-registered") {
					this.upsertSession(event.session);
					await this.refreshReviews();
					this._onDidRegisterSession.fire({
						session: event.session,
						background: event.background === true,
					});
					return;
				}
				if (event.event === "session-updated") {
					this.upsertSession(event.session);
					await this.refreshReviews();
					return;
				}
				if (event.event === "review-status-changed") {
					await this.refreshReviews();
					return;
				}
				// Dismissal only stamps the review, so the list is re-read rather
				// than pruned: the row moves to the dismissed group, it does not go.
				if (event.event === "review-attention-changed") {
					await this.refreshReviews();
					if (event.attention === "dismissed") {
						this._onDidDismissReview.fire(event.uuid);
					}
					return;
				}
				if (event.event === "preferences-changed") {
					await this.refreshReviews();
					return;
				}
				if (event.event === "review-deleted") {
					this._reviews = this._reviews.filter(
						(review) => review.uuid !== event.uuid,
					);
					this._onDidChangeLists.fire();
					this._onDidDeleteReview.fire(event.uuid);
					return;
				}
				const closed = this._sessionRecords.find(
					(item) => item.sessionId === event.sessionId,
				);
				this._sessionRecords = this._sessionRecords.filter(
					(item) => item.sessionId !== event.sessionId,
				);
				if (closed) {
					this._onDidCloseSession.fire({
						session: closed,
						review: this._reviews.find(
							(review) => review.uuid === closed.reviewUuid,
						),
						reason: event.reason,
					});
				}
				this._onDidChangeLists.fire();
			},
			this.controller.signal,
		);
	}

	private async maintainControl(
		dispatch: (
			sessionId: string,
			value: unknown,
		) => Promise<ReviewVerbResponse>,
	): Promise<void> {
		let attempt = 0;
		while (!this.controller.signal.aborted) {
			try {
				await this.consumeControl(dispatch, () => {
					attempt = 0;
				});
				if (this.controller.signal.aborted) return;
				throw new Error("The Review Desktop control stream ended.");
			} catch (error) {
				if (this.controller.signal.aborted) return;
				const delay = REVIEW_CLIENT_RECONNECT_DELAYS[attempt++];
				if (delay === undefined) throw error;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	private async consumeControl(
		dispatch: (
			sessionId: string,
			value: unknown,
		) => Promise<ReviewVerbResponse>,
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
					verbResponse = await dispatch(frame.sessionId, frame.request);
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
						sessionId: frame.sessionId,
						response: verbResponse,
					}),
					signal: this.controller.signal,
				});
			},
			this.controller.signal,
		);
	}

	private upsertSession(session: ReviewSessionDescriptor): void {
		this._sessionRecords = [
			session,
			...this._sessionRecords.filter(
				(item) => item.sessionId !== session.sessionId,
			),
		];
		this._onDidChangeLists.fire();
	}

	private authHeaders(): Record<string, string> {
		return { "x-review-token": this.token };
	}
}

async function reviewResponseError(
	response: Response,
	fallback: string,
): Promise<Error> {
	const payload = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(
		typeof payload?.error === "string" && payload.error
			? payload.error
			: fallback,
	);
}
