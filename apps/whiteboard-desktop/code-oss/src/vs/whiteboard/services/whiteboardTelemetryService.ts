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
	WHITEBOARD_DESKTOP_CHANNEL,
	type WhiteboardDesktopConnection,
} from "../common/whiteboardDesktopBootstrap.js";
import { WHITEBOARD_TELEMETRY_SETTING } from "../common/whiteboardConfigurationDefaults.js";
import type { WhiteboardErrorReport } from "../common/whiteboardErrorReport.js";
import { whiteboardTelemetryEventRequest } from "../common/whiteboardTelemetryRequest.js";

type WhiteboardTelemetryProperties = Record<string, string | number | boolean>;

interface QueuedWhiteboardTelemetryEvent {
	readonly name: string;
	readonly properties: WhiteboardTelemetryProperties | undefined;
	readonly error?: WhiteboardErrorReport;
}

export const IWhiteboardTelemetryService = createDecorator<IWhiteboardTelemetryService>(
	"whiteboardTelemetryService",
);

export interface IWhiteboardTelemetryService {
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
	capture(name: string, properties?: WhiteboardTelemetryProperties, error?: WhiteboardErrorReport): void;
	/** Best-effort flush. Resolves within approximately 500 ms. */
	flush(): Promise<void>;
}

export class WhiteboardTelemetryService implements IWhiteboardTelemetryService {
	declare readonly _serviceBrand: undefined;
	readonly appSessionId = generateUuid();

	private readonly queued: QueuedWhiteboardTelemetryEvent[] = [];
	private readonly inFlight = new Set<Promise<void>>();
	private readonly connectionPromise: Promise<WhiteboardDesktopConnection | undefined>;
	private connection: WhiteboardDesktopConnection | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		this.connectionPromise = mainProcessService
			.getChannel(WHITEBOARD_DESKTOP_CHANNEL)
			.call<WhiteboardDesktopConnection>("getConnection")
			.then((connection) => {
				this.connection = connection;
				this.drainQueue();
				return connection;
			})
			.catch(() => undefined);
		lifecycleService.onWillShutdown((event) => {
			event.join(this.flush(), {
				id: "whiteboardTelemetryService.flush",
				label: "Sending Whiteboard telemetry",
			});
		});
	}

	capture(name: string, properties?: WhiteboardTelemetryProperties, error?: WhiteboardErrorReport): void {
		if (this.configurationService.getValue(WHITEBOARD_TELEMETRY_SETTING) === false) {
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

	private send(event: QueuedWhiteboardTelemetryEvent): void {
		const connection = this.connection;
		if (!connection) return;
		let request: Promise<void>;
		request = fetch(
			`${connection.url}/telemetry/event`,
			whiteboardTelemetryEventRequest(
				{ token: connection.token, appSessionId: this.appSessionId },
				event,
				{ keepalive: true },
			),
		)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => this.inFlight.delete(request));
		this.inFlight.add(request);
	}
}
