/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from "../../../../base/common/uri.js";
import {
  type IDisposable,
  type IReference,
} from "../../../../base/common/lifecycle.js";
import { Codicon } from "../../../../base/common/codicons.js";
import type { ThemeIcon } from "../../../../base/common/themables.js";
import { localize } from "../../../../nls.js";
import {
  EditorInputCapabilities,
  type GroupIdentifier,
  type IUntypedEditorInput,
  Verbosity,
} from "../../../../workbench/common/editor.js";
import { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import {
  IReviewSessionModelService,
  type ReviewSessionModel,
} from "../../../services/reviewSessionModelService.js";
import { shortPath } from "../../../common/reviewPaths.js";

export type ReviewCanvasEditorTarget =
  | { readonly kind: "home" }
  | { readonly kind: "welcome" }
  | { readonly kind: "settings" }
  | { readonly kind: "source" }
  | {
      readonly kind: "review";
      readonly reviewUuid: string;
      readonly revision?: string;
      readonly sealedAt?: number | null;
      readonly title: string;
      readonly repoLabel: string;
      readonly lastPublishedAt: string | null;
    };

export class ReviewCanvasEditorInput extends EditorInput {
  static readonly ID = "workbench.editors.devfast.reviewCanvas";
  static readonly EDITOR_ID = "workbench.editor.devfast.reviewCanvas";

  readonly resource: URI;
  private _target: ReviewCanvasEditorTarget;
  private modelReference:
    | IReference<ReviewSessionModel>
    | undefined;
  private modelReferencePromise:
    | Promise<IReference<ReviewSessionModel>>
    | undefined;
  private modelSubscription: IDisposable | undefined;
  private preferredSessionId: string | undefined;
  private preferredReviewUuid: string | undefined;
  private backgroundModelReference:
    | IReference<ReviewSessionModel>
    | undefined;
  private backgroundReviewUuid: string | undefined;
  private resetViewStateOnFirstRender = true;

  constructor(
    target: ReviewCanvasEditorTarget,
    @IReviewSessionModelService
    private readonly modelService: IReviewSessionModelService,
    @IEditorGroupsService
    private readonly editorGroupsService: IEditorGroupsService,
  ) {
    super();
    this._target = target;
    this.resource = URI.from({
      scheme: "devfast-review-canvas",
      authority: target.kind,
      path:
        target.kind === "review"
          ? `/${target.reviewUuid}${target.revision ? `/rev/${target.revision}` : ""}`
          : `/${target.kind}`,
    });
    if (target.kind === "source") {
      // The Source tab names the active review's worktree, so its label
      // follows the active session rather than anything on the target.
      this._register(
        this.modelService.onDidChangeActiveModel(() =>
          this._onDidChangeLabel.fire(),
        ),
      );
    }
  }

  get target(): ReviewCanvasEditorTarget {
    return this._target;
  }

  get resolvedModel(): ReviewSessionModel | undefined {
    return this.modelReference?.object;
  }

  override async resolve(
    preferredSessionId = this.preferredSessionId,
  ): Promise<ReviewSessionModel | null> {
    if (this._target.kind !== "review") {
      return null;
    }
    let acquiredNow = false;
    if (!this.modelReference) {
      this.modelReferencePromise ??= this.modelService
        .acquire(
          this._target.reviewUuid,
          preferredSessionId,
          this._target.revision
            ? { revision: this._target.revision }
            : undefined,
        )
        .catch((error) => {
          this.modelReferencePromise = undefined;
          throw error;
        });
      const reference = await this.modelReferencePromise;
      if (this.isDisposed()) {
        reference.dispose();
        throw new Error("The review editor input was disposed while resolving.");
      }
      if (!this.modelReference) {
        this.modelReference = reference;
        acquiredNow = true;
        this.modelSubscription = reference.object.onDidChange(() =>
          this.updateLabelFromModel(reference.object),
        );
        this.updateLabelFromModel(reference.object);
      } else if (this.modelReference !== reference) {
        reference.dispose();
      }
    }
    if (preferredSessionId && !acquiredNow) {
      await this.modelReference.object.refresh(preferredSessionId);
    }
    if (this.preferredSessionId === preferredSessionId) {
      this.preferredSessionId = undefined;
    }
    return this.modelReference.object;
  }

  preferSession(sessionId: string): void {
    this.preferredSessionId = sessionId;
  }

  /**
   * The review a Source tab browses when no session is otherwise active.
   * Persistent rather than one-shot: Home clears the active model, and a
   * later re-activation of the Source tab must be able to re-acquire it.
   * Also what names the tab before any session activates.
   */
  preferReview(reviewUuid: string): void {
    if (this.preferredReviewUuid === reviewUuid) {
      return;
    }
    this.preferredReviewUuid = reviewUuid;
    this._onDidChangeLabel.fire();
  }

  get preferredReview(): string | undefined {
    return this.preferredReviewUuid;
  }

  /**
   * Acquires and holds the preferred review's session for a Source tab, so
   * the workspace folder — and the file tree — can root at its pinned
   * worktree without a review document tab. The reference lives on this
   * input: closing the tab disposes it, which releases the session and its
   * pinned-worktree lease. Returns the model, or `null` when this tab has no
   * preferred review or was disposed while acquiring.
   */
  async resolveSourceModel(): Promise<ReviewSessionModel | null> {
    if (this._target.kind !== "source" || !this.preferredReviewUuid) {
      return null;
    }
    const reviewUuid = this.preferredReviewUuid;
    if (
      this.backgroundModelReference &&
      this.backgroundReviewUuid === reviewUuid
    ) {
      return this.backgroundModelReference.object;
    }
    const reference = await this.modelService.acquire(reviewUuid, undefined, {
      background: true,
    });
    if (this.isDisposed()) {
      reference.dispose();
      return null;
    }
    this.backgroundModelReference?.dispose();
    this.backgroundModelReference = reference;
    this.backgroundReviewUuid = reviewUuid;
    return reference.object;
  }

  takeViewStateResetRequest(): boolean {
    if (this._target.kind !== "review" || !this.resetViewStateOnFirstRender) {
      return false;
    }
    this.resetViewStateOnFirstRender = false;
    return true;
  }

  private updateLabelFromModel(model: ReviewSessionModel): void {
    const review = model.session.review;
    this.updateLabel(
      review.title,
      shortPath(review.worktreePath),
      review.lastPublishedAt,
    );
  }

  private updateLabel(title: string, repoLabel: string, lastPublishedAt: string | null): void {
    if (this._target.kind !== "review") return;
    if (this._target.revision) return;
    const labelChanged =
      this._target.title !== title ||
      this._target.repoLabel !== repoLabel ||
      this._target.lastPublishedAt !== lastPublishedAt;
    this._target = { ...this._target, title, repoLabel, lastPublishedAt };
    if (labelChanged) this._onDidChangeLabel.fire();
  }

  override get typeId(): string {
    return ReviewCanvasEditorInput.ID;
  }

  override get editorId(): string {
    return ReviewCanvasEditorInput.EDITOR_ID;
  }

  override get capabilities(): EditorInputCapabilities {
    let capabilities =
      EditorInputCapabilities.Readonly |
      EditorInputCapabilities.Singleton |
      EditorInputCapabilities.ForceReveal;
    if (this.target.kind === "home") {
      capabilities |= EditorInputCapabilities.CannotClose;
    }
    return capabilities;
  }

  override canMove(
    sourceGroup: GroupIdentifier,
    targetGroup: GroupIdentifier,
  ): true | string {
    if (
      this.target.kind === "home" &&
      this.editorGroupsService.getPart(targetGroup) !==
        this.editorGroupsService.mainPart
    ) {
      return localize(
        "reviewHomeCannotMove",
        "The Home tab cannot move to a separate window.",
      );
    }
    return super.canMove(sourceGroup, targetGroup);
  }

  override getName(): string {
    if (this.target.kind === "home") return "Home";
    if (this.target.kind === "welcome") return "Welcome";
    if (this.target.kind === "settings") return "Settings";
		if (this.target.kind === "source") {
			const worktreePath =
				this.modelService.activeModel?.session.review.worktreePath;
      return worktreePath ? shortPath(worktreePath) : "Source";
    }
    if (this.target.revision) {
      return `${this.target.title} — ${formatVersionDate(this.target.sealedAt)}`;
    }
    return this.target.title;
  }

  override getDescription(): string | undefined {
    return this.target.kind === "review" ? this.target.repoLabel : undefined;
  }

  override getTitle(verbosity?: Verbosity): string {
    if (this.target.kind !== "review" || verbosity !== Verbosity.LONG) {
      return this.getName();
    }
    return `${this.target.title} — ${this.target.repoLabel} — Published ${this.target.lastPublishedAt ?? "never"}`;
  }

  override getIcon(): ThemeIcon | undefined {
    if (this.target.kind === "home") return Codicon.home;
    if (this.target.kind === "source") return Codicon.repo;
    return undefined;
  }

  override matches(other: EditorInput | IUntypedEditorInput): boolean {
    return (
      super.matches(other) ||
      (other instanceof ReviewCanvasEditorInput &&
        other.resource.toString() === this.resource.toString())
    );
  }

  override dispose(): void {
    this.modelSubscription?.dispose();
    this.modelSubscription = undefined;
    this.modelReference?.dispose();
    this.modelReference = undefined;
    this.backgroundModelReference?.dispose();
    this.backgroundModelReference = undefined;
    super.dispose();
  }
}


function formatVersionDate(sealedAt: number | null | undefined): string {
  if (!sealedAt) return "older version";
  return new Date(sealedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
