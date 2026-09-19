// An offline copy of the storefront, built from REAL data captured from testallwater.co.uk
// (test/fixtures/store.json). It replays the recorded search results for the queries the code
// uses, emulates search for any other query, and behaves like Shopify Markets: without the
// GB market cookie it answers in another currency, so tests can prove the pin is sent.

import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/store.json", import.meta.url), "utf8"));

export const STORE_ORIGIN = "https://testallwater.co.uk";
export const STORE_HOST = "testallwater.co.uk";
export const fixtureProducts = fixture.products;
export const liveByHandle = fixture.live;
export const productByHandle = Object.fromEntries(fixture.products.map((p) => [p.handle, p]));

const OTHER_CURRENCY_RATE = 379; // PKR, what an unpinned request from Pakistan received

const words = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

function emulateSearch(query) {
  const q = words(query);
  return fixture.products
    .map((p) => {
      const hay = new Set(words(`${p.title} ${p.tags.join(" ")} ${p.body}`));
      return { p, hits: q.filter((w) => hay.has(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10)
    .map((x) => x.p.handle);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// options:
//   currency      what /cart.js reports for a pinned request (default "GBP")
//   failSearch    every search request fails with HTTP 500
//   failLive      every /products/<handle>.js request fails with HTTP 500
//   hang          nothing ever answers (and the abort signal is ignored)
//   liveOverrides { handle: partial .js data } to change stock, variants, price...
//   searchOverrides { handle: partial suggest data } to change titles, tags...
export function createFakeStore(options = {}) {
  const calls = [];

  async function handle(url, init = {}) {
    const u = new URL(url);
    const cookie = init.headers?.Cookie ?? "";
    const pinned = /(?:^|;\s*)localization=GB(?:;|$)/.test(cookie);
    calls.push({ path: u.pathname, query: u.searchParams.get("q"), pinned, cookie, url: String(url) });

    if (options.hang) return new Promise(() => {});

    if (u.pathname === "/cart.js") return json({ currency: pinned ? options.currency ?? "GBP" : "PKR", items: [], item_count: 0 });

    if (u.pathname === "/search/suggest.json") {
      if (options.failSearch) return json({ error: "boom" }, 500);
      const query = u.searchParams.get("q") ?? "";
      const handles = fixture.suggest[query] ?? emulateSearch(query);
      const rate = pinned ? 1 : OTHER_CURRENCY_RATE;
      const results = handles
        .map((h) => productByHandle[h])
        .filter(Boolean)
        .map((p) => {
          const over = options.searchOverrides?.[p.handle] ?? {};
          const price = (Number.parseFloat(p.price) * rate).toFixed(2);
          return {
            available: p.available, body: p.body, handle: p.handle, id: p.id, image: p.image, price,
            price_min: price, price_max: price, tags: [...p.tags, "search_category_best-selling-products"],
            title: p.title, type: p.type, url: `/products/${p.handle}?_pos=1&_psq=x`, variants: [],
            vendor: p.vendor, featured_image: p.featured_image ? { ...p.featured_image, alt: p.title } : null, ...over,
          };
        });
      return json({ resources: { results: { products: results } } });
    }

    const live = /^\/products\/([^/]+)\.js$/.exec(u.pathname);
    if (live) {
      if (options.failLive) return json({ error: "boom" }, 500);
      const data = liveByHandle[live[1]];
      if (!data) return json({ status: "404", description: "Not Found" }, 404);
      const rate = pinned ? 1 : OTHER_CURRENCY_RATE;
      const merged = { ...data, ...(options.liveOverrides?.[live[1]] ?? {}) };
      return json({ ...merged, price_min: Math.round(merged.price_min * rate), variants: merged.variants.map((v) => ({ ...v, price: Math.round(v.price * rate) })) });
    }

    return json({ error: "not found" }, 404);
  }

  return { handle, calls, options };
}

// Routes fetch() by host: the store goes to the fake store, everything else (the language model)
// to llm(url, init).
export function installWorld({ store, llm }) {
  const llmCalls = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).host === STORE_HOST) return store.handle(url, init);
    llmCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return llm(url, init, llmCalls.length);
  };
  return { llmCalls };
}

export const llmReply = (content) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
