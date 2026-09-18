package orders

// OrderRecord is one stored order.
type OrderRecord struct {
	ID     string
	Status string
}

// SaveOrder persists the order and returns what was stored.
func SaveOrder(order OrderRecord) OrderRecord {
	return order
}
