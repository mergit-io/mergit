from payments.refund import refund_cents


def test_a_partial_refund_is_paid_in_full():
    assert refund_cents(charged_cents=1000, refunded_cents=0, requested_cents=400) == 400


def test_a_second_refund_is_limited_to_what_is_left():
    assert refund_cents(charged_cents=1000, refunded_cents=700, requested_cents=500) == 300


def test_nothing_is_refunded_once_the_charge_is_fully_refunded():
    assert refund_cents(charged_cents=1000, refunded_cents=1000, requested_cents=100) == 0


def test_an_over_refunded_charge_never_returns_a_negative_amount():
    # Refunds recorded by a bug elsewhere can add up to more than the charge. The answer is still zero, not minus.
    assert refund_cents(charged_cents=1000, refunded_cents=1200, requested_cents=100) == 0


def test_a_zero_request_refunds_nothing():
    assert refund_cents(charged_cents=1000, refunded_cents=0, requested_cents=0) == 0
