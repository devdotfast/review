import type { CheckoutItem } from "../orders/order.js";

export class InventoryService {
  reserve(items: readonly CheckoutItem[]): void {
    const unavailable = items.find((item) => item.quantity < 1);
    if (unavailable) {
      throw new Error(`Invalid quantity for ${unavailable.sku}`);
    }
  }
}
