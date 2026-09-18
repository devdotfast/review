from dataclasses import dataclass


@dataclass
class OrderRecord:
    id: str
    status: str


def save_order(order: OrderRecord) -> OrderRecord:
    return order
