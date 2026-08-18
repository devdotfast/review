/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import type { URI } from '../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import type { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { type IBannerItem, IBannerService } from '../../workbench/services/banner/browser/bannerService.js';
import type { IAuxiliaryStatusbarPart, IStatusbarEntryContainer } from '../../workbench/browser/parts/statusbar/statusbarPart.js';
import { IExtensionsWorkbenchService } from '../../workbench/contrib/extensions/common/extensions.js';
import {
	IMultiDiffSourceResolverService,
	MultiDiffSourceResolverService,
} from '../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import {
	IQuickDiffModelService,
	type QuickDiffModelOptions,
} from '../../workbench/contrib/scm/browser/quickDiffModel.js';
import {
	type IStatusbarEntry,
	type IStatusbarEntryAccessor,
	type IStatusbarEntryLocation,
	type IStatusbarEntryPriority,
	IStatusbarService,
	type IStatusbarStyleOverride,
	type StatusbarAlignment,
} from '../../workbench/services/statusbar/browser/statusbar.js';

/** Accepts status messages from editor services without creating stock chrome. */
class ReviewStatusbarService implements IStatusbarService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEntryVisibility = Event.None as Event<{ id: string; visible: boolean }>;

	getPart(_container: HTMLElement): IStatusbarEntryContainer { return this; }
	createAuxiliaryStatusbarPart(_container: HTMLElement, _instantiationService: IInstantiationService): IAuxiliaryStatusbarPart {
		throw new Error('Review does not provide status bar parts');
	}
	createScoped(_statusbarEntryContainer: IStatusbarEntryContainer, _disposables: DisposableStore): IStatusbarService { return this; }
	addEntry(
		_entry: IStatusbarEntry,
		_id: string,
		_alignment: StatusbarAlignment,
		_priority?: number | IStatusbarEntryPriority | IStatusbarEntryLocation,
	): IStatusbarEntryAccessor {
		return { update() { }, dispose() { } };
	}
	isEntryVisible(_id: string): boolean { return false; }
	updateEntryVisibility(_id: string, _visible: boolean): void { }
	overrideEntry(_id: string, _override: Partial<IStatusbarEntry>) { return toDisposable(() => { }); }
	focus(_preserveEntryFocus?: boolean): void { }
	focusNextEntry(): void { }
	focusPreviousEntry(): void { }
	isEntryFocused(): boolean { return false; }
	overrideStyle(_style: IStatusbarStyleOverride) { return toDisposable(() => { }); }
	dispose(): void { }
}

class ReviewBannerService implements IBannerService {
	declare readonly _serviceBrand: undefined;
	focus(): void { }
	focusNextAction(): void { }
	focusPreviousAction(): void { }
	hide(_id: string): void { }
	show(_item: IBannerItem): void { }
}

/**
 * MainThreadTextEditors asks for quick-diff metadata while synchronizing every
 * editor. Review has no SCM provider surface, so there are no quick diffs to
 * expose and constructing the stock model would incorrectly require SCM.
 */
class ReviewQuickDiffModelService implements IQuickDiffModelService {
	declare readonly _serviceBrand: undefined;

	createQuickDiffModelReference(_resource: URI, _options?: QuickDiffModelOptions): undefined {
		return undefined;
	}
}

/**
 * MainThreadExtensionService needs the extension-workbench token in order to
 * complete the extension-host handshake. Review deliberately has no extension
 * marketplace UI, so expose only the inert management surface while the stock
 * extension scanner and language-provider APIs remain fully available.
 */
class ReviewExtensionsWorkbenchService implements IExtensionsWorkbenchService {
	declare readonly _serviceBrand: undefined;
	readonly onChange = Event.None as IExtensionsWorkbenchService['onChange'];
	readonly onReset = Event.None as IExtensionsWorkbenchService['onReset'];
	readonly local: IExtensionsWorkbenchService['local'] = [];
	readonly installed: IExtensionsWorkbenchService['installed'] = [];
	readonly outdated: IExtensionsWorkbenchService['outdated'] = [];
	readonly whenInitialized = Promise.resolve();
	readonly onDidChangeExtensionsNotification = Event.None as IExtensionsWorkbenchService['onDidChangeExtensionsNotification'];

	queryLocal(): Promise<never[]> { return Promise.resolve([]); }
	queryGallery(..._args: unknown[]): Promise<never> { return this.unavailable(); }
	getExtensions(..._args: unknown[]): Promise<never[]> { return Promise.resolve([]); }
	getResourceExtensions(): Promise<never[]> { return Promise.resolve([]); }
	canInstall(): Promise<true> { return Promise.resolve(true); }
	install(..._args: unknown[]): Promise<never> { return this.unavailable(); }
	installInServer(): Promise<never> { return this.unavailable(); }
	downloadVSIX(): Promise<never> { return this.unavailable(); }
	uninstall(): Promise<never> { return this.unavailable(); }
	togglePreRelease(): Promise<never> { return this.unavailable(); }
	canSetLanguage(): boolean { return false; }
	setLanguage(): Promise<never> { return this.unavailable(); }
	setEnablement(): Promise<void> { return Promise.resolve(); }
	isAutoUpdateEnabledFor(): boolean { return false; }
	updateAutoUpdateEnablementFor(): Promise<void> { return Promise.resolve(); }
	shouldRequireConsentToUpdate(): Promise<undefined> { return Promise.resolve(undefined); }
	updateAutoUpdateForAllExtensions(): Promise<void> { return Promise.resolve(); }
	open(): Promise<never> { return this.unavailable(); }
	openSearch(): Promise<never> { return this.unavailable(); }
	getAutoUpdateValue(): 'off' { return 'off'; }
	isAutoUpdateDelayed(): boolean { return false; }
	getAutoUpdateDelayRemaining(): number { return 0; }
	getAutoUpdateDelay(): number { return 0; }
	checkForUpdates(): Promise<void> { return Promise.resolve(); }
	getExtensionRuntimeStatus(): undefined { return undefined; }
	updateAll(): Promise<never[]> { return Promise.resolve([]); }
	updateRunningExtensions(): Promise<void> { return Promise.resolve(); }
	getExtensionsNotification(): undefined { return undefined; }
	isExtensionIgnoredToSync(): boolean { return false; }
	toggleExtensionIgnoredToSync(): Promise<void> { return Promise.resolve(); }
	toggleApplyExtensionToAllProfiles(): Promise<void> { return Promise.resolve(); }

	private unavailable(): Promise<never> {
		return Promise.reject(new Error('Review does not expose extension management'));
	}
}

registerSingleton(IStatusbarService, ReviewStatusbarService, InstantiationType.Eager);
registerSingleton(IBannerService, ReviewBannerService, InstantiationType.Eager);
registerSingleton(IExtensionsWorkbenchService, ReviewExtensionsWorkbenchService, InstantiationType.Eager);
registerSingleton(IQuickDiffModelService, ReviewQuickDiffModelService, InstantiationType.Eager);
// The in-tab diff builds a MultiDiffEditorInput, which resolves its sources
// through this service. Review never imports the upstream multi-diff editor
// contribution, so this is its only registration.
registerSingleton(IMultiDiffSourceResolverService, MultiDiffSourceResolverService, InstantiationType.Delayed);
