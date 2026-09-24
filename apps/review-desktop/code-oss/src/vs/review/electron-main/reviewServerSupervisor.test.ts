/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { Emitter } from '../../base/common/event.js';
import { REVIEW_DESKTOP_CONNECTION_VERSION } from '../common/reviewDesktopBootstrap.js';
import {
	applicationPath,
	createReviewServerEnvironment,
	type IReviewServerProcess,
	type ReviewServerTermination,
	ReviewServerSupervisor,
} from './reviewServerSupervisor.js';

test('the trusted product version overrides inherited environment values', () => {
	const environment = createReviewServerEnvironment({
		applicationEnvironment: {
			DEV_FAST_REVIEW_APP_VERSION: '0.0.1',
			PATH: '/application/bin',
		},
		resolvedEnvironment: {
			DEV_FAST_REVIEW_APP_VERSION: '99.0.0',
			PATH: '/login/bin',
		},
		appVersion: '0.0.16',
		serverEntry: '/review/server.js',
		port: 4321,
		token: 'token',
		instanceId: 'instance',
		appPid: 1234,
		telemetryEnabled: true,
		appSessionId: 'session',
		channel: 'stable',
	});

	assert.equal(environment.PATH, '/login/bin');
	assert.equal(environment.DEV_FAST_REVIEW_APP_VERSION, '0.0.16');
	assert.equal(environment.DEV_FAST_REVIEW_SERVER_ENTRY, '/review/server.js');
	assert.equal(environment.DEV_FAST_REVIEW_SERVER_PORT, '4321');
	assert.equal(environment.DEV_FAST_REVIEW_TELEMETRY_DISABLED, undefined);
});

for (const protocol of ['dev-fast-review', 'dev-fast-review-preview']) {
	test(`the app protocol overrides the shell protocol (${protocol})`, () => {
		const environment = createReviewServerEnvironment({
			applicationEnvironment: { DEV_FAST_REVIEW_APP_URL_PROTOCOL: 'inherited' },
			resolvedEnvironment: { DEV_FAST_REVIEW_APP_URL_PROTOCOL: 'shell' },
			appVersion: '0.0.16',
			appUrlProtocol: protocol,
			serverEntry: '/review/server.js',
			port: 4321,
			token: 'token',
			instanceId: 'instance',
			appPid: 1234,
			telemetryEnabled: true,
			appSessionId: 'session',
			channel: 'stable',
		});
		assert.equal(environment.DEV_FAST_REVIEW_APP_URL_PROTOCOL, protocol);
	});
}

test('the server inherits the app session id, channel and crash dump directory the supervisor chose', () => {
	const environment = createReviewServerEnvironment({
		applicationEnvironment: { DEV_FAST_REVIEW_APP_SESSION_ID: 'stale', DEV_FAST_REVIEW_CHANNEL: 'stable' },
		resolvedEnvironment: { DEV_FAST_REVIEW_APP_SESSION_ID: 'shell', DEV_FAST_REVIEW_CHANNEL: 'dev' },
		appVersion: '0.0.34',
		serverEntry: '/review/server.js',
		port: 4321,
		token: 'token',
		instanceId: 'instance',
		appPid: 1234,
		telemetryEnabled: true,
		appSessionId: 'session-1',
		channel: 'preview',
		crashDumpsDir: '/user-data/review-crashes',
	});

	assert.equal(environment.DEV_FAST_REVIEW_APP_SESSION_ID, 'session-1');
	assert.equal(environment.DEV_FAST_REVIEW_CHANNEL, 'preview');
	assert.equal(environment.DEV_FAST_REVIEW_CRASH_DUMPS_DIR, '/user-data/review-crashes');
});

class FakeServerProcess implements IReviewServerProcess {
	private readonly stdout = new Emitter<string>();
	private readonly exit = new Emitter<{ readonly code: number; readonly signal: string }>();
	readonly onStdout = this.stdout.event;
	readonly onStderr = new Emitter<string>().event;
	readonly onExit = this.exit.event;
	private readonly crashed = new Emitter<{ readonly code: number; readonly reason: string }>();
	readonly onCrash = this.crashed.event;
	env: Record<string, string | undefined> = {};

