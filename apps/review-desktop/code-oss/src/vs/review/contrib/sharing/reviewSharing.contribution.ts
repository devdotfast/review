import { Disposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { localize2 } from "../../../nls.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import {
  INotificationService,
  Severity,
} from "../../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { IURLService, type IURLHandler } from "../../../platform/url/common/url.js";
import {
  registerWorkbenchContribution2,
  WorkbenchPhase,
} from "../../../workbench/common/contributions.js";
import { ReviewApiClient } from "../../common/reviewProtocol.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import { IReviewSessionService } from "../../services/reviewSessionService.js";

async function openShare(
  url: string,
  session: IReviewSessionService,
  tabs: IReviewCanvasEditorTabsService,
  notifications: INotificationService,
) {
  try {
    const client = new ReviewApiClient(await session.getConnection());
    const result = await client.post<{ reviewId: string; title: string }>("/sharing/import", {
      url,
    });
    await tabs.openApiReview(result.reviewId, result.title);
    const snapshot = await client.read<{ shared?: { cloneUrl?: string } }>(
      `/${result.reviewId}?full=true`,
    );
    if (snapshot.shared?.cloneUrl)
      notifications.prompt(Severity.Info, "Clone the repository for advanced features.", [
        {
          label: "Clone repository",
          run: async () => {
            try {
              await client.post("/sharing/clone", { reviewId: result.reviewId });
              notifications.info("Repository attached. Reopen code to use advanced features.");
            } catch {
              notifications.error("Could not clone the repository. Check your repository access.");
            }
          },
        },
      ]);
  } catch {
    notifications.error(
      "This shared review could not be opened. Check the link and your connection.",
    );
  }
}
class SharedReviewUrlHandler extends Disposable implements IURLHandler {
  constructor(
    @IURLService urls: IURLService,
    @IReviewSessionService private readonly session: IReviewSessionService,
    @IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
    @INotificationService private readonly notifications: INotificationService,
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
      await openShare(url.href, this.session, this.tabs, this.notifications);
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
      const session = accessor.get(IReviewSessionService),
        tabs = accessor.get(IReviewCanvasEditorTabsService),
        notifications = accessor.get(INotificationService);
      const url = await accessor
        .get(IQuickInputService)
        .input({
          prompt: "Paste a Review share link",
          placeHolder: "https://app.dev.fast/s/…",
          ignoreFocusLost: true,
        });
      if (url) await openShare(url, session, tabs, notifications);
    }
  },
);
