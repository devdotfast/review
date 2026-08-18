import type { OrdersRepository } from "../orders/orders-repository.js";
import type { ShippingGateway } from "../shipping/shipping-gateway.js";
import type { FulfillmentQueue } from "./fulfillment-queue.js";

export class FulfillmentWorker {
  constructor(
    private readonly queue: FulfillmentQueue,
    private readonly orders: OrdersRepository,
    private readonly shipping: ShippingGateway,
  ) {}

  runNext(): string | null {
    const job = this.queue.dequeue();
    if (!job) return null;
    const order = this.orders.find(job.orderId);
    if (!order) throw new Error(`Order not found: ${job.orderId}`);
    const shipment = this.shipping.createShipment(order);
    this.orders.setStatus(order.id, "fulfilled");
    return shipment.trackingNumber;
  }
}
