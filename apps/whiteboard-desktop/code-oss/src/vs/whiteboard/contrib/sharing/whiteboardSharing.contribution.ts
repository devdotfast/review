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
import { SessionApiClient } from "../../common/whiteboardProtocol.js";
import { IWhiteboardCanvasEditorTabsService } from "../../services/whiteboardCanvasEditorTabsService.js";
import { IWhiteboardDesktopConnectionService } from "../../services/whiteboardDesktopConnectionService.js";

async function openShare(
	url: string,
	session: IWhiteboardDesktopConnectionService,
	tabs: IWhiteboardCanvasEditorTabsService,
	notifications: INotificationService,
	progress: IProgressService,
) {
	try {
		const client = new SessionApiClient({ ...await session.getConnection(), apiPath: "/sessions-api" });
		await progress.withProgress({ location: ProgressLocation.Notification, title: "Opening shared review" }, async (reporter) => {
			const started = await client.post<{ sessionId: string }>("/sharing/import", { url });
			for (;;) {
				const status = await client.read<{ stage: string; title?: string; error?: string }>(`/sharing/import/${started.sessionId}`);
				if (status.stage === "error") throw new Error(status.error ?? "Could not open the shared session.");
				if (status.stage === "ready") {
					await tabs.openApiWhiteboard(started.sessionId, status.title ?? "Shared review");
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
			error instanceof Error ? error.message : "Could not open the shared session.",
			[{ label: "Retry", run: () => openShare(url, session, tabs, notifications, progress) }],
		);
	}
}

class SharedWhiteboardUrlHandler extends Disposable implements IURLHandler {
	constructor(
		@IURLService urls: IURLService,
		@IWhiteboardDesktopConnectionService private readonly session: IWhiteboardDesktopConnectionService,
		@IWhiteboardCanvasEditorTabsService private readonly tabs: IWhiteboardCanvasEditorTabsService,
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
			this.notifications.error("Invalid Whiteboard share link.");
		}
		return true;
	}
}
registerWorkbenchContribution2(
	"review.sharing.urls",
	SharedWhiteboardUrlHandler,
	WorkbenchPhase.BlockRestore,
);
registerAction2(
	class extends Action2 {
		constructor() {
			super({
				id: "whiteboard.openSharedSession",
				title: localize2("whiteboard.openSharedSession", "Open Shared Session"),
				f1: true,
			});
		}
		async run(accessor: ServicesAccessor) {
			const session = accessor.get(IWhiteboardDesktopConnectionService),
				tabs = accessor.get(IWhiteboardCanvasEditorTabsService),
				notifications = accessor.get(INotificationService),
				progress = accessor.get(IProgressService);
			const url = await accessor
				.get(IQuickInputService)
				.input({
					prompt: "Paste a Whiteboard share link",
					placeHolder: "https://app.dev.fast/s/…",
					ignoreFocusLost: true,
				});
			if (url) await openShare(url, session, tabs, notifications, progress);
		}
	},
);
