/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { sign, type SignOptions } from '@electron/osx-sign';
import { spawn } from '@malept/cross-spawn-promise';

const root = path.dirname(path.dirname(import.meta.dirname));
const entitlementsDir = path.join(import.meta.dirname, 'entitlements');
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));

function getElectronVersion(): string {
	const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
	const target = /^target="(.*)"$/m.exec(npmrc)![1];
	return target;
}

function getEntitlementsForFile(filePath: string): string {
	if (filePath.includes(' Helper (GPU).app')) {
		return path.join(entitlementsDir, 'helper-gpu.plist');
	} else if (filePath.includes(' Helper (Renderer).app')) {
		return path.join(entitlementsDir, 'helper-renderer.plist');
	} else if (filePath.includes(' Helper (Plugin).app')) {
		return path.join(entitlementsDir, 'helper-plugin.plist');
	} else if (filePath.includes(' Helper.app')) {
		return path.join(entitlementsDir, 'helper.plist');
	}
	return path.join(entitlementsDir, 'app.plist');
}

function getKeychain(): string | undefined {
	const configuredKeychain = process.env['CODESIGN_KEYCHAIN'];
	if (configuredKeychain) {
		return configuredKeychain;
	}

	const tempDir = process.env['AGENT_TEMPDIRECTORY'];
	return tempDir ? path.join(tempDir, 'buildagent.keychain') : undefined;
}

export function isTutorialGitObjectPath(appPath: string, filePath: string): boolean {
	const objectsPath = path.resolve(
		appPath,
		'Contents',
		'Resources',
		'app',
		'review-runtime',
		'tutorial',
		'git-stub',
		'objects'
	);
	const relativePath = path.relative(objectsPath, path.resolve(filePath));
	return (
		relativePath.length > 0 &&
		relativePath !== '..' &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
}

async function retrySignOnKeychainError<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			// Check if this is the specific keychain error we want to retry
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isKeychainError = errorMessage.includes('The specified item could not be found in the keychain.');

			if (!isKeychainError || attempt === maxRetries) {
				throw error;
			}

			console.log(`Signing attempt ${attempt} failed with keychain error, retrying...`);
			console.log(`Error: ${errorMessage}`);

			const delay = 1000 * Math.pow(2, attempt - 1);
			console.log(`Waiting ${Math.round(delay)}ms before retry ${attempt}/${maxRetries}...`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}

async function main(buildDir?: string): Promise<void> {
	const arch = process.env['VSCODE_ARCH'];
	const identity = process.env['CODESIGN_IDENTITY'];
	const keychain = getKeychain();

	if (!buildDir) {
		throw new Error('build directory argument is required');
	}

	if (!arch) {
		throw new Error('$VSCODE_ARCH not set');
	}

	if (!identity) {
		throw new Error('$CODESIGN_IDENTITY not set');
	}

	const appRoot = path.join(buildDir, `VSCode-darwin-${arch}`);
	const appName = product.nameShort + '.app';
	const appPath = path.join(appRoot, appName);
	const infoPlistPath = path.resolve(appPath, 'Contents', 'Info.plist');

	const appOpts: SignOptions = {
		app: appPath,
		// Loose Git objects are compressed resources. osx-sign identifies them as
		// binaries and asks codesign to modify their read-only files. The app bundle
		// signature still seals these resources when it signs the containing app.
		ignore: filePath => isTutorialGitObjectPath(appPath, filePath),
		platform: 'darwin',
		optionsForFile: (filePath) => ({
			entitlements: getEntitlementsForFile(filePath),
			hardenedRuntime: true,
		}),
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		...(keychain ? { keychain } : {}),
		version: getElectronVersion(),
		identity,
	};

	// Only overwrite plist entries for x64 and arm64 builds,
	// universal will get its copy from the x64 build.
	if (arch !== 'universal') {
		await spawn('plutil', [
			'-insert',
			'NSAppleEventsUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use AppleScript.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSMicrophoneUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use the Microphone.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSCameraUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use the Camera.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSAudioCaptureUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use Audio Capture.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-insert',
			'NSLocalNetworkUsageDescription',
			'-string',
			'The app uses your local network for DNS resolution and to connect to locally running services.',
			`${infoPlistPath}`
		]);
	}

	await retrySignOnKeychainError(() => sign(appOpts));
}

if (import.meta.main) {
	main(process.argv[2]).catch(async err => {
		console.error(err);
		const keychain = getKeychain();
		if (keychain) {
			try {
				const identities = await spawn('security', ['find-identity', '-p', 'codesigning', '-v', keychain]);
				console.error(`Available identities:\n${identities}`);
			} catch (diagnosticError) {
				console.error(`Could not list signing identities in ${keychain}:`, diagnosticError);
			}
		}
		process.exit(1);
	});
}
