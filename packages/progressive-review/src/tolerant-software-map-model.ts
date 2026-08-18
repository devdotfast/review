import {
  type NormalizedSoftwareModel,
  type SoftwareModelInput,
  SoftwareModelValidationError,
  defineSoftwareMap as defineStrictSoftwareMap,
} from "./software-map-model";

export function defineSoftwareMap(
  input: SoftwareModelInput,
): NormalizedSoftwareModel | null {
  try {
    return defineStrictSoftwareMap(input);
  } catch (error) {
    if (error instanceof SoftwareModelValidationError) {
      return null;
    }
    throw error;
  }
}
