/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCancellationError } from "../../../base/common/errors.js";
import { isLinux, isMacintosh } from "../../../base/common/platform.js";
import { localize, localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import { IDialogService } from "../../../platform/dialogs/common/dialogs.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { INativeHostService } from "../../../platform/native/common/native.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import { Registry } from "../../../platform/registry/common/platform.js";
import { IStorageService, StorageScope } from "../../../platform/storage/common/storage.js";
import {
	Extensions as WorkbenchExtensions,
	type IWorkbenchContribution,
	type IWorkbenchContributionsRegistry,
} from "../../../workbench/common/contributions.js";
import { INativeWorkbenchEnvironmentService } from "../../../workbench/services/environment/electron-browser/environmentService.js";
import { LifecyclePhase } from "../../../workbench/services/lifecycle/common/lifecycle.js";
import { reviewCliInstallResyncRequest } from "../../common/reviewCliInstall.js";
import {
	type ReviewCliInstallStatus,
	type ReviewCliInstallTarget,
	REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY,
} from "../../common/reviewProtocol.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import { IReviewDesktopConnectionService } from "../../services/reviewDesktopConnectionService.js";

const TARGET_LABELS: Readonly<Record<ReviewCliInstallTarget, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	cursor: "Cursor",
	opencode: "OpenCode",
	pi: "Pi",
};

function formatTargets(targets: readonly ReviewCliInstallTarget[]): string {
	return targets.map((target) => TARGET_LABELS[target]).join(", ");
}

/**
 * The macOS app bundle that contains this build, derived from the resources
 * path inside it. Development runs live outside a bundle and return undefined.
 */
function macAppBundlePath(appRoot: string): string | undefined {
	const marker = appRoot.indexOf(".app/");
	return marker === -1 ? undefined : appRoot.slice(0, marker + ".app".length);
}

