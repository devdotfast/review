/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { ReviewSessionTelemetry } from './reviewSessionTelemetry.js';

function setup() {
	const events: Array<{ name: string; properties: Record<string, unknown>; context: unknown }> = [];
	let now = 1000;
	let ids = 0;
	const telemetry = new ReviewSessionTelemetry(
		(name, properties, context) => events.push({ name, properties, context }),
		() => now,
		() => `p${++ids}`,
	);
	return { events, telemetry, advance: (ms: number) => (now += ms) };
}

test('a session starts, presents once and ends with its duration', () => {
	const { events, telemetry, advance } = setup();
	telemetry.start('review-a');
	advance(250);
	telemetry.presented();
	telemetry.presented();
	advance(1000);
	telemetry.end('closed');
	telemetry.end('closed');

	assert.deepEqual(events, [
		{ name: 'session_started', properties: {}, context: { reviewUuid: 'review-a', presentationSessionId: 'p1' } },
		{ name: 'review_presented', properties: { load_ms: 250 }, context: { reviewUuid: 'review-a', presentationSessionId: 'p1' } },
		{ name: 'session_ended', properties: { outcome: 'closed', duration_ms: 1250 }, context: { reviewUuid: 'review-a', presentationSessionId: 'p1' } },
	]);
});

test('a resumed session is presented without a load time', () => {
	const { events, telemetry, advance } = setup();
	telemetry.start('review-a');
	advance(5);
	telemetry.resumed();
	telemetry.presented();

	assert.deepEqual(events.map((e) => [e.name, e.properties]), [
		['session_started', {}],
		['review_presented', {}],
	]);
});

test('opening another review closes the current one first', () => {
	const { events, telemetry } = setup();
	telemetry.start('review-a');
	telemetry.start('review-b');
	telemetry.end('app_quit');

	assert.deepEqual(events.map((e) => [e.name, e.properties.outcome, (e.context as { presentationSessionId: string }).presentationSessionId]), [
		['session_started', undefined, 'p1'],
		['session_ended', 'closed', 'p1'],
		['session_started', undefined, 'p2'],
		['session_ended', 'app_quit', 'p2'],
	]);
});
