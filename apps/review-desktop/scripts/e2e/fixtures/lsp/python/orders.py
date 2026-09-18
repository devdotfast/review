from storage import save_order, OrderRecord


def queue_order(id: str) -> OrderRecord:
    return save_order(OrderRecord(id=id, status="queued"))
