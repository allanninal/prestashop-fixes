# prestashop-fixes

Small, focused scripts that detect and repair the everyday problems that hit real PrestaShop stores. Every fix ships in **both Python and Node.js**, is **safe by default** (a `DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has a **pure decision function** with unit tests.

Each fix has a full write-up with diagrams on **[allanninal.dev/prestashop](https://www.allanninal.dev/prestashop/)**.

## How the scripts authenticate

The scripts talk to the PrestaShop **Webservice API**. Enable it (Advanced Parameters > Webservice) and create a key:

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
```

The key is sent as the HTTP Basic username (blank password) to `/api/...` resources.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