class OpenWelcomeAction extends Action2 {
	constructor() {
		super({
			id: "review.openWelcome",
			title: localize2("review.welcome", "Review: Welcome..."),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IReviewCanvasEditorTabsService).openWelcome(true);
	}
}

registerAction2(OpenWelcomeAction);

class OpenTutorialAction extends Action2 {
	constructor() {
		super({
			id: "review.openTutorial",
			title: localize2("review.openTutorial", "Review: Open Tutorial..."),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const desktopConnection = accessor.get(IReviewDesktopConnectionService);
		const tabsService = accessor.get(IReviewCanvasEditorTabsService);
		try {
			const opened = await desktopConnection.openTutorial();
			await tabsService.openApiReview(opened.reviewUuid, opened.title);
		} catch (error) {
			notificationService.error(
				localize("review.tutorial.failed", "Review could not open the tutorial: {0}", String(error)),
			);
		}
	}
}

registerAction2(OpenTutorialAction);

class InstallReviewCliInPathAction extends Action2 {
	constructor() {
		super({
			id: "review.installCliInPath",
			title: localize2("review.installCliInPath", "Review: Install CLI in PATH"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);
		const desktopConnection = accessor.get(IReviewDesktopConnectionService);
		try {
			if (isMacintosh) {
				await nativeHostService.uninstallShellCommand({ commandName: "review", symlinkOnly: true });
			}
			const installed = await desktopConnection.applyCliInstall({ targets: [], shim: true });
			notificationService.info(
				localize(
					"review.cliInstall.installed",
					"Review installed the CLI at {0}. New terminals can use the review command.",
					installed.shimPath ?? "~/.local/bin/review",
				),
			);
		} catch (error) {
			if (isCancellationError(error)) {
				return;
			}
			notificationService.error(
				localize("review.cliInstall.failed", "Review could not install the CLI in PATH: {0}", String(error)),
			);
		}
	}
}

registerAction2(InstallReviewCliInPathAction);

/**
 * Removes everything the app installed on this machine: the tutorial, the
 * agent connections, the review terminal command, and the consent stamp. It then
 * points at the app bundle so the user can move it to the Trash. Other Review
 * data stays untouched. Resetting the stamp makes a later reinstall start as
 * a first run.
 */
class UninstallReviewDesktopAction extends Action2 {
	constructor() {
		super({
			id: "review.uninstallApp",
			title: localize2("review.uninstallApp", "Review: Uninstall Review Desktop..."),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const environmentService = accessor.get(INativeWorkbenchEnvironmentService);
		const nativeHostService = accessor.get(INativeHostService);
		const desktopConnection = accessor.get(IReviewDesktopConnectionService);
		const storageService = accessor.get(IStorageService);

		const status = await desktopConnection.getCliInstallStatus();
		const targets = status.agents.filter((agent) => agent.installed).map((agent) => agent.target);
		const fffTargets = status.stamp?.fffRegistrations?.map((registration) => registration.target) ?? [];
		const removalTargets = [...new Set([...targets, ...fffTargets])];
		const detail = [
			targets.length > 0
				? localize(
						"review.uninstall.skills",
						"Removes Review's agent setup for {0}.",
						formatTargets(targets),
					)
				: localize("review.uninstall.noSkills", "No agents are connected to Review."),
			status.stamp?.shimPath
				? localize("review.uninstall.shim", "Removes the review terminal command at {0}.", status.stamp.shimPath)
				: localize("review.uninstall.noShim", "The review terminal command is not installed."),
			fffTargets.length > 0
				? localize(
						"review.uninstall.fff",
						"Removes unchanged fff registrations that Review created. The shared FFF binary stays installed.",
					)
				: localize("review.uninstall.noFff", "No fff registrations are managed by Review."),
			status.stamp?.traceManaged
				? localize(
						"review.uninstall.trace",
						"Disables trace capture and restores hook paths for known repositories. R2 credentials stay on disk.",
					)
				: localize("review.uninstall.noTrace", "Trace capture is not managed by Review."),
			localize("review.uninstall.tutorial", "Removes the bundled tutorial repository and Review."),
			localize("review.uninstall.keepsData", "Your reviews and their history stay on disk."),
		].join("\n");
		const { confirmed } = await dialogService.confirm({
			message: localize("review.uninstall.confirm", "Remove everything Review Desktop installed on this machine?"),
			detail,
			primaryButton: localize("review.uninstall.remove", "&&Remove"),
		});
		if (!confirmed) {
			return;
		}

		// The tutorial is disposable state: a failed delete must not stop
		// the shim and agent removal the user just confirmed.
		let tutorialError: unknown;
		try {
			await desktopConnection.deleteTutorial();
			storageService.remove(REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY, StorageScope.APPLICATION);
		} catch (error) {
			tutorialError = error;
		}
		try {
			await desktopConnection.removeCliInstall({
				targets: removalTargets,
				shim: true,
				fff: true,
				...(status.stamp?.traceManaged ? { trace: true } : {}),
			});
			await desktopConnection.resetCliInstallPrompts();
			if (tutorialError) {
				await dialogService.error(
					localize("review.uninstall.tutorialFailed", "Review could not remove the tutorial data at ~/.dev/tutorial."),
					String(tutorialError),
				);
			}
		} catch (error) {
			await dialogService.error(
				localize("review.uninstall.failed", "Review could not remove its agent setup and command."),
				String(error),
			);
			return;
		}

		if (isLinux) {
			await dialogService.info(
				localize("review.uninstall.linuxDone", "Review’s user-installed integrations were removed."),
				localize(
					"review.uninstall.linuxFinish",
					"To remove the app, quit Review and run sudo apt remove dev-fast-review on Ubuntu, or sudo pacman -R dev-fast-review on Omarchy / Arch. Your reviews and settings stay on disk.",
				),
			);
			return;
		}

		const bundlePath = macAppBundlePath(environmentService.appRoot);
		if (bundlePath) {
			const { confirmed: reveal } = await dialogService.confirm({
				message: localize("review.uninstall.done", "Review's agent setup and command were removed."),
				detail: localize(
					"review.uninstall.finish",
					"To finish, quit Review Desktop and move {0} to the Trash.",
					bundlePath,
				),
				primaryButton: localize("review.uninstall.reveal", "&&Show in Finder"),
				cancelButton: localize("review.uninstall.close", "Close"),
			});
			if (reveal) {
				await nativeHostService.showItemInFolder(bundlePath);
			}
		} else {
			await dialogService.info(
				localize("review.uninstall.done", "Review's agent setup and command were removed."),
				localize("review.uninstall.finishDev", "This is a development build, so there is no app bundle to remove."),
			);
		}
	}
}

registerAction2(UninstallReviewDesktopAction);

/**
 * First-run onboarding and silent re-sync. Consent lives in the server's
 * install stamp (~/.dev/review-desktop/state/cli-install.json), not workbench
 * storage, so the CLI and the app read one source of truth:
 * - no stamp: open no tab; empty Home renders the Welcome rail, and
 *   Preferences > Getting Started reaches the same pane when Home has
 *   reviews to list instead;
 * - granted + stale CLI fingerprint or agent setup: re-sync silently after an app update;
 * - declined or skipped: never open automatically (the menu action stays available).
 *
 * Dev sessions (`pnpm dev`, isBuilt false) never auto-open.
 */
class ReviewCliInstallStartup implements IWorkbenchContribution {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IReviewDesktopConnectionService private readonly reviewDesktopConnectionService: IReviewDesktopConnectionService,
	) {
		if (!environmentService.isBuilt) {
			return;
		}
		void this.check().catch((error) => {
			this.notificationService.warn(
				localize(
					"review.cliInstall.updateFailed",
					"Review could not update its agent setup or CLI: {0}. Retry from Getting Started, or restart Review.",
					String(error),
				),
			);
		});
	}

	private async check(): Promise<void> {
		const status = await this.reviewDesktopConnectionService.getCliInstallStatus();
		if (status.stamp?.consent === "declined") {
			return;
		}
		if (status.stamp?.consent === "skipped") {
			return;
		}
		if (status.stamp?.consent === "granted") {
			if (status.stale) {
				await this.resync(status);
			}
			return;
		}
		// First run needs no tab: with no reviews to list, Home already renders
		// the Welcome rail, so opening one here would show it twice.
	}

	private async resync(status: ReviewCliInstallStatus): Promise<void> {
		const request = reviewCliInstallResyncRequest(status);
		if (!request) {
			return;
		}
		await this.reviewDesktopConnectionService.applyCliInstall(request);
		const message =
			request.targets.length === 0
				? localize("review.cliInstall.resyncedCli", "Review updated the installed CLI.")
				: request.shim
					? localize(
							"review.cliInstall.resynced",
							"Review updated the CLI and agent MCP connections. Restart your agent or reconnect MCP to load the changes.",
						)
					: localize(
							"review.cliInstall.resyncedSkills",
							"Review updated the agent MCP connections. Restart your agent or reconnect MCP to load the changes.",
						);
		this.notificationService.status(message, { hideAfter: 10_000 });
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	ReviewCliInstallStartup,
	LifecyclePhase.Restored,
);
