import {
  defineActors,
  defineAnchors,
  defineStores,
} from "virtual:progressive-review-authoring";

export const anchors = defineAnchors({
  checkout: {
    title: "Checkout API calls the order service",
    peek: { file: "src/api/checkout-api.ts", fromLine: 12, toLine: 15 },
    softwareMapPath: "orderService.api.checkout",
  },
  placeOrder: {
    title: "Order service creates the order",
    peek: { file: "src/orders/order-service.ts", fromLine: 13, toLine: 29 },
    softwareMapPath: "orderService.application.orders",
  },
  insertOrder: {
    title: "Repository writes and queues the order",
    peek: { file: "src/orders/orders-repository.ts", fromLine: 9, toLine: 12 },
    softwareMapPath: "orderService.data.ordersRepository",
  },
  dequeue: {
    title: "Queue gives work to the fulfillment worker",
    peek: {
      file: "src/fulfillment/fulfillment-worker.ts",
      fromLine: 13,
      toLine: 14,
    },
    softwareMapPath: "orderService.fulfillment.worker",
  },
  ship: {
    title: "Worker creates the shipment",
    peek: {
      file: "src/fulfillment/fulfillment-worker.ts",
      fromLine: 17,
      toLine: 19,
    },
    softwareMapPath: "orderService.fulfillment.worker",
  },
  ordersTable: {
    title: "Orders table",
    peek: { file: "src/database/schema.ts", fromLine: 1, toLine: 10 },
    softwareMapPath: "orderService.data.ordersDatabase",
  },
});

export const actors = defineActors({
  checkout: {
    label: "Checkout API",
    softwareMapPath: "orderService.api.checkout",
  },
  orderService: {
    label: "Order service",
    softwareMapPath: "orderService.application.orders",
  },
  repository: {
    label: "Orders repository",
    softwareMapPath: "orderService.data.ordersRepository",
  },
  queue: {
    label: "Fulfillment queue",
    softwareMapPath: "orderService.fulfillment.queue",
  },
  worker: {
    label: "Fulfillment worker",
    softwareMapPath: "orderService.fulfillment.worker",
  },
  shipping: {
    label: "Shipping gateway",
    softwareMapPath: "orderService.shipping.gateway",
  },
});

export const checkoutSequence = [
  {
    from: actors.checkout,
    to: actors.orderService,
    label: "Place order",
    anchor: anchors.checkout,
  },
  {
    from: actors.orderService,
    to: actors.repository,
    label: "Save order",
    anchor: anchors.placeOrder,
  },
  {
    from: actors.repository,
    to: actors.queue,
    label: "Enqueue fulfillment",
    anchor: anchors.insertOrder,
  },
  {
    from: actors.queue,
    to: actors.worker,
    label: "Deliver job",
    anchor: anchors.dequeue,
  },
  {
    from: actors.worker,
    to: actors.shipping,
    label: "Create shipment",
    anchor: anchors.ship,
  },
];

export const stores = defineStores({
  orderDatabase: {
    kind: "relational",
    label: "Order database",
    softwareMapPath: "orderService.data.ordersDatabase",
    tables: {
      orders: {
        label: "orders",
        schema: {
          id: { type: "text", pk: true, example: "order-customer-42" },
          customerId: { type: "text", example: "customer-42" },
          totalCents: { type: "integer", example: 12500 },
          status: { type: "text", example: "fulfilled" },
          createdAt: { type: "timestamp", example: "2026-08-10T12:00:00Z" },
        },
      },
    },
  },
});
