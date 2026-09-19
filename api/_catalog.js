// Live access to the REAL TestAllWater Shopify catalog (https://testallwater.co.uk).
//
// Safest option for this prototype: the store's PUBLIC, read-only storefront endpoints.
// No API keys or tokens exist anywhere in this project, and what we read is exactly what
// a customer sees. The catalog has ~4,200 products, so nothing is bulk-downloaded: each
// conversation runs a few live searches, filters the results against each product's OWN
// title/tags, and re-reads only the (at most three) winners from /products/<handle>.js.
//
// Every value shown on a product card (title, price, image, URL, stock, cart link) comes from
// Shopify. The only text we write ourselves is the "why it matches" sentence, and it is built
// only from parameters we verified in that product's own listing.
//
// Files starting with "_" in /api are helpers, not Vercel functions.

import { PARAM_BY_ID, parameterLabels } from "./_needs.js";

export const STORE_ORIGIN = (process.env.SHOPIFY_STORE_ORIGIN || "https://testallwater.co.uk").replace(/\/+$/, "");
export const STORE_HOST = new URL(STORE_ORIGIN).host;
const IMAGE_HOSTS = new Set(["cdn.shopify.com", STORE_HOST]);

// The store sells in several currencies (Shopify Markets) and picks one from the visitor's
// country, so the same product is GBP 18.19 or PKR 6,900 depending on where the request comes
// from. Every request pins the UK market, and the currency is verified before any price is used.
const MARKET_COOKIE = "localization=GB";
const CURRENCY = "GBP";

const SEARCH_TTL_MS = 10 * 60 * 1000;
const CURRENCY_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const TOTAL_TIMEOUT_MS = 5000; // + 2 x 9s model attempts stays inside the browser's 30s limit
const MAX_QUERIES = 6;
const MAX_PRODUCTS = 3;
const MAX_PER_VENDOR = 2;
const MIN_SCORE = 3; // relevance is already enforced by the title/context rules in scoreCandidate

const searchCache = new Map();
let currencyOkAt = 0;

export function resetCatalogState() {
  searchCache.clear();
  currencyOkAt = 0;
}

// --- Store requests -------------------------------------------------------------------

