export type OrderStatus = "pending" | "queued" | "fulfilled";

export interface CheckoutItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  customerId: string;
  items: readonly CheckoutItem[];
  totalCents: number;
  status: OrderStatus;
}

export interface CheckoutRequest {
  customerId: string;
  items: readonly CheckoutItem[];
  paymentToken: string;
}
