#!/usr/bin/env python3
"""noapi invoice reconciliation — stdlib only, runs in a bare Solari sandbox.

Usage: python3 reconcile.py [workdir]   (default /work)

Reads  <workdir>/invoices/*.txt   ("key: value" lines)
       <workdir>/ledger.csv       (invoice,vendor,amount,due)
       <workdir>/policy.yaml      (flat key: value lines, # comments)

Writes <workdir>/exceptions.csv   one row per disagreement
       <workdir>/chart.png        deterministic bar chart of exceptions by reason

Prints grepable lines: reconcile.invoices n=.. / reconcile.ledger n=.. /
reconcile.exceptions n=.. / reconcile.ok
Exit 0 on success, 2 with a message on missing inputs.
"""
import csv
import os
import struct
import sys
import zlib

REASONS = ("amount_mismatch", "missing_in_ledger", "missing_invoice")


def die(msg):
    print(f"reconcile.error {msg}", file=sys.stderr)
    sys.exit(2)


def read_policy(path):
    policy = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            key, _, value = line.partition(":")
            policy[key.strip()] = value.strip()
    return policy


def read_invoices(dirpath):
    invoices = {}
    for name in sorted(os.listdir(dirpath)):
        if not name.endswith(".txt"):
            continue
        fields = {}
        with open(os.path.join(dirpath, name), "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or ":" not in line:
                    continue
                key, _, value = line.partition(":")
                fields[key.strip()] = value.strip()
        inv_id = fields.get("invoice")
        if inv_id:
            invoices[inv_id] = fields
    return invoices


def read_ledger(path):
    rows = {}
    with open(path, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            inv_id = (row.get("invoice") or "").strip()
            if inv_id:
                rows[inv_id] = row
    return rows


def reconcile(invoices, ledger, tolerance):
    exceptions = []
    for inv_id in sorted(set(invoices) | set(ledger)):
        inv = invoices.get(inv_id)
        led = ledger.get(inv_id)
        vendor = (inv or led).get("vendor", "")
        inv_amt = inv.get("amount", "") if inv else ""
        led_amt = led.get("amount", "") if led else ""
        if led is None:
            reason = "missing_in_ledger"
        elif inv is None:
            reason = "missing_invoice"
        else:
            try:
                if abs(float(inv_amt) - float(led_amt)) > tolerance:
                    reason = "amount_mismatch"
                else:
                    continue
            except ValueError:
                reason = "amount_mismatch"
        exceptions.append(
            {
                "invoice": inv_id,
                "vendor": vendor,
                "invoice_amount": inv_amt,
                "ledger_amount": led_amt,
                "reason": reason,
            }
        )
    return exceptions


def write_chart(path, exceptions):
    """Deterministic PNG, no PIL: white canvas, black title bar, one gray
    bar per reason scaled to the max count."""
    width, height, title_h = 320, 200, 20
    counts = {r: sum(1 for e in exceptions if e["reason"] == r) for r in REASONS}
    peak = max(counts.values()) or 1
    px = bytearray(b"\xff" * (width * height * 3))  # white

    def fill(x0, y0, x1, y1, rgb):
        for y in range(max(0, y0), min(height, y1)):
            for x in range(max(0, x0), min(width, x1)):
                i = (y * width + x) * 3
                px[i : i + 3] = bytes(rgb)

    fill(0, 0, width, title_h, (0, 0, 0))  # title bar
    bar_w, gap = 60, 40
    x = gap
    for reason in REASONS:
        bar_h = int((height - title_h - 20) * counts[reason] / peak)
        fill(x, height - 10 - bar_h, x + bar_w, height - 10, (60, 60, 60))
        x += bar_w + gap

    raw = b"".join(
        b"\x00" + bytes(px[y * width * 3 : (y + 1) * width * 3])
        for y in range(height)
    )

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    workdir = sys.argv[1] if len(sys.argv) > 1 else "/work"
    inv_dir = os.path.join(workdir, "invoices")
    ledger_path = os.path.join(workdir, "ledger.csv")
    policy_path = os.path.join(workdir, "policy.yaml")
    for path in (inv_dir, ledger_path, policy_path):
        if not os.path.exists(path):
            die(f"missing input: {path}")

    policy = read_policy(policy_path)
    try:
        tolerance = float(policy.get("amount_tolerance", "0.01"))
    except ValueError:
        die(f"bad amount_tolerance in {policy_path}")

    invoices = read_invoices(inv_dir)
    ledger = read_ledger(ledger_path)
    print(f"reconcile.invoices n={len(invoices)}")
    print(f"reconcile.ledger n={len(ledger)}")

    exceptions = reconcile(invoices, ledger, tolerance)
    out_csv = os.path.join(workdir, "exceptions.csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=("invoice", "vendor", "invoice_amount", "ledger_amount", "reason"),
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(exceptions)
    print(f"reconcile.exceptions n={len(exceptions)}")

    write_chart(os.path.join(workdir, "chart.png"), exceptions)
    print("reconcile.ok")
    sys.exit(0)


if __name__ == "__main__":
    main()