	start(configuration: { readonly env?: Record<string, string | undefined> }): boolean {
		this.env = configuration.env ?? {};
		return true;
	}
	announceReady(): void {
		this.stdout.fire(`${JSON.stringify({
			event: 'ready',
			version: REVIEW_DESKTOP_CONNECTION_VERSION,
			url: 'http://127.0.0.1:4321',
			token: this.env.DEV_FAST_REVIEW_SERVER_TOKEN,
			instanceId: this.env.DEV_FAST_REVIEW_INSTANCE_ID,
		})}\n`);
	}
	crash(): void {
		this.exit.fire({ code: 1, signal: 'SIGKILL' });
	}
	electronCrash(code: number, reason: string): void {
		this.crashed.fire({ code, reason });
	}
	exitWith(code: number, signal: string): void {
		this.exit.fire({ code, signal });
	}
	postMessage(): void { }
	kill(): void { }
	dispose(): void { }
}

test('a restarted server keeps the launch\'s app session id, which the connection carries', async (t) => {
	const processes: FakeServerProcess[] = [];
	let restarted!: () => void;
	const whenRestarted = new Promise<void>((resolve) => restarted = resolve);
	const supervisor = new ReviewServerSupervisor({
		appRoot: '/app',
		appVersion: '0.0.34',
		isBuilt: true,
		channel: 'preview',
		logInfo: () => { },
		logError: () => { },
		createProcess: () => {
			const serverProcess = new FakeServerProcess();
			processes.push(serverProcess);
			if (processes.length === 2) queueMicrotask(restarted);
			return serverProcess;
		},
	});
	t.after(() => supervisor.dispose());

	supervisor.start();
	const [first] = processes;
	first.announceReady();
	const connection = await supervisor.whenConnected();
	first.crash();
	await whenRestarted;
	const second = processes[1];

	assert.match(first.env.DEV_FAST_REVIEW_APP_SESSION_ID ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(connection.appSessionId, first.env.DEV_FAST_REVIEW_APP_SESSION_ID);
	assert.equal(second.env.DEV_FAST_REVIEW_APP_SESSION_ID, first.env.DEV_FAST_REVIEW_APP_SESSION_ID);
	assert.equal(second.env.DEV_FAST_REVIEW_CHANNEL, 'preview');
});

test('reports a server process death to onServerTerminated, but not a deliberate stop', async (t) => {
	const processes: FakeServerProcess[] = [];
	const terminated: ReviewServerTermination[] = [];
	const supervisor = (): ReviewServerSupervisor => {
		const created = new ReviewServerSupervisor({
			appRoot: '/app',
			appVersion: '0.0.34',
			isBuilt: true,
			channel: 'stable',
			logInfo: () => { },
			logError: () => { },
			createProcess: () => {
				const serverProcess = new FakeServerProcess();
				processes.push(serverProcess);
				return serverProcess;
			},
			onServerTerminated: (detail) => terminated.push(detail),
		});
		t.after(() => created.dispose());
		return created;
	};

	const crashing = supervisor();
	crashing.start();
	processes[0].electronCrash(139, 'crashed');
	processes[0].exitWith(139, 'unknown');
	assert.deepEqual(terminated, [{ code: 139, reason: 'crashed (139)' }]);
	await crashing.stop();

	const stopped = supervisor();
	stopped.start();
	const stopping = stopped.stop();
	processes[1].exitWith(1, 'SIGTERM');
	await stopping;
	assert.equal(terminated.length, 1);
});

test('the app path names the macOS bundle, else the executable', () => {
	assert.equal(applicationPath('/Applications/Review.app/Contents/MacOS/Review'), '/Applications/Review.app');
	assert.equal(applicationPath('/usr/share/review-desktop/review-desktop'), '/usr/share/review-desktop/review-desktop');
});
