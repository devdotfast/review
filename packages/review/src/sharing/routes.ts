import { SessionInputError } from "../review-api/document.js";
import type { SharedSessionStore } from "./import.js";

/** Snapshot-backed reads used by the same HTTP routes as local reviews. */
export class SharedSessionData {
  constructor(private readonly store: SharedSessionStore) {}

  map(id: string, resourceId: string) {
    const map = this.store.get(id).presentation.maps[resourceId];

    if (!map)
      throw new SessionInputError("Map is not included in this share.", 404);

    return map;
  }

  async resource(id: string, resourceId: string) {
    const resource = this.store
      .get(id)
      .manifest.resources.find((item) => item.id === resourceId);

    if (!resource)
      throw new SessionInputError(
        "Resource is not included in this share.",
        404,
      );

    return {
      data: await this.store.readObject(id, resource.object),
      mimeType: resource.mimeType,
    };
  }
}
