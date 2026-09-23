/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface WhiteboardAboutDialogDetails {
  readonly title: string;
  readonly details: string;
  readonly detailsToCopy: string;
}

export function appendWhiteboardInstallId(
  about: WhiteboardAboutDialogDetails,
  installationId: string | undefined,
): WhiteboardAboutDialogDetails {
  const line = `install id: ${installationId || "Unknown"}`;
  return {
    ...about,
    details: `${about.details}\n${line}`,
    detailsToCopy: `${about.detailsToCopy}\n${line}`,
  };
}