async function storeGet(path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(`${STORE_ORIGIN}${path}`, {
    headers: { Cookie: MARKET_COOKIE, Accept: "application/json", "User-Agent": "TestAllWater-Assistant/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`store HTTP ${response.status} for ${path.split("?")[0]}`);
  return response.json();
}

async function currencyIsGbp() {
  if (Date.now() - currencyOkAt < CURRENCY_TTL_MS) return true;
  const cart = await storeGet("/cart.js");
  if (cart?.currency !== CURRENCY) return false;
  currencyOkAt = Date.now();
  return true;
}

// --- Text helpers -----------------------------------------------------------------------

const stripHtml = (html) =>
  String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&amp;|&quot;|&#39;|&lt;|&gt;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const clean = (text, max) => String(text ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const normalizeTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const HANDLE = /^[a-z0-9][a-z0-9_-]*$/;

// --- Searching --------------------------------------------------------------------------

const CONTEXT_QUERIES = {
  pool: ["pool test kit", "swimming pool water test"],
  spa: ["hot tub test", "spa test strips"],
  aquarium: ["aquarium test kit", "aquarium test strips"],
  pond: ["pond water test", "aquarium and pond test"],
  well: ["well water test", "drinking water test strips"],
  drinking: ["drinking water test kit", "home water test"],
};

const QUERY_TERM = {
  chlorine: "chlorine", ph: "pH", alkalinity: "alkalinity", calcium_hardness: "calcium hardness", hardness: "water hardness",
  cyanuric_acid: "cyanuric acid", bromine: "bromine", ammonia: "ammonia", nitrite: "nitrite", nitrate: "nitrate",
  phosphate: "phosphate", iron: "iron", copper: "copper", dissolved_oxygen: "dissolved oxygen", salinity: "salinity",
  tds: "TDS", turbidity: "turbidity", lead: "lead", arsenic: "arsenic", fluoride: "fluoride", chloride: "chloride",
  coliform: "coliform bacteria", pfas: "PFAS", radon: "radon", uranium: "uranium", mercury: "mercury", cadmium: "cadmium",
  pesticides: "pesticide", microplastics: "microplastic",
};

// In priority order: what the customer named, then what their symptoms imply, then the rest of
// the checklist for their kind of water. Broad "kit for this water" searches come first because
// they find multi-parameter kits; per-parameter searches fill the gaps (e.g. an ammonia strip).
export function buildQueries(needs) {
  const queries = [];
  const broad = needs.context && !needs.hasRare;
  if (broad) queries.push(...CONTEXT_QUERIES[needs.context]);
  const term = (id) => `${QUERY_TERM[id]} test`;
  for (const id of needs.explicit.slice(0, 2)) queries.push(term(id));
  for (const id of (needs.symptomParams ?? []).slice(0, 2)) queries.push(term(id));
  if (broad) {
    queries.push(`${needs.parameters.slice(0, 3).map((id) => QUERY_TERM[id]).join(" ")} test kit`);
    for (const id of needs.parameters) queries.push(term(id));
  } else if (!queries.length) {
    for (const id of needs.parameters.slice(0, 3)) queries.push(term(id));
  }
  return [...new Set(queries)].slice(0, MAX_QUERIES);
}

function normalizeCandidate(raw, rank) {
  const handle = String(raw?.handle ?? "");
  if (!HANDLE.test(handle)) return null;
  const price = Number.parseFloat(raw.price);
  if (!raw.title || !Number.isFinite(price) || price <= 0) return null;
  const tags = (Array.isArray(raw.tags) ? raw.tags : []).map(String).filter((t) => !t.startsWith("search_category_"));
  return {
    handle,
    rank,
    title: clean(raw.title, 200),
    vendor: clean(raw.vendor, 80),
    type: clean(raw.type, 80),
    tags,
    body: stripHtml(raw.body).slice(0, 1200),
    available: raw.available === true,
    price,
    image: raw.featured_image?.url || raw.image || null,
  };
}

async function searchStore(query) {
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.results;
  const path =
    `/search/suggest.json?q=${encodeURIComponent(query)}&resources%5Btype%5D=product&resources%5Blimit%5D=10` +
    `&resources%5Boptions%5D%5Bunavailable_products%5D=last`;
  const data = await storeGet(path);
  const results = (data?.resources?.results?.products ?? []).map((raw, i) => normalizeCandidate(raw, i)).filter(Boolean);
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(query, { at: Date.now(), results });
  return results;
}

// --- Relevance ----------------------------------------------------------------------------

const EXCLUDE_TEXT = /expir|clearance|discontinued|end of line|\bused\b|damaged|refurb|\bdemo\b|\bopened\b|\bb[- ]?grade\b|\bex[- ]?demo\b|\breturned?\b/i;
const NOT_A_TEST = /\b(shock|granules?|sanit[iz]er|clarifier|algaecide|conditioner|balancer|floc|descaler)\b/i;
const ACCESSORY_TYPE = /accessor/i;
const ACCESSORY_TITLE = /\b(tubes?|cuvettes?|vials?|cables?|chargers?|batter(?:y|ies)|adapters?|holders?|stands?|pipettes?|beakers?|syringes?)\b/i;
const IS_TEST = /test|tester|kit|strip|photometer|colou?rimeter|checker|comparator|analy[sz]er|meter|reagent|dipslide|probe|sensor/i;
const KIT_FORM = /\bkits?\b|strips?|tester|comparator|dipslides?|pooltest/i;
const INSTRUMENT_FORM = /photometer|colou?rimeter|checker|\bmeter\b|analy[sz]er|probe|sensor/i;
const CONSUMABLE_FORM = /reagent|refill|replacement|tablets?\b|rapid dissolve/i;

// Which kind of water a listing explicitly targets. Pool/spa are one family, as are
// aquarium/pond and well/drinking, so a pool kit is never suggested for a fish tank.
const FAMILY = { pool: "pool", spa: "pool", aquarium: "aquatic", pond: "aquatic", well: "supply", drinking: "supply" };
const FAMILY_TEXT = {
  pool: /\bpools?\b|pooltest|swimming|hot ?tub|\bspa\b/i,
  aquatic: /aquari|marine|\breef\b|\bfish|\bponds?\b|aquaculture|\bkoi\b/i,
  supply: /drinking|potable|tap water|home water|household|\bwell water\b|borehole|private water/i,
};

const SHORT = {
  chlorine: "chlorine", alkalinity: "alkalinity", cyanuric_acid: "cyanuric acid", coliform: "bacteria",
  tds: "TDS", hardness: "hardness", calcium_hardness: "calcium hardness",
};
const shortLabel = (id) => SHORT[id] ?? PARAM_BY_ID[id].label;

const mainText = (c) => `${c.title} ${c.type} ${c.tags.join(" ")}`;

// Returns null when a product must not be shown, otherwise how well it fits and why.
export function scoreCandidate(c, needs) {
  if (!c.available) return null;
  const main = mainText(c);
  if (EXCLUDE_TEXT.test(main) || NOT_A_TEST.test(c.title) || ACCESSORY_TYPE.test(c.type) || ACCESSORY_TITLE.test(c.title)) return null;
  if (!IS_TEST.test(main)) return null;
  // A refill for someone else's instrument is not a test a customer can use on its own. Judged by
  // the title: tags such as "Test Kits" are attached to reagents too.
  if (CONSUMABLE_FORM.test(c.title) && !KIT_FORM.test(c.title) && !needs.wantsConsumables) return null;

  // Only what the listing itself says counts as "covers" (title, type, tags), never the search rank.
  const covered = needs.parameters.filter((id) => PARAM_BY_ID[id].product.test(main));
  if (!covered.length) return null;

  let ctxBonus = 0;
  let ctxInTitle = false;
  if (needs.context) {
    const wanted = FAMILY[needs.context];
    const targets = Object.keys(FAMILY_TEXT).filter((f) => FAMILY_TEXT[f].test(main));
    if (targets.length && !targets.includes(wanted)) return null; // built for a different kind of water
    if (targets.includes(wanted)) ctxBonus = 3;
    ctxInTitle = FAMILY_TEXT[wanted].test(`${c.title} ${c.type}`);
  }

  // A generic tag is not enough (an industrial "silt density" kit is tagged with "iron"):
  // the title must name a needed parameter, or the title itself must target this kind of water.
  const titleCovers = needs.parameters.some((id) => PARAM_BY_ID[id].product.test(`${c.title} ${c.type}`));
  if (!titleCovers && !ctxInTitle) return null;

  // What the customer named counts most, what their symptoms imply next, then the usual checklist.
  const explicitCovered = covered.filter((id) => needs.explicit.includes(id)).length;
  const symptomCovered = covered.filter((id) => !needs.explicit.includes(id) && (needs.symptomParams ?? []).includes(id)).length;
  const defaultCovered = covered.length - explicitCovered - symptomCovered;
  const kind = CONSUMABLE_FORM.test(main) && !KIT_FORM.test(main) ? -2 : KIT_FORM.test(main) ? 2 : INSTRUMENT_FORM.test(main) ? 1 : 0;
  const bodyBonus = needs.parameters.filter((id) => !covered.includes(id) && PARAM_BY_ID[id].product.test(c.body)).length * 0.5;

  const score = explicitCovered * 4 + symptomCovered * 3 + defaultCovered * 2 + ctxBonus + kind + bodyBonus;
  const instrument = INSTRUMENT_FORM.test(main);
  return score >= MIN_SCORE ? { score, covered, ctx: ctxBonus > 0, instrument } : null;
}

export function selectProducts(candidates, needs) {
  const scored = candidates
    .map((c) => ({ c, s: scoreCandidate(c, needs) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s.score - a.s.score || a.c.rank - b.c.rank);

  // Drop duplicate titles, keeping the store's relevance order.
  const seenTitles = new Set();
  const pool = [];
  for (const { c, s } of scored) {
    const key = normalizeTitle(c.title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    pool.push({ ...c, covered: s.covered, ctx: s.ctx, score: s.score, instrument: s.instrument });
  }

  // Greedy coverage: each pick is the product that adds the most parameters not yet covered by
  // the ones already chosen (so an ammonia strip follows a nitrate strip, instead of three
  // near-duplicates), then relevance score, then the store's own search order.
  //
  // Simple kits and strips come first. A lab instrument is only offered when it adds a parameter
  // the simple ones cannot (e.g. dissolved oxygen for gasping fish), or when there are too few
  // simple options. Nothing is labelled "best" or ranked in any way the customer can see.
  const covered = new Set();
  const perVendor = new Map();
  const chosen = [];
  const gain = (p) => p.covered.filter((id) => !covered.has(id)).length;
  const pick = (list) => {
    const options = list.filter((p) => !chosen.includes(p) && (perVendor.get(p.vendor) ?? 0) < MAX_PER_VENDOR);
    options.sort((a, b) => gain(b) - gain(a) || b.score - a.score || a.rank - b.rank);
    const best = options[0];
    if (!best) return null;
    chosen.push(best);
    perVendor.set(best.vendor, (perVendor.get(best.vendor) ?? 0) + 1);
    best.covered.forEach((id) => covered.add(id));
    return best;
  };

  const simple = pool.filter((p) => !p.instrument);
  const instruments = pool.filter((p) => p.instrument);
  while (chosen.length < MAX_PRODUCTS - 1 && pick(simple)) {
    // fill all but the last slot with simple kits
  }
  const last = instruments.filter((p) => gain(p) > 0);
  if (!pick(simple.filter((p) => gain(p) > 0)) && !pick(last)) {
    // nothing adds a new parameter: any remaining simple kit, then any instrument
    pick(simple) || pick(instruments);
  }
  return chosen;
}

function joinList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// The only sentence we write: it lists parameters verified in the product's own listing.
export function buildReason(covered, needs) {
  const ordered = [...covered.filter((id) => needs.explicit.includes(id)), ...covered.filter((id) => !needs.explicit.includes(id))];
  const list = joinList(ordered.slice(0, 4).map(shortLabel));
  const why = needs.label ? `relevant to ${needs.label}` : "relevant to what you asked about";
  return `Listed for ${list} testing — ${why}.`;
}

// --- Final card data (validated) ---------------------------------------------------------

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: CURRENCY });

export function safeProductUrl(handle) {
  return HANDLE.test(handle) ? `${STORE_ORIGIN}/products/${handle}` : null;
}

export function safeImageUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(String(raw).startsWith("//") ? `https:${raw}` : String(raw));
    if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.host)) return null;
    url.searchParams.set("width", "360"); // the originals are ~1900px; cards are ~90px
    return url.toString();
  } catch {
    return null;
  }
}

