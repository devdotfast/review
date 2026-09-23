import type { Order } from "../orders/order.js";

export interface Shipment {
  trackingNumber: string;
  orderId: string;
}

export class ShippingGateway {
  createShipment(order: Order): Shipment {
    return {
      trackingNumber: `track-${order.id}`,
      orderId: order.id,
    };
  }
}
