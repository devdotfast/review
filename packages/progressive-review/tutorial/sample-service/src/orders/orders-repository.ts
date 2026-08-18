import type { FulfillmentQueue } from "../fulfillment/fulfillment-queue.js";
import type { Order, OrderStatus } from "./order.js";

export class OrdersRepository {
  private readonly rows = new Map<string, Order>();

  constructor(private readonly queue: FulfillmentQueue) {}

  insert(order: Order): void {
    this.rows.set(order.id, order);
    this.queue.enqueue({ orderId: order.id });
  }

  find(orderId: string): Order | undefined {
    return this.rows.get(orderId);
  }

  setStatus(orderId: string, status: OrderStatus): void {
    const order = this.find(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    this.rows.set(orderId, { ...order, status });
  }
}
