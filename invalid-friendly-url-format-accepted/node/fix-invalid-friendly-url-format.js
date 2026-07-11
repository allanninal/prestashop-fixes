/**
 * Find and safely repair PrestaShop link_rewrite values that are not a valid slug.
 *
 * PrestaShop's webservice layer validates most product fields strictly, but it
 * does not consistently run link_rewrite through Validate::isLinkRewrite() on
 * every write path. Reported bugs, such as GitHub issue #13151, show the API
 * accepting a value like "abc.com" on product creation, because validation runs
 * inconsistently across POST and PUT versus the back-office
 * ObjectModel::validateFields() flow, and the row only starts failing when it
 * is re-saved through the admin form. Separately, Tools::str2url(), meant to
 * slugify a free-text title into a safe link_rewrite, has in some PS8 releases
 * stopped stripping every disallowed character (GitHub issue #38161), so a
 * caller that skips slugification and posts a raw title, a full URL, or
 * Unicode punctuation can land it directly in the link_rewrite column. Because
 * .htaccess rewrite rules and the SEO URL resolver assume link_rewrite is a
 * clean slug, a stored value containing dots, slashes, spaces, or scheme-like
 * text breaks canonical URL generation and can 404 the page even though the
 * row saved fine.
 *
 * This script pulls every product, category, manufacturer, and CMS page
 * link_rewrite per language through the webservice, tests each value against
 * the same regex PrestaShop itself enforces (Validate::isLinkRewrite(), widened
 * for accented characters when PS_ALLOW_ACCENTED_CHARS_URL is on), and reports
 * every value that fails. Repairing is guarded by DRY_RUN, which defaults to
 * true, since a repair changes a public URL. Turn on PrestaShop's own 301
 * redirect preference for changed product URLs before running with
 * DRY_RUN=false.
 *
 * Run on a schedule, or right after any bulk import or webservice write job.
 *
 * Guide: https://www.allanninal.dev/prestashop/invalid-friendly-url-format-accepted/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RESOURCES = ["products", "categories", "manufacturers", "content_management_system"];

const PLAIN = /^[_a-zA-Z0-9-]+$/;
const ACCENTED = /^[_a-zA-Z0-9\-\p{L}\p{S}]+$/u;
const DISALLOWED_CHARS = [" ", ".", "/", ":", "\\"];

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * Mirrors PrestaShop's own Validate::isLinkRewrite(): letters, digits,
 * underscores, and hyphens only, or that same set plus accented word
 * characters when allowAccented is true. Additionally rejects empty strings
 * and any value containing a space, dot, slash, colon, or backslash even when
 * the base regex would otherwise admit it, since none of those characters
 * belong in a slug.
 */
export function isValidSlug(value, allowAccented = false) {
  if (!value || DISALLOWED_CHARS.some((c) => value.includes(c))) return false;
  const pattern = allowAccented ? ACCENTED : PLAIN;
  return pattern.test(value);
}

export function slugify(name) {
  const normalized = (name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const lowered = normalized.toLowerCase();
  const slug = lowered.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, body) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function accentedUrlsAllowed() {
  const data = await apiGet("configurations", { "filter[name]": "PS_ALLOW_ACCENTED_CHARS_URL" });
  const rows = data.configurations || [];
  if (!rows.length) return false;
  return String(rows[0].value ?? "0") === "1";
}

function byLang(entries) {
  if (!Array.isArray(entries)) entries = entries ? [entries] : [];
  const out = {};
  for (const entry of entries) {
    const lang = entry.language || {};
    const idLang = Number(lang["@id"] ?? lang.id ?? 1);
    out[idLang] = entry.value ?? entry["#text"] ?? "";
  }
  return out;
}

function flattenResource(resource, rawItems) {
  const records = [];
  for (const item of rawItems) {
    const slugs = byLang(item.link_rewrite);
    const names = byLang(item.name || item.meta_title);
    for (const [idLangStr, slug] of Object.entries(slugs)) {
      const idLang = Number(idLangStr);
      records.push({
        resource,
        id: Number(item.id),
        id_lang: idLang,
        link_rewrite: slug,
        name: names[idLang] || "",
      });
    }
  }
  return records;
}

async function collectRecords() {
  const all = [];
  for (const resource of RESOURCES) {
    const data = await apiGet(resource, { display: "full", limit: "0" });
    const rawItems = data[resource] || [];
    all.push(...flattenResource(resource, rawItems));
  }
  return all;
}

async function applyRepair(record, candidate) {
  const resource = record.resource;
  const full = await apiGet(`${resource}/${record.id}`);
  const singular = resource === "content_management_system" ? "content_management_system" : resource.slice(0, -1);
  const node = full[singular];
  let entries = node.link_rewrite;
  if (!Array.isArray(entries)) entries = [entries];
  for (const entry of entries) {
    const lang = entry.language || {};
    if (Number(lang["@id"] ?? lang.id ?? 1) === record.id_lang) entry.value = candidate;
  }
  node.link_rewrite = entries;
  await apiPut(`${resource}/${record.id}`, full);

  const confirm = await apiGet(`${resource}/${record.id}`);
  let confirmEntries = confirm[singular].link_rewrite;
  if (!Array.isArray(confirmEntries)) confirmEntries = [confirmEntries];
  for (const entry of confirmEntries) {
    const lang = entry.language || {};
    if (Number(lang["@id"] ?? lang.id ?? 1) === record.id_lang) {
      const stored = entry.value ?? entry["#text"] ?? "";
      if (stored !== candidate) {
        throw new Error(`Repair did not stick for ${resource}/${record.id}: ${stored}`);
      }
    }
  }
}

export async function run() {
  const allowAccented = await accentedUrlsAllowed();
  const records = await collectRecords();

  let fixed = 0;
  for (const record of records) {
    if (isValidSlug(record.link_rewrite, allowAccented)) continue;
    const candidate = slugify(record.name);
    console.warn(
      `Invalid link_rewrite. resource=${record.resource} id=${record.id} id_lang=${record.id_lang} ` +
        `old=${JSON.stringify(record.link_rewrite)} ${DRY_RUN ? "would set" : "setting"} new=${JSON.stringify(candidate)}`
    );
    if (!DRY_RUN) {
      await applyRepair(record, candidate);
      console.log(
        `Fixed ${record.resource}/${record.id}. Confirm the 301 redirect preference is on so old links do not 404.`
      );
    }
    fixed++;
  }
  console.log(`Done. ${fixed} slug(s) ${DRY_RUN ? "to fix" : "fixed"}. DRY_RUN=${DRY_RUN}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
