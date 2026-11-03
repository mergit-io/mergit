# demo-repo

The repository Mergit's end-to-end check works on (`deploy/e2e/honest_run.md`). It is a tiny payments helper with one
real bug: `tests/test_refund.py` fails on the main branch. Goal to give Mergit:

> Fix the failing refund test: `refund_cents` can return a negative amount.

The check is `pytest tests/test_refund.py -q`; the fix belongs in `payments/refund.py` only.
