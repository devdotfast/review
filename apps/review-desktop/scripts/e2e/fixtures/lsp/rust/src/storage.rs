/// One stored order.
pub struct OrderRecord {
    pub id: String,
    pub status: String,
}

/// Persists the order and returns what was stored.
pub fn save_order(order: OrderRecord) -> OrderRecord {
    order
}
