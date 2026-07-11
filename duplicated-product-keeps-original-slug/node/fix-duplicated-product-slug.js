/**
 * Find and safely fix PrestaShop products whose friendly URL was copied
 * verbatim from the product they were duplicated from.
 *
 * PrestaShop's Duplicate action, backed by ObjectModel::duplicateObject()
 * and Product::duplicate(), clones the source product's rows with a raw
 * INSERT ... SELECT copy, including every ps_product_lang row, then only
 * rewrites id_product and a few flags such as active. The friendly URL slug
 * in link_rewrite is only ever regenerated from the product name inside
 * AdminProductsController's form-save path, using Tools::link_rewrite() or
 * str2url(), triggered when the Name field is actually edited and saved.
 * The duplication flow never runs that path, so the clone keeps the
 * identical link_rewrite as the original in every language. Because the
 * product URL is unique on id_product plus link_rewrite together, not on
 * link_rewrite alone, no SQL error is raised: both products stay reachable,
 * and the collision only shows up as visually identical URLs, canonical
 * confusion, and duplicate content signals to search engines.
 *
 * This script detects every collision, keeps the earliest product in each
 * group (by date_add) as the canonical original, and proposes a
 * deterministic new slug for every later duplicate. It skips any duplicate
 * whose name has diverged significantly from the original, since that
 * usually means a human already turned the copy into its own product and
 * just never touched its slug, a case that should be flagged for a human to
 * rename from the SEO tab instead of guessed automatically. Writing is
 * guarded by DRY_RUN, which defaults to true, since a rename changes a
 * public URL.
 *
 * Run after any bulk duplication session, or on a nightly schedule.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicated-product-keeps-original-slug/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * products is an array of {id, link_rewrite, name, date_add} already
 * resolved to a single language (idLang is kept only for readability/logging
 * at the call site). Groups records by link_rewrite; any group with more
 * than one member is a collision. The earliest member by date_add (falling
 * back to id) is kept unchanged, and every other member gets
 * new_slug = `${old_slug}-${id}`, extended with a "-dup" suffix if that
 * candidate still collides with any other slug already present in the full
 * product set, including another group's own repair. Returns only the
 * changed entries.
 */
export function suffixDuplicateSlugs(products, idLang) {
  const groups = new Map();
  for (const p of products) {
    if (!groups.has(p.link_rewrite)) groups.set(p.link_rewrite, []);
    groups.get(p.link_rewrite).push(p);
  }

  const allSlugs = new Set(products.map((p) => p.link_rewrite));
  const changes = [];
  for (const [slug, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => {
      const da = a.date_add || "";
      const db = b.date_add || "";
      if (da !== db) return da < db ? -1 : 1;
      return a.id - b.id;
    });
    for (const p of ordered.slice(1)) {
      let candidate = `${slug}-${p.id}`;
      while (allSlugs.has(candidate)) candidate = `${candidate}-dup`;
      allSlugs.add(candidate);
      changes.push({ id: p.id, old_slug: slug, new_slug: candidate });
    }
  }
  return changes;
}

/**
 * True when the duplicate's name no longer resembles the original's,
 * meaning the slug should only be flagged for a human, never auto-fixed.
 */
export function namesDiverged(originalName, duplicateName) {
  const a = (originalName || "").trim().toLowerCase();
  const b = (duplicateName || "").trim().toLowerCase();
  if (!a || !b) return true;
  return !a.includes(b) && !b.includes(a);
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

function entries(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function langId(entry) {
  const lang = entry.language || {};
  const attrs = lang["@attributes"] || lang;
  return Number(attrs.id ?? 1);
}

async function allProducts() {
  const data = await apiGet("products", {
    display: "[id,id_default_image,link_rewrite,name,date_add]",
    limit: "0",
  });
  return data.products || [];
}

function flattenByLang(rawProducts) {
  const byLang = {};
  for (const item of rawProducts) {
    const slugEntries = new Map(entries(item.link_rewrite).map((e) => [langId(e), e["#text"] || ""]));
    const nameEntries = new Map(entries(item.name).map((e) => [langId(e), e["#text"] || ""]));
    for (const [idLang, slug] of slugEntries) {
      if (!byLang[idLang]) byLang[idLang] = [];
      byLang[idLang].push({
        id: Number(item.id),
        link_rewrite: slug,
        name: nameEntries.get(idLang) || "",
        date_add: item.date_add || "",
      });
    }
  }
  return byLang;
}

async function applyRename(productId, newSlug, idLang) {
  const full = await apiGet(`products/${productId}`);
  const node = full.product;
  let entries2 = node.link_rewrite;
  if (!Array.isArray(entries2)) entries2 = [entries2];
  for (const entry of entries2) {
    const lang = entry.language || {};
    const attrs = lang["@attributes"] || lang;
    if (Number(attrs.id ?? 1) === idLang) entry["#text"] = newSlug;
  }
  node.link_rewrite = entries2;
  const url = new URL(`${PRESTASHOP_URL}/api/products/${productId}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(full),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT products/${productId}`);
}

export async function run() {
  const rawProducts = await allProducts();
  const byLang = flattenByLang(rawProducts);

  let fixed = 0;
  let flagged = 0;
  for (const [idLangKey, products] of Object.entries(byLang)) {
    const idLang = Number(idLangKey);
    const byProductId = new Map(products.map((p) => [p.id, p]));
    const changes = suffixDuplicateSlugs(products, idLang);
    for (const change of changes) {
      const dup = byProductId.get(change.id);
      const originalGroup = products.filter((p) => p.link_rewrite === change.old_slug);
      const original = originalGroup.reduce((best, p) => {
        const bd = best.date_add || "";
        const pd = p.date_add || "";
        if (pd !== bd) return pd < bd ? p : best;
        return p.id < best.id ? p : best;
      });
      if (namesDiverged(original.name, dup.name)) {
        console.warn(
          `id_lang=${idLang} id=${change.id} old_slug=${change.old_slug} name=${JSON.stringify(dup.name)} ` +
            `diverged from original name=${JSON.stringify(original.name)}. Flagging for a human.`
        );
        flagged++;
        continue;
      }
      console.warn(
        `id_lang=${idLang} id=${change.id} old_slug=${change.old_slug} ` +
          `${DRY_RUN ? "would rename to" : "renaming to"} new_slug=${change.new_slug}`
      );
      if (!DRY_RUN) await applyRename(change.id, change.new_slug, idLang);
      fixed++;
    }
  }
  console.log(`Done. ${fixed} slug(s) ${DRY_RUN ? "to rename" : "renamed"}, ${flagged} flagged for a human. DRY_RUN=${DRY_RUN}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
