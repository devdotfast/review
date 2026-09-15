import {
  hydrateSoftwareModel,
  softwareMapDataFileSchema,
} from "./software-map/model";

export function hydratePublishedSoftwareMap(maps: {
  head: unknown;
  base: unknown;
}) {
  return {
    head: hydrateSoftwareModel(softwareMapDataFileSchema.parse(maps.head)),
    base: hydrateSoftwareModel(softwareMapDataFileSchema.parse(maps.base)),
  };
}
