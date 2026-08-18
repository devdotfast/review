/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotTokenInfo, IDefaultAccount, IDefaultAccountAuthenticationProvider, IPolicyData } from '../../base/common/defaultAccount.js';
import { Event } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IDefaultAccountProvider, IDefaultAccountService, ManagedSettingsFetchStatus } from '../../platform/defaultAccount/common/defaultAccount.js';

/**
 * Review has no account or Copilot surface. Keeping account startup inert also
 * prevents the curated extension host from waiting for an authentication
 * provider that Review intentionally does not expose.
 */
export class ReviewDefaultAccountService extends Disposable implements IDefaultAccountService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeDefaultAccount = Event.None;
	readonly onDidChangePolicyData = Event.None;
	readonly onDidChangeCopilotTokenInfo = Event.None;
	readonly policyData: IPolicyData | null = null;
	readonly currentDefaultAccount: IDefaultAccount | null = null;
	readonly copilotTokenInfo: ICopilotTokenInfo | null = null;
	readonly managedSettingsFetchStatus: ManagedSettingsFetchStatus = null;
	readonly managedSettingsFetchedAt: number | null = null;
	readonly managedSettingsRawResponse: unknown = null;

	getDefaultAccount(): Promise<null> { return Promise.resolve(null); }
	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider {
		return { id: 'github', name: 'GitHub', enterprise: false };
	}
	setDefaultAccountProvider(_provider: IDefaultAccountProvider): void { }
	refresh(): Promise<null> { return Promise.resolve(null); }
	signIn(): Promise<null> { return Promise.resolve(null); }
	signOut(): Promise<void> { return Promise.resolve(); }
	resolveGitHubUrl(path: string): string { return `https://github.com/${path}`; }
}
