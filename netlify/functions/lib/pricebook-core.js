// netlify/functions/lib/pricebook-core.js
//
// Shared logic for the learned price book. Kept in a subfolder (lib/) on
// purpose: Netlify treats top-level files in netlify/functions as endpoints,
// but a helper inside lib/ is only bundled into the functions that require it.
//
// Design rules:
//  - Prices are only RECORDED from documents the user actually exported
//    (see pricebook.js). Raw AI output is never learned from, otherwise one
//    bad parse would teach the book a wrong price.
//  - Stats use the median of recent observations, so a single typo can't
//    drag the "usual price" far.
//  - Everything here is deterministic code (no model calls), so it can be
//    unit-tested and behaves the same every time.

const STORE_NAME = "pricebook";
const BOOK_KEY = "book-v1";
const MAX_OBS_PER_ITEM = 30;     // keep the most recent N observations per item
const STATS_WINDOW = 10;         // "usual price" = median of the latest N
const OUTLIER_RATIO = 5;         // reject a new price >5x or <1/5 of usual (once we have data)
const MIN_OBS_FOR_OUTLIER_CHECK = 5;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ITEMS_PER_WRITE = 50;

/* ---------- name / unit normalisation ---------- */

const STOPWORDS = new Set(["of", "the", "a", "an", "and", "for", "pcs", "pc", "piece", "pieces", "x"]);

function singularWord(w) {
  if (w.length > 3 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("es") && /(ch|sh|x|ss|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/* Standard wire sizes (mm²). People often type just "1.5 wire" or "2.5 cable" — treat that
   bare number as the size in mm so it matches "1.5mm wire". Numbers that describe something
   else ("4 core", "2 way", "3 gang") are left alone. */
const WIRE_SIZES = new Set(["0.75", "1", "1.5", "2.5", "4", "6", "10", "16", "25", "35", "50", "70", "95", "120", "150", "185", "240"]);
const NOT_A_SIZE_WHEN_NEXT = new Set(["core", "way", "gang", "pin", "pair", "phase", "point", "a", "amp"]);

function tokenize(text) {
  let t = String(text || "").toLowerCase();
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*mm|mm2|mm²|mm)\b/g, "$1mm"); // "1.5 sqmm" -> "1.5mm"
  t = t.replace(/(\d+(?:\.\d+)?)\s*amps?\b/g, "$1a");                     // "13 amp" -> "13a"
  t = t.replace(/[^a-z0-9.\s]/g, " ");
  const toks = t
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w === "cable" || w === "cables" || w === "wiring" ? "wire" : w))
    .map(singularWord)
    .filter(w => !STOPWORDS.has(w));
  if (toks.includes("wire")) {
    return toks.map((w, i) =>
      WIRE_SIZES.has(w) && !NOT_A_SIZE_WHEN_NEXT.has(toks[i + 1]) ? w + "mm" : w
    );
  }
  return toks;
}

/* Order-insensitive key so "1.5mm wire", "wire 1.5mm" and "1.5 mm cables" all match. */
function canonKey(name, uom) {
  const toks = Array.from(new Set(tokenize(name))).sort();
  const u = tokenize(uom).join(" ") || "unit";
  if (!toks.length) return null;
  return toks.join(" ") + "|" + u;
}

/* ---------- stats ---------- */

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n) { return Math.round(n * 100) / 100; }

function statsFor(entry) {
  const obs = (entry && entry.obs) || [];
  if (!obs.length) return null;
  const prices = obs.map(o => o.p);
  const recent = prices.slice(-STATS_WINDOW);
  const usual = median(recent);

  // Trend: latest 3 vs the (up to) 5 before them. Needs enough history to mean anything.
  let trend = "flat", trendPct = 0;
  if (prices.length >= 5) {
    const latest = median(prices.slice(-3));
    const before = median(prices.slice(-8, -3));
    if (before) {
      trendPct = round2(((latest - before) / before) * 100);
      if (trendPct >= 5) trend = "up";
      else if (trendPct <= -5) trend = "down";
    }
  } else {
    trend = "new"; // not enough data to call a direction yet
  }
  return {
    usual: round2(usual),
    n: prices.length,
    last: prices[prices.length - 1],
    min: Math.min(...recent),
    max: Math.max(...recent),
    trend,
    trendPct,
    updated: obs[obs.length - 1].t
  };
}

