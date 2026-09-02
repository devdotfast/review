import type { ComponentType } from "react";

import type { AnchorRef } from "../../src/authoring";
import type { NormalizedSoftwareModel } from "./software-map/model";

export interface ReadyReviewDocumentEntry {
  slug: string;
  routePath: string;
  filePath: string;
  title: string;
  documentSoftwareModels: NormalizedSoftwareModel[];
  anchors: ReadonlyMap<string, AnchorRef>;
  anchorContents: ReadonlyMap<string, string>;
  Component: ComponentType<{ components?: Record<string, unknown> }>;
  isDefault: boolean;
}
