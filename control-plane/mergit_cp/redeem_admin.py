"""Operator commands for redeem codes. Run on the server, inside the api container:

    python -m mergit_cp.redeem_admin create --usdc 20 [--count N] [--note TEXT] [--expires-days D]
    python -m mergit_cp.redeem_admin list
    python -m mergit_cp.redeem_admin revoke <code_id>

`create` prints each code once, to stdout. The code itself is never stored (only a keyed hash), so it cannot
be shown again; `list` shows ids, amounts, notes and status, never a code. The hash is keyed by
SESSION_SECRET, so rotating that secret makes every code that has not been redeemed unusable.
"""

import argparse
import re
import sys
from decimal import Decimal
from typing import Any

import psycopg
from psycopg import Connection

from .config import Settings
from .redeem import code_hash, new_code, normalise

MAX_UNITS = 1_000_000_000_000  # one million USDC, the ceiling the gateway also enforces on a grant
MAX_COUNT = 1000
_USDC = re.compile(r"^\d+(\.\d{1,6})?$")


def usdc_to_units(text: str) -> int:
    """``"7.5"`` -> 7500000. Exact: at most six decimals, positive, within the ceiling."""
    if not _USDC.match(text.strip()):
        raise ValueError(f"{text!r} is not an amount in USDC (digits, at most six decimals)")
    units = int(Decimal(text.strip()) * 1_000_000)
    if not 1 <= units <= MAX_UNITS:
        raise ValueError("the amount must be between 0.000001 and 1000000 USDC")
    return units


def create_codes(
    conn: Connection[Any],
    secret: bytes,
    amount_units: int,
    count: int,
    note: str,
    expires_days: int | None = None,
) -> list[tuple[str, str]]:
    """Makes ``count`` codes worth ``amount_units`` each. Returns (code_id, code); the code exists only
    here."""
    if not 1 <= amount_units <= MAX_UNITS:
        raise ValueError("the amount is out of range")
    if not 1 <= count <= MAX_COUNT:
        raise ValueError(f"count must be between 1 and {MAX_COUNT}")
    if expires_days is not None and expires_days < 1:
        raise ValueError("expires-days must be at least 1")
    made: list[tuple[str, str]] = []
    while len(made) < count:
        code = new_code()
        normalised = normalise(code)
        assert normalised is not None
        row = conn.execute(
            "INSERT INTO redeem_codes (code_hash, amount_usdc_units, note, expires_at)"
            " VALUES (%s, %s, %s, CASE WHEN %s::int IS NULL THEN NULL"
            "                        ELSE now() + make_interval(days => %s::int) END)"
            " ON CONFLICT (code_hash) DO NOTHING RETURNING code_id::text",
            (code_hash(secret, normalised), amount_units, note, expires_days, expires_days),
        ).fetchone()
        if row is not None:  # a collision at 80 bits is not expected; if it happens, draw another
            made.append((row[0], code))
    return made


def list_codes(conn: Connection[Any]) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT code_id::text, amount_usdc_units, note, created_at, expires_at, redeemed_by::text,"
        " redeemed_at,"
        " CASE WHEN redeemed_at IS NOT NULL THEN 'redeemed' WHEN revoked_at IS NOT NULL THEN 'revoked'"
        "      WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired' ELSE 'available' END"
        " FROM redeem_codes ORDER BY created_at, code_id"
    ).fetchall()
    keys = (
        "code_id",
        "amount_usdc_units",
        "note",
        "created_at",
        "expires_at",
        "redeemed_by",
        "redeemed_at",
        "state",
    )
    return [dict(zip(keys, r, strict=True)) for r in rows]


def revoke(conn: Connection[Any], code_id: str) -> None:
    row = conn.execute(
        "UPDATE redeem_codes SET revoked_at = now() WHERE code_id = %s::uuid"
        " AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING code_id",
        (code_id,),
    ).fetchone()
    if row is None:
        raise ValueError("no unused code with that id")


def _units_as_usdc(units: int) -> str:
    return f"{Decimal(units) / 1_000_000:f}".rstrip("0").rstrip(".") or "0"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="redeem_admin", description="Operator commands for redeem codes.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    make = sub.add_parser("create", help="make codes; each is printed once")
    make.add_argument("--usdc", required=True, help="amount per code in USDC, e.g. 20 or 7.5")
    make.add_argument("--count", type=int, default=1)
    make.add_argument("--note", default="", help="who it is for; shown in `list`, never in the code")
    make.add_argument("--expires-days", type=int, default=None)
    sub.add_parser("list", help="every code's id, amount, note and status (never the code)")
    drop = sub.add_parser("revoke", help="make an unused code unusable")
    drop.add_argument("code_id")
    args = parser.parse_args(argv)

    try:
        settings = Settings()  # type: ignore[call-arg]  # read from the environment, as the API does
        secret = settings.session_secret.get_secret_value().encode()
        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            if args.cmd == "create":
                units = usdc_to_units(args.usdc)
                made = create_codes(conn, secret, units, args.count, args.note, args.expires_days)
                print(
                    "Each code is shown once and cannot be recovered. Give each to one person.",
                    file=sys.stderr,
                )
                for _, code in made:
                    print(f"{code}  {_units_as_usdc(units)} USDC")
            elif args.cmd == "list":
                for r in list_codes(conn):
                    print(
                        f"{r['code_id']}  {_units_as_usdc(r['amount_usdc_units']):>8} USDC  {r['state']:<9}"
                        f"  {r['note']}"
                    )
            else:
                revoke(conn, args.code_id)
                print("revoked")
    except ValueError as problem:
        print(f"redeem_admin: {problem}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