async function hydrate(candidate, needs) {
  let live = null;
  try {
    live = await storeGet(`/products/${candidate.handle}.js`);
  } catch {
    live = null; // fall back to the search data (still real, at most a few minutes old)
  }
  if (live && (live.handle !== candidate.handle || live.available === false)) return null; // gone or sold out

  const variants = Array.isArray(live?.variants) ? live.variants : [];
  const amount = live ? live.price_min / 100 : candidate.price;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const varies = Boolean(live?.price_varies);

  // "Add to cart" only when there is nothing to choose: exactly one variant, in stock.
  const only = variants.length === 1 && variants[0].available === true && Number.isInteger(variants[0].id) ? variants[0] : null;

  return {
    id: String(live?.id ?? ""),
    title: clean(live?.title ?? candidate.title, 200),
    vendor: clean(live?.vendor ?? candidate.vendor, 80),
    url: safeProductUrl(candidate.handle),
    image: safeImageUrl(live?.featured_image ?? candidate.image),
    price: { amount: amount.toFixed(2), currency: CURRENCY, display: money.format(amount), from: varies },
    available: true,
    addToCartUrl: only ? `${STORE_ORIGIN}/cart/add?id=${only.id}&quantity=1&return_to=%2Fcart` : null,
    reason: buildReason(candidate.covered, needs),
    covers: parameterLabels(candidate.covered),
  };
}

