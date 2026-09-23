import { saveOrder } from "./storage.js";

export function queueOrder(id: string) {
  return saveOrder({ id, status: "queued" });
}
