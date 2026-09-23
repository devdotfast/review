mod storage;

pub use storage::OrderRecord;

/// Hands a queued order to the storage layer.
pub fn queue_order(id: String) -> OrderRecord {
    let status = "queued".to_string();
    storage::save_order(OrderRecord { id, status })
}
