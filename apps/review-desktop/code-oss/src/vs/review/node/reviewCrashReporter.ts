/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, crashReporter } from 'electron';
import * as path from 'node:path';

export const REVIEW_CRASH_DUMPS_DIRNAME = 'review-crashes';

/**
 * Write minidumps locally and never upload from Electron itself. The Review
 * main process reads the dumps on the next launch and sends them through the
 * embedded server, where the telemetry opt-out is enforced.
 */
export function startReviewCrashReporter(userDataPath: string, productName: string): string {
	const dumpsDir = path.join(userDataPath, REVIEW_CRASH_DUMPS_DIRNAME);
	app.setPath('crashDumps', dumpsDir);
	crashReporter.start({
		companyName: 'dev.fast',
		productName,
		submitURL: '',
		uploadToServer: false,
		compress: false,
	});
	return dumpsDir;
}
