"""Refund maths for a tiny payments service."""


def refund_cents(charged_cents: int, refunded_cents: int, requested_cents: int) -> int:
    """How many cents a customer may be refunded now.

    A customer can be refunded up to what they were charged, across all their refunds. `refunded_cents` is what
    has already been refunded for this charge, and `requested_cents` is what they are asking for now. Returns the
    amount to refund, never negative and never more than is still refundable.
    """
    remaining = charged_cents - refunded_cents
    return min(requested_cents, remaining)
