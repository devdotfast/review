import { z } from "zod";

import type { PublishedSoftwareMap } from "./App";
import {
  hydrateSoftwareModel,
  softwareModelDataSchema,
} from "./software-map/model";

// Published files carry a version marker in addition to the model data.
// Keep validating that envelope without passing unknown fields through.
const publishedMapSchema = softwareModelDataSchema.extend({
  format: z.literal("software-map/1").optional(),
});

export function hydratePublishedSoftwareMap(maps: {
  head: unknown;
  base: unknown;
}): PublishedSoftwareMap {
  return {
    head: hydrateSoftwareModel(publishedMapSchema.parse(maps.head)),
    base: hydrateSoftwareModel(publishedMapSchema.parse(maps.base)),
  };
}
