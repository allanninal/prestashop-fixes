# Stock PATCH silently dropped

A PATCH to `/api/stock_availables/{id}` returns 200, but the quantity never changes. PrestaShop's webservice sits behind Apache mod_rewrite and often a reverse proxy or CDN in front of it. A PATCH that does not match the exact expected URL, such as a missing or extra trailing slash, can trigger a 301 or 302 redirect, and most HTTP clients replay that redirect as a GET and drop the request body. The server then returns 200 for a read, not your write, so the stock quantity never actually changes even though nothing errored. This script reads the quantity before the write, sends the PATCH while watching for a redirect and a method change, re-reads immediately after, and only if the write did not persist, falls back to a full PUT with the complete resource body rather than retrying the same PATCH blindly.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/stock-patch-silently-dropped/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python stock-patch-silently-dropped/python/stock_patch_guard.py
node   stock-patch-silently-dropped/node/stock-patch-guard.js
```

`decide_write_status` is a pure function: given the quantity read before the write, the quantity the caller attempted to set, the quantity read immediately after the write, whether the HTTP client followed a redirect, and the HTTP method that actually ran, it returns one of `applied`, `no_op`, `silently_dropped_redirect`, or `silently_dropped_other`. Only a confirmed `silently_dropped_*` verdict triggers a repair, and the repair is always a full PUT with the complete `stock_available` fields, never a repeat of the same PATCH. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest stock-patch-silently-dropped/python
node --test stock-patch-silently-dropped/node
```
