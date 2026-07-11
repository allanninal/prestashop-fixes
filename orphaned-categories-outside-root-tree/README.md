# Orphaned categories outside the root tree

A category or product in PrestaShop can stay active in the database yet be invisible in navigation because its `id_parent` chain no longer resolves back to the shop's root category. This job reads each shop's true root id, pulls every category and active product over the webservice, walks `id_parent` links with a breadth first search from the root, and reports every category and product id that walk never reaches.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/orphaned-categories-outside-root-tree/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python orphaned-categories-outside-root-tree/python/find_orphaned_categories.py
node   orphaned-categories-outside-root-tree/node/find-orphaned-categories.js
```

`find_orphans` is a pure function (categories, root ids, and products are all passed in as plain data): it builds a parent to children adjacency map, walks it with a breadth first search from the shop's root ids, and returns the category ids and product ids that walk never reaches. The only write is a corrective PUT that re-parents an orphaned category root to the shop's Home category, and it only runs when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest orphaned-categories-outside-root-tree/python
node --test orphaned-categories-outside-root-tree/node
```
