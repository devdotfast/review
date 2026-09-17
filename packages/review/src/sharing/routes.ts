import { ReviewInputError } from "../review-api/document.js";
import { attachedSource } from "./clone.js";
import type { SharedReviewStore } from "./import.js";

/** Snapshot-backed reads used by the same HTTP routes as local reviews. */
export class SharedReviewData {
  constructor(private readonly store: SharedReviewStore) {}

  async file(id: string, side: "base" | "head", file: string) {
    const { manifest, snapshot } = this.store.get(id);

    const entry = manifest.files.find(
      (entry) => entry.side === side && entry.file === file,
    );

    if (!entry?.object)
      throw new ReviewInputError("File is not included in this share.", 404);

    return {
      file,
      side,
      commit: snapshot.pins[side],
      text: (await this.store.readObject(id, entry.object)).toString(),
    };
  }

  async attachment(id: string, side: "base" | "head", file: string) {
    const entry = this.store
      .get(id)
      .manifest.files.find(
        (entry) => entry.side === side && entry.file === file,
      );

    if (!entry?.object)
      throw new ReviewInputError("File is not included in this share.", 404);

    return (await attachedSource(this.store, id, side, file)) ?? {};
  }

  tree(id: string, side: "base" | "head", prefix: string) {
    const directory = prefix ? prefix.replace(/\/$/, "") + "/" : "";

    const entries = new Map<
      string,
      { path: string; kind: "file" | "directory" }
    >();

    for (const file of this.store.get(id).manifest.files) {
      if (
        file.side !== side ||
        !file.object ||
        !file.file.startsWith(directory)
      )
        continue;
      const relative = file.file.slice(directory.length);
      const name = relative.split("/")[0]!;
      entries.set(name, {
        path: directory + name,
        kind: relative.includes("/") ? "directory" : "file",
      });
    }

    return [...entries.values()];
  }

  diff(id: string, file?: string) {
    const diffs = this.store.get(id).presentation.diffs;

    if (!file) return diffs;
    const diff = diffs.find((entry) => entry.path === file);

    if (!diff)
      throw new ReviewInputError("Diff is not included in this share.", 404);

    return diff.patch;
  }

  map(id: string, resourceId: string) {
    const map = this.store.get(id).presentation.maps[resourceId];

    if (!map)
      throw new ReviewInputError("Map is not included in this share.", 404);

    return map;
  }

  async resource(id: string, resourceId: string) {
    const resource = this.store
      .get(id)
      .manifest.resources.find((item) => item.id === resourceId);

    if (!resource)
      throw new ReviewInputError(
        "Resource is not included in this share.",
        404,
      );

    return {
      data: await this.store.readObject(id, resource.object),
      mimeType: resource.mimeType,
    };
  }
}