/* ---------- store access (injectable for tests) ---------- */

let storeFactory = null; // tests can replace this
function __setStoreFactory(fn) { storeFactory = fn; }

async function openStore(event) {
  if (storeFactory) return storeFactory(event);
  try {
    // Lambda-compatibility handlers (exports.handler) must call connectLambda first.
    const { connectLambda, getStore } = require("@netlify/blobs");
    connectLambda(event);
    return getStore(STORE_NAME);
  } catch (err) {
    console.warn("[pricebook] Netlify Blobs unavailable:", err && err.message);
    return null; // callers treat a missing store as "no learned prices", never as a fatal error
  }
}

async function loadBook(store) {
  if (!store) return { items: {} };
  try {
    const book = await store.get(BOOK_KEY, { type: "json" });
    return book && book.items ? book : { items: {} };
  } catch (err) {
    console.warn("[pricebook] load failed:", err && err.message);
    return { items: {} };
  }
}

async function saveBook(store, book) {
  await store.setJSON(BOOK_KEY, book);
}

/* ---------- recording ---------- */

function cleanIncoming(raw) {
  const out = [];
  for (const it of (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS_PER_WRITE)) {
    const name = String((it && it.name) || "").trim().slice(0, 80);
    const uom = String((it && it.uom) || "unit").trim().slice(0, 20);
    const price = Number(it && it.price);
    if (!name || !Number.isFinite(price) || price < 1 || price > 1e8) continue;
    const key = canonKey(name, uom);
    if (!key) continue;
    out.push({ key, label: name, uom, price: round2(price) });
  }
  return out;
}

/* Pure function: apply observations to a book, returns {book, accepted, rejected, skipped}. */
function applyObservations(book, incoming, now = Date.now()) {
  const accepted = [], rejected = [], skipped = [];
  for (const inc of incoming) {
    const entry = book.items[inc.key] || { label: inc.label, uom: inc.uom, obs: [] };
    const st = statsFor(entry);

    if (st && st.n >= MIN_OBS_FOR_OUTLIER_CHECK) {
      const ratio = inc.price / st.usual;
      if (ratio > OUTLIER_RATIO || ratio < 1 / OUTLIER_RATIO) {
        rejected.push({ name: inc.label, price: inc.price, usual: st.usual });
        continue;
      }
    }
    const last = entry.obs[entry.obs.length - 1];
    if (last && last.p === inc.price && now - last.t < DEDUPE_WINDOW_MS) {
      skipped.push({ name: inc.label, price: inc.price });
      continue;
    }
    entry.obs.push({ p: inc.price, t: now });
    if (entry.obs.length > MAX_OBS_PER_ITEM) entry.obs = entry.obs.slice(-MAX_OBS_PER_ITEM);
    entry.label = inc.label;        // keep the most recent human-friendly spelling
    entry.uom = inc.uom;
    book.items[inc.key] = entry;
    accepted.push({ name: inc.label, price: inc.price });
  }
  return { book, accepted, rejected, skipped };
}

/* ---------- reading for the parser ---------- */

