/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IEditorOptions } from '../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../workbench/browser/editor.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import { EditorExtensions, EditorInputCapabilities, IEditorOpenContext } from '../../../workbench/common/editor.js';
import { EditorInput } from '../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';

/** Local UI for one Ask; never serialized or used as native session state. */
export class ReviewAskLoadingInput extends EditorInput {
  static readonly ID = 'review.askLoading';
  readonly resource: URI;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChangeStatus = this.changed.event;
  status = 'Waiting for agent…';

  constructor(messageId: string) {
    super();
    this.resource = URI.from({ scheme: 'review-ask', path: `/${messageId}` });
  }

  override get typeId(): string { return ReviewAskLoadingInput.ID; }
  override get capabilities(): EditorInputCapabilities {
    return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
  }
  override getName(): string { return 'Ask'; }

  fail(message: string): void {
    this.status = `Unable to open agent: ${message}`;
    this.changed.fire();
  }
}

class ReviewAskLoadingPane extends EditorPane {
  static readonly ID = 'review.askLoadingPane';
  private container!: HTMLElement;
  private readonly statusSubscription = this._register(new MutableDisposable());

  constructor(
    group: IEditorGroup,
    @ITelemetryService telemetry: ITelemetryService,
    @IThemeService theme: IThemeService,
    @IStorageService storage: IStorageService,
  ) { super(ReviewAskLoadingPane.ID, group, telemetry, theme, storage); }

  protected override createEditor(parent: HTMLElement): void {
    this.container = parent.ownerDocument.createElement('div');
    this.container.style.cssText = 'box-sizing:border-box;height:100%;padding:24px;font-family:var(--monaco-monospace-font);color:var(--vscode-descriptionForeground)';
    this.container.setAttribute('role', 'status');
    this.container.tabIndex = 0;
    parent.appendChild(this.container);
  }

  override async setInput(input: ReviewAskLoadingInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
    await super.setInput(input, options, context, token);
    const render = () => { this.container.textContent = input.status; };
    this.statusSubscription.value = input.onDidChangeStatus(render);
    render();
  }

  override clearInput(): void {
    this.statusSubscription.clear();
    this.container.textContent = '';
    super.clearInput();
  }
  override layout(_dimension: Dimension): void {}
  override focus(): void { this.container.focus(); }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
  EditorPaneDescriptor.create(ReviewAskLoadingPane, ReviewAskLoadingPane.ID, 'Ask'),
  [new SyncDescriptor(ReviewAskLoadingInput)],
);
