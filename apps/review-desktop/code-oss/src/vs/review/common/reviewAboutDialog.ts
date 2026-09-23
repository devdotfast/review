/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewAboutDialogDetails {
  readonly title: string;
  readonly details: string;
  readonly detailsToCopy: string;
}

export function appendReviewInstallId(
  about: ReviewAboutDialogDetails,
  installationId: string | undefined,
): ReviewAboutDialogDetails {
  const line = `install id: ${installationId || "Unknown"}`;
  return {
    ...about,
    details: `${about.details}\n${line}`,
    detailsToCopy: `${about.detailsToCopy}\n${line}`,
  };
}
