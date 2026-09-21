export const ordersTable = {
  name: "orders",
  columns: {
    id: { type: "text", primaryKey: true },
    customerId: { type: "text" },
    totalCents: { type: "integer" },
    status: { type: "text" },
    createdAt: { type: "timestamp" },
  },
} as const;
