/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewTelemetryAuth {
	readonly token: string;
	readonly appSessionId: string;
}

/**
 * The POST every telemetry sender makes to a Review server `telemetry/event`
 * endpoint; callers pick the URL and how the request is dispatched.
 */
export function reviewTelemetryEventRequest(
	auth: ReviewTelemetryAuth,
	event: unknown,
	options: { readonly keepalive?: boolean } = {},
): RequestInit {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-review-token": auth.token,
			"x-review-app-session-id": auth.appSessionId,
		},
		body: JSON.stringify(event),
		keepalive: options.keepalive ?? false,
	};
}
