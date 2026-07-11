"""Detect and repair PrestaShop PATCH writes to stock_availables that get silently dropped.

PrestaShop's webservice sits behind Apache mod_rewrite and often a reverse proxy or CDN.
A PATCH to /api/stock_availables/{id} that does not match the exact expected URL can
trigger a 301 or 302 redirect, and most HTTP clients replay that redirect as a GET and
drop the body. The server then returns 200 for a read, not your write, so the quantity
never actually changes even though nothing errored. This reads the quantity before the
write, sends the PATCH while watching for a redirect and a method change, re-reads right
after, and only falls back to a full PUT once a drop is confirmed. It never blindly
retries the same PATCH. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/stock-patch-silently-dropped/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stock_patch_guard")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REDIRECT_CODES = (301, 302, 303, 307, 308)


def stock_available_url(id_stock_available):
    return f"{BASE_URL}/api/stock_availables/{id_stock_available}"


def read_stock_available(id_stock_available):
    r = requests.get(
        stock_available_url(id_stock_available),
        params={"output_format": "JSON"},
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    row = r.json()["stock_available"]
    return {
        "id_stock_available": int(row["id"]),
        "id_product": int(row.get("id_product") or 0),
        "id_product_attribute": int(row.get("id_product_attribute") or 0),
        "id_shop": int(row.get("id_shop") or 1),
        "quantity": int(row.get("quantity") or 0),
        "depends_on_stock": int(row.get("depends_on_stock") or 0),
        "out_of_stock": int(row.get("out_of_stock") or 0),
    }


def patch_quantity(id_stock_available, new_qty):
    body = {"stock_available": {"id": id_stock_available, "quantity": str(new_qty)}}
    r = requests.patch(
        stock_available_url(id_stock_available),
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
        allow_redirects=False,
    )
    redirected = r.status_code in REDIRECT_CODES
    final_method = "GET" if redirected else "PATCH"
    return {"status_code": r.status_code, "redirected": redirected, "final_method": final_method}


def decide_write_status(pre_qty: int, attempted_qty: int, post_qty: int, redirected: bool, final_method: str) -> str:
    """
    Pure decision logic, no I/O. Given the quantity read before the write, the quantity
    the caller attempted to set, the quantity read immediately after the write, whether
    the HTTP client followed a redirect, and the HTTP method that was actually applied,
    return one of: "applied", "silently_dropped_redirect", "silently_dropped_other", "no_op".
    """
    if attempted_qty == pre_qty:
        return "no_op"
    if post_qty == attempted_qty:
        return "applied"
    if redirected and final_method.upper() == "GET":
        return "silently_dropped_redirect"
    return "silently_dropped_other"


def put_fallback(row, new_qty):
    body = {
        "stock_available": {
            "id": row["id_stock_available"],
            "id_product": row["id_product"],
            "id_product_attribute": row["id_product_attribute"],
            "id_shop": row["id_shop"],
            "quantity": str(new_qty),
            "depends_on_stock": row["depends_on_stock"],
            "out_of_stock": row["out_of_stock"],
        }
    }
    r = requests.put(
        stock_available_url(row["id_stock_available"]),
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def guard_write(id_stock_available, new_qty):
    pre_row = read_stock_available(id_stock_available)
    pre_qty = pre_row["quantity"]

    patch_result = patch_quantity(id_stock_available, new_qty)
    post_row = read_stock_available(id_stock_available)
    post_qty = post_row["quantity"]

    status = decide_write_status(
        pre_qty, new_qty, post_qty, patch_result["redirected"], patch_result["final_method"]
    )

    record = {
        "id_stock_available": id_stock_available,
        "id_product": pre_row["id_product"],
        "id_product_attribute": pre_row["id_product_attribute"],
        "id_shop": pre_row["id_shop"],
        "old_qty": pre_qty,
        "attempted_new_qty": new_qty,
        "status": status,
    }

    if status in ("applied", "no_op"):
        log.info("Stock %s: %s (qty %s to %s)", id_stock_available, status, pre_qty, post_qty)
        return record

    log.warning(
        "Stock %s: PATCH %s (qty stayed %s, wanted %s). %s",
        id_stock_available, status, post_qty, new_qty,
        "flagged, needs manual PUT retry" if DRY_RUN else "falling back to PUT",
    )

    if not DRY_RUN:
        put_fallback(post_row, new_qty)
        verify_row = read_stock_available(id_stock_available)
        record["status"] = "applied" if verify_row["quantity"] == new_qty else "still_dropped"
        record["post_qty"] = verify_row["quantity"]

    return record


def run(writes):
    applied = 0
    flagged = 0
    for id_stock_available, new_qty in writes:
        record = guard_write(id_stock_available, new_qty)
        if record["status"] == "applied":
            applied += 1
        elif record["status"] in ("silently_dropped_redirect", "silently_dropped_other", "still_dropped"):
            flagged += 1
    log.info(
        "Done. %d write(s) applied, %d %s.",
        applied, flagged, "flagged: PATCH silently dropped, needs manual PUT retry" if DRY_RUN else "still needing review",
    )


if __name__ == "__main__":
    # Example: guard_write a single stock_available id against a target quantity.
    # Replace with your own source of (id_stock_available, new_qty) pairs.
    run([])
