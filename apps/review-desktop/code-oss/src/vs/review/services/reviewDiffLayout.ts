/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import {
  ConfigurationTarget,
  IConfigurationService,
} from "../../platform/configuration/common/configuration.js";
import type { ReviewDiffLayout } from "../common/reviewProtocol.js";

const RENDER_SIDE_BY_SIDE_KEY = "diffEditor.renderSideBySide";

/**
 * The unified/split choice, kept as the stock diff-editor setting rather than
 * widget-local state: every embedded diff (the multi-diff view and the inline
 * editors) already reads it, the Toggle Inline View command already writes it,
 * and the user setting is what makes the choice outlive the app.
 */
export class ReviewDiffLayoutSetting extends Disposable {
  private readonly _onDidChange = this._register(
    new Emitter<ReviewDiffLayout>(),
  );
  readonly onDidChange = this._onDidChange.event;

  constructor(
    @IConfigurationService
    private readonly configurationService: IConfigurationService,
  ) {
    super();
    this._register(
      configurationService.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(RENDER_SIDE_BY_SIDE_KEY)) {
          this._onDidChange.fire(this.get());
        }
      }),
    );
  }

  get(): ReviewDiffLayout {
    return this.configurationService.getValue<boolean>(
      RENDER_SIDE_BY_SIDE_KEY,
    ) === false
      ? "unified"
      : "split";
  }

  set(layout: ReviewDiffLayout): Promise<void> {
    return this.configurationService.updateValue(
      RENDER_SIDE_BY_SIDE_KEY,
      layout === "split",
      ConfigurationTarget.USER,
    );
  }

  toggle(): Promise<void> {
    return this.set(this.get() === "split" ? "unified" : "split");
  }
}