function listEntries(book) {
  return Object.entries(book.items || {})
    .map(([key, entry]) => ({ key, label: entry.label, uom: entry.uom, ...statsFor(entry) }))
    .filter(e => e.usual != null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* The handful of learned prices relevant to what was typed, so the prompt stays small. */
function relevantEntries(book, text, limit = 25) {
  const words = new Set(tokenize(text));
  if (!words.size) return [];
  return listEntries(book)
    .map(e => {
      const keyTokens = e.key.split("|")[0].split(" ");
      const overlap = keyTokens.filter(t => words.has(t)).length;
      return { e, score: overlap / keyTokens.length, overlap };
    })
    .filter(x => x.overlap > 0)
    .sort((a, b) => b.score - a.score || b.e.n - a.e.n)
    .slice(0, limit)
    .map(x => x.e);
}

/* Best learned/pinned reference for one parsed item. Manual (pinned) prices win. */
function referenceFor(item, entries, manual) {
  const key = canonKey(item.name, item.uom);
  if (!key) return null;
  const pinned = (manual || []).find(p => canonKey(p.name, p.uom || item.uom) === key);
  if (pinned && Number(pinned.price) > 0) return { usual: Number(pinned.price), n: null, source: "pinned" };
  const hit = entries.find(e => e.key === key);
  return hit ? { usual: hit.usual, n: hit.n, source: "learned" } : null;
}

/* ---------- post-processing of the model's answer (deterministic) ---------- */

const naira = n => "₦" + Math.round(n).toLocaleString("en-NG");

/* Turns the model's raw items into what the UI shows:
   - converts "line total" prices into per-unit prices
   - catches a typed total that matches qty × the usual price, and fixes it
   - flags prices wildly off the usual
   - fills in missing prices from the pinned/learned reference
   Anything changed gets confidence "low" + a short human-readable assumption,
   so the row shows the REVIEW badge instead of being silently altered. */
function reconcileItems(rawItems, entries, manual) {
  return rawItems.map(raw => {
    const item = {
      name: String(raw.name || "Item").trim().slice(0, 120) || "Item",
      qty: Number(raw.qty) > 0 ? Number(raw.qty) : 1,
      uom: String(raw.uom || "unit").trim().slice(0, 30) || "unit",
      price: Number(raw.price) > 0 ? Number(raw.price) : 0,
      note: raw.note ? String(raw.note).slice(0, 120) : null,
      confidence: raw.confidence === "low" ? "low" : "high",
      assumption: raw.assumption ? String(raw.assumption).slice(0, 140) : null
    };
    const notes = [];
    if (item.assumption) notes.push(item.assumption);

    if (raw.priceBasis === "line_total" && item.price > 0 && item.qty > 0) {
      const each = round2(item.price / item.qty);
      notes.push(`Read ${naira(item.price)} as the total for ${item.qty}, so ${naira(each)} each`);
      item.price = each;
    }

    const ref = referenceFor(item, entries, manual);
    if (ref && item.price > 0) {
      // A "per unit" price that is really qty × usual: the person typed the line total.
      if (item.qty >= 2 && Math.abs(item.price - ref.usual * item.qty) <= ref.usual * item.qty * 0.08) {
        const each = round2(item.price / item.qty);
        notes.push(`${naira(item.price)} matched ${item.qty} × usual ${naira(ref.usual)} — treated as the total, ${naira(each)} each`);
        item.price = each;
        item.confidence = "low";
      } else {
        const ratio = item.price / ref.usual;
        if (ratio > 3 || ratio < 1 / 3) {
          notes.push(`Usual price is about ${naira(ref.usual)} — this one is very different`);
          item.confidence = "low";
        }
      }
    } else if (ref && item.price === 0) {
      item.price = ref.usual;
      notes.push(`No price typed — used the usual ${naira(ref.usual)}`);
      item.confidence = "low";
    }

    item.assumption = notes.length ? notes.join(". ") : null;
    if (notes.length && raw.priceBasis === "line_total") item.confidence = "low";
    return item;
  });
}

module.exports = {
  tokenize, canonKey, median, statsFor,
  openStore, loadBook, saveBook, __setStoreFactory,
  cleanIncoming, applyObservations,
  listEntries, relevantEntries, referenceFor, reconcileItems,
  constants: { OUTLIER_RATIO, MAX_OBS_PER_ITEM, STATS_WINDOW }
};