// --- Public entry point -------------------------------------------------------------------

// Returns { status, products, meta } where status is:
//   "ok"          real products found
//   "no_match"    the catalog was searched and nothing relevant exists
//   "unavailable" the store could not be reached (or its currency could not be verified)
//   "skipped"     nothing to search for, or the catalog is switched off
export async function findProducts(needs) {
  if (process.env.SHOPIFY_CATALOG === "off" || !needs?.wantsProducts) return { status: "skipped", products: [], meta: {} };

  const started = Date.now();
  const meta = { queries: 0, candidates: 0, qualified: 0 };

  const work = (async () => {
    if (!(await currencyIsGbp())) {
      meta.currencyMismatch = true;
      return { status: "unavailable", products: [], meta };
    }
    const queries = buildQueries(needs);
    meta.queries = queries.length;
    const settled = await Promise.allSettled(queries.map(searchStore));
    if (queries.length && settled.every((r) => r.status === "rejected")) {
      meta.error = String(settled[0].reason?.message ?? "search failed").slice(0, 120);
      return { status: "unavailable", products: [], meta };
    }

    // Merge, keeping the store's own order (query by query) as the tie-breaker.
    const byHandle = new Map();
    let rank = 0;
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const c of r.value) if (!byHandle.has(c.handle)) byHandle.set(c.handle, { ...c, rank: rank++ });
    }
    meta.candidates = byHandle.size;

    const chosen = selectProducts([...byHandle.values()], needs);
    meta.qualified = chosen.length;
    const cards = (await Promise.all(chosen.map((c) => hydrate(c, needs)))).filter((p) => p && p.url);
    return { status: cards.length ? "ok" : "no_match", products: cards, meta };
  })();

  let timer;
  try {
    const result = await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("catalog timeout")), TOTAL_TIMEOUT_MS);
      }),
    ]);
    result.meta.ms = Date.now() - started;
    return result;
  } catch (error) {
    return { status: "unavailable", products: [], meta: { ...meta, error: String(error?.message ?? error).slice(0, 120), ms: Date.now() - started } };
  } finally {
    clearTimeout(timer);
  }
}
