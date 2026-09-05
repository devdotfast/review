import type { PublishedSoftwareMap } from "./App";
import {
  hydrateSoftwareModel,
  softwareModelDataSchema,
} from "./software-map/model";

export function hydratePublishedSoftwareMap(maps: {
  head: unknown;
  base: unknown;
}): PublishedSoftwareMap {
  return {
    head: hydrateSoftwareModel(softwareModelDataSchema.parse(maps.head)),
    base: hydrateSoftwareModel(softwareModelDataSchema.parse(maps.base)),
  };
}
