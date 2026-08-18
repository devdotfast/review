import { defineSoftwareMap } from "@dev.fast/progressive-review/software-map-model";

export default defineSoftwareMap({
  people: {},
  systems: {
    orderService: {
      label: "Order service",
      description:
        "Accepts checkout requests, records orders, and completes fulfillment.",
      containers: {
        api: {
          label: "Checkout API",
          description: "Provides the typed checkout entry point.",
          components: {
            checkout: {
              label: "Checkout API",
              description:
                "Accepts a checkout request and delegates order creation.",
              coverage: { files: ["src/api/checkout-api.ts"] },
            },
          },
        },
        application: {
          label: "Order application",
          description: "Applies the rules for creating an order.",
          components: {
            orders: {
              label: "Order service",
              description:
                "Calculates the total, reserves stock, charges payment, and creates the order.",
              coverage: {
                files: [
                  "src/orders/order-service.ts",
                  "src/orders/order.ts",
                  "src/inventory/inventory-service.ts",
                  "src/payments/payment-gateway.ts",
                ],
              },
            },
          },
        },
        data: {
          label: "Order data",
          description: "Stores orders and defines their persisted shape.",
          components: {
            ordersRepository: {
              label: "Orders repository",
              description:
                "Persists orders in memory and submits fulfillment jobs.",
              coverage: { files: ["src/orders/orders-repository.ts"] },
            },
            ordersDatabase: {
              label: "Orders table",
              description: "Defines the columns in the orders table.",
              coverage: { files: ["src/database/schema.ts"] },
            },
          },
        },
        fulfillment: {
          label: "Fulfillment",
          description: "Queues orders and runs one fulfillment job at a time.",
          components: {
            queue: {
              label: "Fulfillment queue",
              description: "Stores order identifiers until a worker can act.",
              coverage: {
                files: ["src/fulfillment/fulfillment-queue.ts"],
              },
            },
            worker: {
              label: "Fulfillment worker",
              description:
                "Loads a queued order, creates its shipment, and marks it fulfilled.",
              coverage: {
                files: ["src/fulfillment/fulfillment-worker.ts"],
              },
            },
          },
        },
        shipping: {
          label: "Shipping",
          description: "Creates shipment tracking records.",
          components: {
            gateway: {
              label: "Shipping gateway",
              description: "Creates a shipment for an order.",
              coverage: { files: ["src/shipping/shipping-gateway.ts"] },
            },
          },
        },
      },
    },
  },
  relationships: [
    {
      kind: "semantic",
      from: "orderService.api.checkout",
      to: "orderService.application.orders",
      label: "Creates an order",
    },
    {
      kind: "semantic",
      from: "orderService.application.orders",
      to: "orderService.data.ordersRepository",
      label: "Stores the order",
    },
    {
      kind: "semantic",
      from: "orderService.data.ordersRepository",
      to: "orderService.data.ordersDatabase",
      label: "Writes an order row",
    },
    {
      kind: "semantic",
      from: "orderService.data.ordersRepository",
      to: "orderService.fulfillment.queue",
      label: "Enqueues the order",
    },
    {
      kind: "semantic",
      from: "orderService.fulfillment.queue",
      to: "orderService.fulfillment.worker",
      label: "Dispatches the job",
    },
    {
      kind: "semantic",
      from: "orderService.fulfillment.worker",
      to: "orderService.shipping.gateway",
      label: "Creates a shipment",
    },
    {
      kind: "semantic",
      from: "orderService.fulfillment.worker",
      to: "orderService.data.ordersRepository",
      label: "Marks the order fulfilled",
    },
  ],
});
