/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from "../../base/common/uuid.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../platform/ipc/common/mainProcessService.js";
import { ILifecycleService } from "../../workbench/services/lifecycle/common/lifecycle.js";
import {
	REVIEW_DESKTOP_CHANNEL,
	type ReviewDesktopConnection,
} from "../common/reviewDesktopBootstrap.js";
import { REVIEW_TELEMETRY_SETTING } from "../common/reviewConfigurationDefaults.js";
import type { ReviewErrorReport } from "../common/reviewErrorReport.js";

type ReviewTelemetryProperties = Record<string, string | number | boolean>;

interface QueuedReviewTelemetryEvent {
	readonly name: string;
	readonly properties: ReviewTelemetryProperties | undefined;
	readonly error?: ReviewErrorReport;
}

export const IReviewTelemetryService = createDecorator<IReviewTelemetryService>(
	"reviewTelemetryService",
);

export interface IReviewTelemetryService {
	readonly _serviceBrand: undefined;
	/** The per-window session id all workbench events carry. */
	readonly appSessionId: string;
	/**
	 * Fire-and-forget. Never throws. Drops when telemetry is off.
	 *
	 * `error` carries the raw name, message, and stack beside the allowlisted
	 * properties, never inside them. It reaches only the loopback server on this
	 * machine, which replaces the message with a digest and keeps only the stack
	 * frames that resolve inside the shipped bundle.
	 */
	capture(name: string, properties?: ReviewTelemetryProperties, error?: ReviewErrorReport): void;
	/** Best-effort flush. Resolves within approximately 500 ms. */
	flush(): Promise<void>;
}

export class ReviewTelemetryService implements IReviewTelemetryService {
	declare readonly _serviceBrand: undefined;
	readonly appSessionId = generateUuid();

	private readonly queued: QueuedReviewTelemetryEvent[] = [];
	private readonly inFlight = new Set<Promise<void>>();
	private readonly connectionPromise: Promise<ReviewDesktopConnection | undefined>;
	private connection: ReviewDesktopConnection | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		this.connectionPromise = mainProcessService
			.getChannel(REVIEW_DESKTOP_CHANNEL)
			.call<ReviewDesktopConnection>("getConnection")
			.then((connection) => {
				this.connection = connection;
				this.drainQueue();
				return connection;
			})
			.catch(() => undefined);
		lifecycleService.onWillShutdown((event) => {
			event.join(this.flush(), {
				id: "reviewTelemetryService.flush",
				label: "Sending Review telemetry",
			});
		});
	}

	capture(name: string, properties?: ReviewTelemetryProperties, error?: ReviewErrorReport): void {
		if (this.configurationService.getValue(REVIEW_TELEMETRY_SETTING) === false) {
			return;
		}
		const event = { name, properties, ...(error ? { error } : {}) };
		if (this.connection) {
			this.send(event);
			return;
		}
		this.queued.push(event);
		if (this.queued.length > 100) this.queued.shift();
	}

	async flush(): Promise<void> {
		const flushPending = async (): Promise<void> => {
			await this.connectionPromise;
			this.drainQueue();
			await Promise.all([...this.inFlight]);
		};
		await Promise.race([
			flushPending(),
			new Promise<void>((resolve) => setTimeout(resolve, 500)),
		]);
	}

	private drainQueue(): void {
		if (!this.connection) return;
		for (const event of this.queued.splice(0)) this.send(event);
	}

	private send(event: QueuedReviewTelemetryEvent): void {
		const connection = this.connection;
		if (!connection) return;
		let request: Promise<void>;
		request = fetch(`${connection.url}/telemetry/event`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-review-token": connection.token,
				"x-review-app-session-id": this.appSessionId,
			},
			body: JSON.stringify(event),
			keepalive: true,
		})
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => this.inFlight.delete(request));
		this.inFlight.add(request);
	}
}
