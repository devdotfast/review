/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button } from "../../base/browser/ui/button/button.js";
import { Codicon } from "../../base/common/codicons.js";
import type { IObservable } from "../../base/common/observable.js";
import { isEqual } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import type {
  IResourceLabel,
  IResourceHeaderMetadata,
  IWorkbenchUIElementFactory,
} from "../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js";
import type { IDiffCodeEditorWidgetOptions } from "../../editor/browser/widget/diffEditor/diffEditorWidget.js";
import { FileKind } from "../../platform/files/common/files.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ResourceLabel } from "../../workbench/browser/labels.js";
import type { ReviewDiffFileWire } from "../common/reviewProtocol.js";

export interface ReviewMultiDiffHeaderEntry {
  readonly original: URI | undefined;
  readonly modified: URI | undefined;
  readonly additions?: number;
  readonly deletions?: number;
  readonly generated?: boolean;
  readonly onDidOpen?: () => void;
}

export class ReviewMultiDiffUIElementFactory
  implements IWorkbenchUIElementFactory
{
  get headerClickToCollapse(): boolean {
    return !this.hideResourceHeader;
  }

  constructor(
    private readonly entries: () => readonly ReviewMultiDiffHeaderEntry[],
    readonly horizontalScrollbar: "auto" | "hidden",
    readonly overflowWidgetsDomNode: HTMLElement | undefined,
    readonly scrollRange:
      | IObservable<{ start: number; endExclusive: number } | undefined>
      | undefined,
    readonly hideResourceHeader = false,
    readonly codeEditorWidgetOptions: IDiffCodeEditorWidgetOptions | undefined,
    @IInstantiationService
    private readonly instantiationService: IInstantiationService,
  ) {}

  createResourceLabel(element: HTMLElement): IResourceLabel {
    element.classList.add("review-path-label");
    const label = this.instantiationService.createInstance(
      ResourceLabel,
      element,
      {},
    );
    return {
      setUri(uri, options = {}) {
        if (!uri) {
          label.element.clear();
          return;
        }
        // `setFile` splits the URI into a file name and a folder. The header
        // prints the whole path instead, and the CSS elides it from the left.
        label.element.setResource(
          { resource: uri, name: reviewMultiDiffLabelPath(uri) },
          {
            fileKind: FileKind.FILE,
            forceLabel: true,
            strikethrough: options.strikethrough,
          },
        );
      },
      setLabel(name, description, resource, options = {}) {
        if (resource) {
          label.element.setResource(
            { resource, name, description },
            { strikethrough: options.strikethrough },
          );
        } else {
          label.element.setLabel(name, description, {
            strikethrough: options.strikethrough,
          });
        }
      },
      dispose() {
        label.dispose();
      },
    };
  }

  createResourceHeaderMetadata(element: HTMLElement): IResourceHeaderMetadata {
    const ownerDocument = element.ownerDocument;
    const additions = ownerDocument.createElement("span");
    additions.className = "review-multidiff-additions";
    const deletions = ownerDocument.createElement("span");
    deletions.className = "review-multidiff-deletions";
    const counts = ownerDocument.createElement("span");
    counts.className = "review-multidiff-counts";
    counts.append(additions, deletions);
    element.append(counts);

    const generated = ownerDocument.createElement("span");
    generated.className = "review-multidiff-generated";
    generated.textContent = "Generated";
    generated.hidden = true;
    element.append(generated);

    const openContainer = ownerDocument.createElement("span");
    openContainer.className = "review-multidiff-open-container";
    element.append(openContainer);
    const open = new Button(openContainer, {
      ariaLabel: "Open File",
      title: "Open File",
      supportIcons: true,
    });
    open.label = `$(${Codicon.goToFile.id}) Open file`;
    open.element.classList.add("review-multidiff-open");
    let current: ReviewMultiDiffHeaderEntry | undefined;
    const openListener = open.onDidClick(() => current?.onDidOpen?.());

    return {
      setUris: (uris) => {
        current = uris
          ? this.entries().find(
              (entry) =>
                sameResource(entry.original, uris.original) &&
                sameResource(entry.modified, uris.modified),
            )
          : undefined;
        element.hidden = !current;
        if (!current) return;
        const hasCounts =
          current.additions !== undefined && current.deletions !== undefined;
        counts.hidden = !hasCounts;
        if (hasCounts) {
          additions.textContent = `+${current.additions}`;
          deletions.textContent = `−${current.deletions}`;
          counts.setAttribute(
            "aria-label",
            `${current.additions} lines added, ${current.deletions} lines removed`,
          );
        }
        generated.hidden = !current.generated;
        openContainer.hidden = !current.onDidOpen;
      },
      dispose() {
        openListener.dispose();
        open.dispose();
        element.replaceChildren();
      },
    };
  }
}

function sameResource(left: URI | undefined, right: URI | undefined): boolean {
  return left === undefined
    ? right === undefined
    : !!right && isEqual(left, right);
}

export function reviewMultiDiffLabelUris(file: ReviewDiffFileWire): {
  readonly original: URI | undefined;
  readonly modified: URI | undefined;
} {
  return {
    original:
      file.status === "added"
        ? undefined
        : reviewFileLabelUri(file.previousPath ?? file.path),
    modified:
      file.status === "deleted"
        ? undefined
        : reviewFileLabelUri(file.path),
  };
}

function reviewFileLabelUri(path: string): URI {
  return URI.from({ scheme: "file", path: `/${path}` });
}

function reviewMultiDiffLabelPath(uri: URI): string {
  return uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
}
