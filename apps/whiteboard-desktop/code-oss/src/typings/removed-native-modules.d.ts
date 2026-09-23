/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Review Desktop removes these native npm dependencies from package.json:
// their features (Windows-only paths, enterprise policy, kerberos proxy auth,
// telemetry device ids, the agent-host sandbox) are never reached at runtime.
// The declarations below reproduce each removed package's public typings so
// the lazy `await import(...)` call sites still typecheck. If a feature is
// ever revived, reinstall the package and delete its block here.

declare module '@vscode/windows-mutex' {
	export class Mutex {
		constructor(name: string);
		isActive(): boolean;
		release(): void;
	}
	export function isActive(name: string): boolean;
}

declare module '@vscode/windows-process-tree' {
	export enum ProcessDataFlag {
		None = 0,
		Memory = 1,
		CommandLine = 2
	}

	export interface IProcessInfo {
		pid: number;
		ppid: number;
		name: string;
		memory?: number;
		commandLine?: string;
	}

	export interface IProcessCpuInfo extends IProcessInfo {
		cpu?: number;
	}

	export interface IProcessTreeNode {
		pid: number;
		name: string;
		memory?: number;
		commandLine?: string;
		children: IProcessTreeNode[];
	}

	export function getProcessTree(rootPid: number, callback: (tree: IProcessTreeNode | undefined) => void, flags?: ProcessDataFlag): void;
	export function getProcessList(rootPid: number, callback: (processList: IProcessInfo[] | undefined) => void, flags?: ProcessDataFlag): void;
	export function getProcessCpuUsage(processList: IProcessInfo[], callback: (processListWithCpu: IProcessCpuInfo[]) => void): void;
	export function getAllProcesses(callback: (processList: IProcessInfo[]) => void, flags?: ProcessDataFlag): void;
}

declare module '@vscode/windows-registry' {
	export type HKEY = 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE' | 'HKEY_CLASSES_ROOT' | 'HKEY_USERS' | 'HKEY_CURRENT_CONFIG';
	export function GetStringRegKey(hive: HKEY, path: string, name: string): string | undefined;
	export function GetDWORDRegKey(hive: HKEY, path: string, name: string): number | undefined;
}

declare module 'windows-foreground-love' {
	export function allowSetForegroundWindow(pid?: number): boolean;
}

declare module '@vscode/policy-watcher' {
	export interface Watcher {
		dispose(): void;
	}

	type StringPolicy = { type: 'string' };
	type NumberPolicy = { type: 'number' };
	type BooleanPolicy = { type: 'boolean' };

	export interface Policies {
		[policyName: string]: StringPolicy | NumberPolicy | BooleanPolicy;
	}

	export interface WatcherOptions {
		registryPath?: string;
	}

	export type PolicyUpdate<T extends Policies> = {
		[K in keyof T]:
		| undefined
		| (T[K] extends StringPolicy
			? string
			: (T[K] extends BooleanPolicy
				? boolean
				: T[K] extends NumberPolicy
				? number
				: never));
	};

	export function createWatcher<T extends Policies>(
		productName: string,
		policies: T,
		onDidChange: (update: PolicyUpdate<T>) => void,
		options?: WatcherOptions
	): Watcher;
}

declare module '@vscode/deviceid' {
	export function getDeviceId(): Promise<string>;
}

declare module '@vscode/fs-copyfile' {
	import type { CopyOptions } from 'node:fs';
	export function cp(src: string, dest: string, options?: CopyOptions): Promise<void>;
	export const copyFile: (src: string, dst: string, mode?: number) => Promise<void>;
	export const copyFileSync: (src: string, dst: string, mode?: number) => void;
	export const isCloneSupported: (path: string) => boolean;
	export const isMacOS: boolean;
}

declare module 'native-is-elevated' {
	function isElevated(): boolean;
	export = isElevated;
}

declare module 'kerberos' {
	export interface KerberosClient {
		step(challenge: string): Promise<string>;
	}
	export function initializeClient(service: string, options?: object): Promise<KerberosClient>;
	const kerberos: {
		initializeClient(service: string, options?: object): Promise<KerberosClient>;
	};
	export default kerberos;
}

declare module '@microsoft/mxc-sdk' {
	export function getAvailableToolsPolicy(...args: any[]): any;
	export function getUserProfilePolicy(...args: any[]): any;
	export function getTemporaryFilesPolicy(...args: any[]): any;
	export function buildSandboxPayload(...args: any[]): any;
}
