export interface OrderRecord {
  id: string;
  status: "draft" | "queued";
}

export function saveOrder(order: OrderRecord): OrderRecord {
  return order;
}
