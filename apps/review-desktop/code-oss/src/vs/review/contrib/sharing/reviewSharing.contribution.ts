import { Disposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import {
	INotificationService,
	Severity,
} from "../../../platform/notification/common/notification.js";
import { IProgressService, ProgressLocation } from "../../../platform/progress/common/progress.js";
import { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { IURLService, type IURLHandler } from "../../../platform/url/common/url.js";
import {
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from "../../../workbench/common/contributions.js";
import { SessionApiClient } from "../../common/reviewProtocol.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import { IReviewDesktopConnectionService } from "../../services/reviewDesktopConnectionService.js";

async function openShare(
	url: string,
	session: IReviewDesktopConnectionService,
	tabs: IReviewCanvasEditorTabsService,
	notifications: INotificationService,
	progress: IProgressService,
) {
	try {
		const client = new SessionApiClient(await session.getConnection());
		await progress.withProgress({ location: ProgressLocation.Notification, title: "Opening shared review" }, async (reporter) => {
			const started = await client.post<{ sessionId: string }>("/sharing/import", { url });
			for (;;) {
				const status = await client.read<{ stage: string; title?: string; error?: string }>(`/sharing/import/${started.sessionId}`);
				if (status.stage === "error") throw new Error(status.error ?? "Could not open the shared review.");
				if (status.stage === "ready") {
					await tabs.openApiReview(started.sessionId, status.title ?? "Shared review");
					return;
				}
				const message = status.stage === "fetching"
					? "Fetching pinned GitHub commits…"
					: status.stage === "validating"
						? "Preparing pinned source…"
						: "Downloading review resources…";
				reporter.report({ message });
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		});
	} catch (error) {
		notifications.prompt(
			Severity.Error,
			error instanceof Error ? error.message : "Could not open the shared review.",
			[{ label: "Retry", run: () => openShare(url, session, tabs, notifications, progress) }],
		);
	}
}

class SharedReviewUrlHandler extends Disposable implements IURLHandler {
	constructor(
		@IURLService urls: IURLService,
		@IReviewDesktopConnectionService private readonly session: IReviewDesktopConnectionService,
		@IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
		@INotificationService private readonly notifications: INotificationService,
		@IProgressService private readonly progress: IProgressService,
	) {
		super();
		this._register(urls.registerHandler(this));
	}
	async handleURL(uri: URI): Promise<boolean> {
		if (uri.authority !== "share") return false;
		try {
			const origin = new URLSearchParams(uri.query).get("origin") ?? "https://app.dev.fast";
			const url = new URL(`/s${uri.path}`, origin);
			url.hash = uri.fragment;
			await openShare(url.href, this.session, this.tabs, this.notifications, this.progress);
		} catch {
			this.notifications.error("Invalid Review share link.");
		}
		return true;
	}
}
registerWorkbenchContribution2(
	"review.sharing.urls",
	SharedReviewUrlHandler,
	WorkbenchPhase.BlockRestore,
);
registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: "review.openSharedReview",
				title: localize2("review.openSharedReview", "Open Shared Review"),
				f1: true,
			});
		}
		async run(accessor: ServicesAccessor) {
			const session = accessor.get(IReviewDesktopConnectionService),
				tabs = accessor.get(IReviewCanvasEditorTabsService),
				notifications = accessor.get(INotificationService),
				progress = accessor.get(IProgressService);
			const url = await accessor
				.get(IQuickInputService)
				.input({
					prompt: "Paste a Review share link",
					placeHolder: "https://app.dev.fast/s/…",
					ignoreFocusLost: true,
				});
			if (url) await openShare(url, session, tabs, notifications, progress);
		}
	},
);
