# Currency exchange rate update in one shop overwrites another shop's rate

PrestaShop stores a currency's exchange rate as a single `conversion_rate` column on the `ps_currency` row for that currency id, not one value per shop. Shops are linked to currencies through `ps_currency_shop`, but that table only controls whether the currency is enabled for a shop, it has no rate column of its own. So editing the rate for one shop context, or letting `cron_currency_rates.php` run, writes the one shared column and every shop using that currency id instantly inherits the new value. This is confirmed as expected behavior in PrestaShop/PrestaShop issues #23447 and #12025.

This job snapshots each shop's view of every currency's rate, keyed by shop id and currency id, and compares the new snapshot against the last one on disk. When shops that used to disagree on a currency's rate now report the identical rate, it flags a suspected overwrite. There is no safe automatic repair: restoring one shop's rate rewrites the same shared column and would re-break every other shop again, so it reports by default and never writes on its own.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/exchange-rate-overwritten-across-shops/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export SNAPSHOT_FILE="rate_snapshot.json"
export DRY_RUN="true"

python exchange-rate-overwritten-across-shops/python/detect_rate_overwrite.py
node   exchange-rate-overwritten-across-shops/node/detect-rate-overwrite.js
```

`detect_rate_overwrite` is a pure function: it takes a previous and a current snapshot mapping `(id_shop, id_currency)` to `conversion_rate`, and returns a finding whenever two or more shops that previously disagreed on a currency's rate now report the identical rate. Each finding includes the affected shop ids, the old rates, the new collapsed rate, and the likely source shop when it can be identified unambiguously. The script only ever reports; there is no corrective write path wired into the default run, since restoring one shop's rate would simultaneously re-break every other shop sharing that currency id. Start with `DRY_RUN=true` and review the flagged list first.

## Test

```bash
pytest exchange-rate-overwritten-across-shops/python
node --test exchange-rate-overwritten-across-shops/node
```
