package orders

// QueueOrder hands a queued order to the storage layer.
func QueueOrder(id string) OrderRecord {
	return SaveOrder(OrderRecord{ID: id, Status: "queued"})
}
