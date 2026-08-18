/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { localize } from "../../nls.js";
import { IDialogMainService } from "../../platform/dialogs/electron-main/dialogMainService.js";
import { ILogService } from "../../platform/log/common/log.js";
import {
  IUpdateService,
  StateType,
} from "../../platform/update/common/update.js";

/**
 * Reports the outcome of an explicit "Check for Updates..." with a native
 * dialog.
 *
 * Stock Code OSS reports this from the workbench (`UpdateContribution`) and
 * keeps `NotAvailableUpdateDialog` only for the windowless case. Review's
 * renderer registers a no-op `IUpdateService`, so a native dialog is the whole
 * feedback path here — with a window open or not.
 *
 * Only explicit checks report. Background checks stay silent, matching stock.
 */
export class ReviewUpdateDialog extends Disposable {
  private awaitingExplicitResult = false;

  constructor(
    @IUpdateService updateService: IUpdateService,
    @IDialogMainService private readonly dialogMainService: IDialogMainService,
    @ILogService private readonly logService: ILogService,
  ) {
    super();

    this._register(
      updateService.onStateChange((state) => {
        if (state.type === StateType.CheckingForUpdates) {
          this.awaitingExplicitResult = state.explicit;
          return;
        }

        if (!this.awaitingExplicitResult) {
          return;
        }
        this.awaitingExplicitResult = false;

        // Only a check that found nothing, or failed, needs a dialog. A found
        // update tells its own story: macOS downloads it and the menu item
        // becomes "Restart to Update".
        if (state.type !== StateType.Idle) {
          return;
        }

        if (state.error) {
          this.show(
            "error",
            localize(
              "review.update.failed",
              "Could not check for updates. Please try again later.",
            ),
            state.error,
          );
          return;
        }

        if (state.notAvailable) {
          this.show(
            "info",
            localize(
              "review.update.noUpdatesAvailable",
              "There are currently no updates available.",
            ),
          );
        }
      }),
    );
  }

  private show(type: "info" | "error", message: string, detail?: string): void {
    this.logService.info(`reviewUpdateDialog#show - ${type}: ${message}`);
    this.dialogMainService
      .showMessageBox({ type, message, detail })
      .catch((error) => {
        this.logService.error("reviewUpdateDialog#show failed", error);
      });
  }
}
