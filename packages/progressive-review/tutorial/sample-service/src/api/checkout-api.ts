import type { OrderService } from "../orders/order-service.js";
import type { CheckoutRequest, Order } from "../orders/order.js";

export interface CheckoutResponse {
  status: 201;
  order: Order;
}

export class CheckoutApi {
  constructor(private readonly orderService: OrderService) {}

  checkout(request: CheckoutRequest): CheckoutResponse {
    const order = this.orderService.placeOrder(request);
    return { status: 201, order };
  }
}
