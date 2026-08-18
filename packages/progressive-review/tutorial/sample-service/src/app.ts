import { CheckoutApi } from "./api/checkout-api.js";
import { FulfillmentQueue } from "./fulfillment/fulfillment-queue.js";
import { FulfillmentWorker } from "./fulfillment/fulfillment-worker.js";
import { InventoryService } from "./inventory/inventory-service.js";
import { OrderService } from "./orders/order-service.js";
import { OrdersRepository } from "./orders/orders-repository.js";
import { PaymentGateway } from "./payments/payment-gateway.js";
import { ShippingGateway } from "./shipping/shipping-gateway.js";

const queue = new FulfillmentQueue();
const orders = new OrdersRepository(queue);
const orderService = new OrderService(
  new InventoryService(),
  new PaymentGateway(),
  orders,
);

export const checkoutApi = new CheckoutApi(orderService);
export const fulfillmentWorker = new FulfillmentWorker(
  queue,
  orders,
  new ShippingGateway(),
);
