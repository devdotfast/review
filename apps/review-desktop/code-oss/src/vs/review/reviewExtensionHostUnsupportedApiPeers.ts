/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../base/common/uri.js';
import { MainContext } from '../workbench/api/common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../workbench/services/extensions/common/extHostCustomers.js';

function unavailable(api: string): Promise<never> {
	return Promise.reject(new Error(`Review does not expose the ${api} API`));
}

@extHostNamedCustomer(MainContext.MainThreadAuthentication)
export class ReviewMainThreadAuthentication {
	constructor(_context: IExtHostContext) { }
	dispose(): void { }
	$registerAuthenticationProvider(): Promise<void> { return Promise.resolve(); }
	$unregisterAuthenticationProvider(): Promise<void> { return Promise.resolve(); }
	$ensureProvider(): Promise<void> { return Promise.resolve(); }
	$sendDidChangeSessions(): Promise<void> { return Promise.resolve(); }
	$getSession(): Promise<undefined> { return Promise.resolve(undefined); }
	$getAccounts(): Promise<never[]> { return Promise.resolve([]); }
	$removeSession(): Promise<void> { return Promise.resolve(); }
	$waitForUriHandler(expectedUri: UriComponents): Promise<UriComponents> { return Promise.resolve(expectedUri); }
	$showContinueNotification(): Promise<false> { return Promise.resolve(false); }
	$showDeviceCodeModal(): Promise<false> { return Promise.resolve(false); }
	$promptForClientRegistration(): Promise<undefined> { return Promise.resolve(undefined); }
	$promptForResourceClientSecret(): Promise<undefined> { return Promise.resolve(undefined); }
	$registerDynamicAuthenticationProvider(): Promise<void> { return Promise.resolve(); }
	$setSessionsForDynamicAuthProvider(): Promise<void> { return Promise.resolve(); }
	$sendDidChangeDynamicProviderInfo(): Promise<void> { return Promise.resolve(); }
}

@extHostNamedCustomer(MainContext.MainThreadTerminalService)
export class ReviewMainThreadTerminalService {
	constructor(_context: IExtHostContext) { }
	dispose(): void { }
	$createTerminal(): Promise<never> { return unavailable('terminal'); }
	$dispose(): void { }
	$hide(): void { }
	$sendText(): void { }
	$show(): void { }
	$registerProcessSupport(): void { }
	$registerProfileProvider(): void { }
	$unregisterProfileProvider(): void { }
	$registerCompletionProvider(): void { }
	$unregisterCompletionProvider(): void { }
	$registerQuickFixProvider(): void { }
	$unregisterQuickFixProvider(): void { }
	$setEnvironmentVariableCollection(): void { }
	$startSendingDataEvents(): void { }
	$stopSendingDataEvents(): void { }
	$startSendingCommandEvents(): void { }
	$stopSendingCommandEvents(): void { }
	$startLinkProvider(): void { }
	$stopLinkProvider(): void { }
	$sendProcessData(): void { }
	$sendProcessReady(): void { }
	$sendProcessProperty(): void { }
	$sendProcessExit(): void { }
}

@extHostNamedCustomer(MainContext.MainThreadTask)
export class ReviewMainThreadTask {
	constructor(_context: IExtHostContext) { }
	dispose(): void { }
	$createTaskId(): Promise<never> { return unavailable('task'); }
	$registerTaskProvider(): Promise<void> { return Promise.resolve(); }
	$unregisterTaskProvider(): Promise<void> { return Promise.resolve(); }
	$fetchTasks(): Promise<never[]> { return Promise.resolve([]); }
	$getTaskExecution(): Promise<never> { return unavailable('task'); }
	$executeTask(): Promise<never> { return unavailable('task'); }
	$terminateTask(): Promise<void> { return Promise.resolve(); }
	$registerTaskSystem(): void { }
	$customExecutionComplete(): Promise<void> { return Promise.resolve(); }
	$registerSupportedExecutions(): Promise<void> { return Promise.resolve(); }
}

@extHostNamedCustomer(MainContext.MainThreadLanguageModelTools)
export class ReviewMainThreadLanguageModelTools {
	constructor(_context: IExtHostContext) { }
	dispose(): void { }
	$getTools(): Promise<never[]> { return Promise.resolve([]); }
	$acceptToolProgress(): void { }
	$invokeTool(): Promise<never> { return unavailable('language model tools'); }
	$countTokensForInvocation(): Promise<never> { return unavailable('language model tools'); }
	$registerTool(): void { }
	$registerToolWithDefinition(): void { }
	$unregisterTool(): void { }
}

@extHostNamedCustomer(MainContext.MainThreadUrls)
export class ReviewMainThreadUrls {
	constructor(_context: IExtHostContext) { }
	dispose(): void { }
	$registerUriHandler(): Promise<void> { return Promise.resolve(); }
	$unregisterUriHandler(): Promise<void> { return Promise.resolve(); }
	$createAppUri(uri: UriComponents): Promise<UriComponents> { return Promise.resolve(uri); }
}
