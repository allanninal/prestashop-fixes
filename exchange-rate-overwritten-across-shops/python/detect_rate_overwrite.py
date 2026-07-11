"""Detect PrestaShop multistore currency rates that were overwritten across shops.

PrestaShop stores a currency's exchange rate as a single conversion_rate column
on the ps_currency row for that currency id. Shops are linked to currencies
through ps_currency_shop, but that table only controls enable and disable
state, it has no rate column. So editing a rate for one shop context, or
letting cron_currency_rates.php run, writes the one shared column and every
shop using that currency id instantly inherits the new value (PrestaShop/
PrestaShop issues #23447 and #12025, closed as expected as is).

This script snapshots each shop's view of every currency's rate, keyed by
(id_shop, id_currency), and compares the new snapshot against the last one on
disk. When shops that used to disagree on a currency's rate now report the
identical rate, it is very likely an overwrite happened, and this is reported.
There is no safe automatic repair: restoring one shop's rate rewrites the same
shared column and would re-break every other shop again, so any corrective PUT
stays behind DRY_RUN and is a human decision.

Guide: https://www.allanninal.dev/prestashop/exchange-rate-overwritten-across-shops/

Run on a schedule. Safe to run again and again.
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_rate_overwrite")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
SNAPSHOT_FILE = os.environ.get("SNAPSHOT_FILE", "rate_snapshot.json")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def detect_rate_overwrite(previous_snapshot, current_snapshot, tolerance=1e-6):
    """Pure decision function, no I/O.

    previous_snapshot, current_snapshot: dict[tuple[int, int], float] mapping
        (id_shop, id_currency) to conversion_rate.
    tolerance: float, how close two rates must be to count as identical.

    Returns a list of findings, each a dict with id_currency,
    id_shops_collapsed, old_rates, new_rate, and likely_source_shop.
    A finding is emitted when two or more shops that previously disagreed on
    a currency's rate now report the identical rate, and that rate matches
    the rate most recently written in exactly one shop (the likely source).
    """
    by_currency = {}
    for (id_shop, id_currency), rate in current_snapshot.items():
        by_currency.setdefault(id_currency, []).append((id_shop, rate))

    findings = []
    for id_currency, shop_rates in by_currency.items():
        prior_rates = {
            id_shop: previous_snapshot[(id_shop, id_currency)]
            for id_shop, _ in shop_rates
            if (id_shop, id_currency) in previous_snapshot
        }
        if not _has_disagreement(prior_rates.values(), tolerance):
            continue  # shops agreed before, nothing to collapse

        for group in _group_by_tolerance(shop_rates, tolerance):
            shops_now = [id_shop for id_shop, _ in group]
            new_rate = group[0][1]
            disagreeing_before = [
                s for s in shops_now
                if s in prior_rates and abs(prior_rates[s] - new_rate) > tolerance
            ]
            if len(disagreeing_before) >= 2:
                source_candidates = [
                    s for s in shops_now
                    if s in prior_rates and abs(prior_rates[s] - new_rate) <= tolerance
                ]
                findings.append({
                    "id_currency": id_currency,
                    "id_shops_collapsed": sorted(disagreeing_before),
                    "old_rates": {s: prior_rates[s] for s in disagreeing_before},
                    "new_rate": new_rate,
                    "likely_source_shop": source_candidates[0] if len(source_candidates) == 1 else None,
                })
    return findings


def _has_disagreement(rates, tolerance):
    """True when the given rates are not all within tolerance of each other."""
    rates = list(rates)
    if len(rates) < 2:
        return False
    base = rates[0]
    return any(abs(r - base) > tolerance for r in rates[1:])


def _group_by_tolerance(shop_rates, tolerance):
    """Group (id_shop, rate) pairs into clusters whose rates are mutually
    within tolerance of each other. Simple, order-independent clustering
    that is adequate for the small number of shops a currency has."""
    groups = []
    for id_shop, rate in shop_rates:
        placed = False
        for group in groups:
            if abs(group[0][1] - rate) <= tolerance:
                group.append((id_shop, rate))
                placed = True
                break
        if not placed:
            groups.append([(id_shop, rate)])
    return groups


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def all_shop_ids():
    data = api_get("shops", params={"display": "full"})
    rows = data.get("shops") or []
    return [int(row["id"]) for row in rows]


def currencies_for_shop(id_shop):
    data = api_get("currencies", params={
        "display": "full",
        "filter[active]": "1",
        "id_shop": id_shop,
    })
    return data.get("currencies") or []


def build_snapshot(shop_ids):
    snapshot = {}
    for id_shop in shop_ids:
        for row in currencies_for_shop(id_shop):
            key = (int(id_shop), int(row["id"]))
            snapshot[key] = float(row["conversion_rate"])
    return snapshot


def load_snapshot(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return {
        (int(item["id_shop"]), int(item["id_currency"])): float(item["conversion_rate"])
        for item in raw.get("entries", [])
    }


def save_snapshot(path, snapshot):
    entries = [
        {"id_shop": id_shop, "id_currency": id_currency, "conversion_rate": rate}
        for (id_shop, id_currency), rate in snapshot.items()
    ]
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"entries": entries}, f, indent=2)


def api_put_restore_rate(id_currency, currency_body, restored_rate):
    # Restoring one shop's rate rewrites the single shared conversion_rate
    # column, which will simultaneously re-break every other shop sharing
    # this currency id. Only call this after a human has confirmed which
    # rate is authoritative, and never from an automatic branch.
    body = dict(currency_body)
    body["conversion_rate"] = restored_rate
    r = requests.put(
        f"{PRESTASHOP_URL}/api/currencies/{id_currency}",
        params={"output_format": "JSON"}, auth=AUTH,
        json={"currency": body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    shop_ids = all_shop_ids()
    current = build_snapshot(shop_ids)
    previous = load_snapshot(SNAPSHOT_FILE)

    findings = detect_rate_overwrite(previous, current)
    for f in findings:
        log.warning(
            "Currency id=%s rate collapsed to %s across shops %s. old_rates=%s likely_source_shop=%s",
            f["id_currency"], f["new_rate"], f["id_shops_collapsed"],
            f["old_rates"], f["likely_source_shop"],
        )
        if not DRY_RUN:
            log.info(
                "DRY_RUN is false, but this script never auto-repairs currency id=%s. "
                "Restoring one shop's rate would re-break every other shop sharing it. "
                "Decide the authoritative rate by hand, then call api_put_restore_rate() explicitly.",
                f["id_currency"],
            )

    save_snapshot(SNAPSHOT_FILE, current)
    log.info("Done. %d suspected overwrite(s) found across %d shop(s).", len(findings), len(shop_ids))


if __name__ == "__main__":
    run()
