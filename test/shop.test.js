// Shopify catalog integration: what the customer needs -> REAL catalog products -> product cards.
// Runs offline against test/fake-store.js, which replays data captured from the live store.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../api/chat.js";
import { analyzeNeeds, PARAM_BY_ID } from "../api/_needs.js";
import { findProducts, buildQueries, selectProducts, buildReason, safeImageUrl, safeProductUrl, resetCatalogState, STORE_ORIGIN as CODE_STORE_ORIGIN } from "../api/_catalog.js";
import { guardReply } from "../api/_guard.js";
import { createFakeStore, installWorld, llmReply, fixtureProducts, liveByHandle, productByHandle, STORE_ORIGIN } from "./fake-store.js";

const realFetch = globalThis.fetch;
let logs;

beforeEach(() => {
  process.env.NARA_ROUTER_API_KEY = "test-key";
  process.env.NARA_ROUTER_BASE_URL = "https://router.example/v1";
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  logs = { out: [], err: [] };
  mock.method(console, "log", (line) => logs.out.push(line));
  mock.method(console, "error", (line) => logs.err.push(line));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  mock.restoreAll();
});

const needsFor = (...messages) => analyzeNeeds(messages);
const gbp = (minor) => `£${(minor / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------------------------
// What the customer needs
// ---------------------------------------------------------------------------------------------

test("needs: a cloudy pool means pool checks, and a product search", () => {
  const n = needsFor("My pool water is cloudy");
  assert.equal(n.context, "pool");
  assert.deepEqual(n.parameters, ["chlorine", "ph", "alkalinity", "calcium_hardness", "cyanuric_acid"]);
  assert.equal(n.label, "cloudy pool water");
  assert.equal(n.wantsProducts, true);
});

test("needs: 'what should I buy' with a kind of water is a product request", () => {
  const n = needsFor("What test should I buy for my pool?");
  assert.equal(n.context, "pool");
  assert.equal(n.productIntent, true);
  assert.equal(n.wantsProducts, true);
});

test("needs: fish gasping adds dissolved oxygen to the aquarium checks", () => {
  const n = needsFor("My aquarium fish are gasping at the surface");
  assert.equal(n.context, "aquarium");
  assert.deepEqual(n.parameters.slice(0, 2), ["dissolved_oxygen", "ammonia"]);
  assert.ok(n.parameters.includes("nitrite") && n.parameters.includes("nitrate"));
});

test("needs: drinking water, well water and pond water are recognised", () => {
  assert.equal(needsFor("I want to test my tap water at home").context, "drinking");
  assert.equal(needsFor("Is my well water safe to drink?").context, "well");
  assert.equal(needsFor("My pond water is green").context, "pond");
  const metallic = needsFor("My well water has orange stains and tastes metallic");
  assert.ok(["iron", "copper", "lead"].every((id) => metallic.parameters.includes(id)));
  assert.deepEqual(metallic.explicit, ["iron"]);
});

test("needs: 'well' in ordinary speech is not a water well, and 'lead' is not always lead", () => {
  assert.equal(needsFor("The test strips work well as well").context, null);
  assert.equal(needsFor("This could lead to problems with my pool").explicit.includes("lead"), false);
  assert.equal(needsFor("Is there lead in my tap water?").explicit.includes("lead"), true);
});

test("needs: test values name the parameters and are flagged", () => {
  const n = needsFor("My pool is cloudy. pH is 8.1, free chlorine 0.2 ppm, alkalinity 60 ppm and cyanuric acid 100");
  assert.deepEqual(n.explicit, ["chlorine", "ph", "alkalinity", "cyanuric_acid"]);
  assert.equal(n.hasValues, true);
  assert.equal(needsFor("My pool water is cloudy").hasValues, false);
});

test("needs: an unusual request (PFAS, radon) is searched for on its own, not swapped for the usual checklist", () => {
  const pfas = needsFor("Do you sell a kit to test my tap water for PFAS?");
  assert.deepEqual(pfas.parameters, ["pfas"]);
  assert.equal(pfas.hasRare, true);
  assert.deepEqual(buildQueries(pfas), ["PFAS test"]);
  assert.deepEqual(needsFor("I need a radon test for my well water").parameters, ["radon"]);
});

test("needs: small talk and a bare mention of a pool do not trigger a product search", () => {
  assert.equal(needsFor("hello, how are you?").wantsProducts, false);
  assert.equal(needsFor("I have a swimming pool").wantsProducts, false);
  assert.equal(needsFor("thanks!").wantsProducts, false);
});

test("needs: a change of topic is followed, and the latest message decides the kind of water", () => {
  const n = needsFor("My pool is cloudy", "Actually it is for my fish tank, I want to check ammonia");
  assert.equal(n.context, "aquarium");
  assert.ok(n.explicit.includes("ammonia"));
});

test("needs: refills are only wanted when asked for", () => {
  assert.equal(needsFor("My pool is cloudy").wantsConsumables, false);
  assert.equal(needsFor("I need reagent refills for my pool photometer").wantsConsumables, true);
});

// ---------------------------------------------------------------------------------------------
// Catalog: real products only
// ---------------------------------------------------------------------------------------------

const SCENARIOS = {
  pool: ["My pool water is cloudy"],
  buyForPool: ["What test should I buy for my pool?"],
  aquarium: ["My aquarium fish are gasping at the surface and the water smells odd"],
  drinking: ["I want to test my drinking water at home, is it safe?"],
  well: ["My well water has orange stains and tastes metallic"],
  values: ["My pool is cloudy. pH is 8.1, free chlorine 0.2 ppm, alkalinity 60 ppm and cyanuric acid 100"],
  hotTub: ["My hot tub water is foamy and I use bromine"],
  nitrate: ["where can I buy nitrate test strips"],
  pond: ["my pond water is green and my koi look sick"],
};

async function find(messages, storeOptions = {}) {
  const store = createFakeStore(storeOptions);
  installWorld({ store, llm: llmReply("unused") });
  const needs = analyzeNeeds(messages);
  return { store, needs, result: await findProducts(needs) };
}

test("catalog: every scenario returns 1-3 products that exist in the store, with the store's own data", async () => {
  for (const [name, messages] of Object.entries(SCENARIOS)) {
    resetCatalogState();
    const { result } = await find(messages);
    assert.equal(result.status, "ok", name);
    assert.ok(result.products.length >= 1 && result.products.length <= 3, `${name}: ${result.products.length} products`);

    for (const p of result.products) {
      const handle = p.url.split("/products/")[1];
      const real = productByHandle[handle];
      const live = liveByHandle[handle];
      assert.ok(real && live, `${name}: ${handle} is not in the store`);
      assert.equal(p.url, `${STORE_ORIGIN}/products/${handle}`);
      assert.equal(p.title, live.title, "title comes from the store");
      assert.equal(p.vendor, live.vendor);
      assert.equal(p.price.amount, (live.price_min / 100).toFixed(2), "price comes from the store");
      assert.equal(p.price.currency, "GBP");
      assert.equal(p.price.display, gbp(live.price_min));
      assert.equal(p.id, String(live.id));
      assert.equal(p.available, true);
      assert.ok(p.image === null || /^https:\/\/cdn\.shopify\.com\/.+width=360/.test(p.image), `${name}: bad image ${p.image}`);
    }
  }
});

test("catalog: the market is pinned to the UK on every request (an unpinned request would be in another currency)", async () => {
  const { store, result } = await find(SCENARIOS.pool);
  assert.ok(store.calls.length >= 5);
  assert.ok(store.calls.every((c) => c.pinned), "a request went out without the GB market cookie");
  assert.ok(result.products.every((p) => /^£\d/.test(p.price.display)));

  // and the fake really would have answered in another currency without the pin
  const unpinned = await store.handle(`${STORE_ORIGIN}/products/${result.products[0].url.split("/products/")[1]}.js`, {});
  assert.ok((await unpinned.json()).price_min > liveByHandle[result.products[0].url.split("/products/")[1]].price_min * 100);
});

test("catalog: if the store stops honouring the UK market, no prices are shown (fails closed)", async () => {
  const { store, result } = await find(SCENARIOS.pool, { currency: "PKR" });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.products, []);
  assert.equal(result.meta.currencyMismatch, true);
  assert.deepEqual(store.calls.map((c) => c.path), ["/cart.js"], "nothing else is requested once the currency is wrong");
});

test("catalog: relevant, sensible products for each kind of water (checked against the real listings)", async () => {
  const titles = async (name) => (await find(SCENARIOS[name])).result.products.map((p) => p.title);

  const pool = await titles("pool");
  assert.ok(pool.some((t) => /pool/i.test(t)), `pool: ${pool}`);

  const aquarium = await titles("aquarium");
  assert.ok(aquarium.some((t) => /aquarium/i.test(t)), `aquarium: ${aquarium}`);

  const hotTub = (await find(SCENARIOS.hotTub)).result.products;
  assert.ok(hotTub.some((p) => /hot tub|bromine/i.test(p.title)), "hot tub");

  const nitrate = await titles("nitrate");
  assert.ok(nitrate.every((t) => /nitrate/i.test(t)), `nitrate: ${nitrate}`);

  const well = await titles("well");
  assert.ok(well.every((t) => !/silt density/i.test(t)), "an industrial silt-density kit must not be offered for a well");
});

test("catalog: never offers expired, clearance, opened, refill or accessory listings, or things out of stock", async () => {
  const bad = /expir|clearance|opened|refurb|b[- ]?grade|reagent|refill/i;
  for (const [name, messages] of Object.entries(SCENARIOS)) {
    resetCatalogState();
    const { result } = await find(messages);
    for (const p of result.products) assert.doesNotMatch(p.title, bad, `${name}: ${p.title}`);
  }
  // the fixture really contains such listings, so this test is not vacuous
  assert.ok(fixtureProducts.some((p) => /expir|clearance|opened/i.test(p.title)));
});

test("catalog: the 'why it matches' sentence only lists parameters found in that product's own listing", async () => {
  for (const [name, messages] of Object.entries(SCENARIOS)) {
    resetCatalogState();
    const { result, needs } = await find(messages);
    for (const p of result.products) {
      const real = productByHandle[p.url.split("/products/")[1]];
      const main = `${real.title} ${real.type} ${real.tags.join(" ")}`;
      assert.ok(p.covers.length > 0, `${name}: ${p.title} covers nothing`);
      for (const label of p.covers) {
        const id = Object.keys(PARAM_BY_ID).find((k) => PARAM_BY_ID[k].label === label);
        assert.match(main, PARAM_BY_ID[id].product, `${name}: "${p.title}" is not listed for ${label}`);
      }
      assert.match(p.reason, /^Listed for .+ testing — relevant to .+\.$/);
      assert.ok(needs.parameters.length > 0);
    }
  }
});

test("catalog: no matching product is reported as no_match (PFAS, radon), never a look-alike", async () => {
  for (const message of ["Do you sell a kit to test my tap water for PFAS?", "I need a radon test for my well water"]) {
    resetCatalogState();
    const { result } = await find([message]);
    assert.equal(result.status, "no_match", message);
    assert.deepEqual(result.products, []);
  }
});

test("catalog: no search at all for small talk, or when the catalog is switched off", async () => {
  const hello = await find(["hello, how are you?"]);
  assert.equal(hello.result.status, "skipped");
  assert.equal(hello.store.calls.length, 0);

  process.env.SHOPIFY_CATALOG = "off";
  const off = await find(SCENARIOS.pool);
  assert.equal(off.result.status, "skipped");
  assert.equal(off.store.calls.length, 0);
});

test("catalog: add to cart only when there is nothing to choose (one variant, in stock)", async () => {
  const { result } = await find(SCENARIOS.aquarium);
  for (const p of result.products) {
    const live = liveByHandle[p.url.split("/products/")[1]];
    if (live.variants.length === 1 && live.variants[0].available) {
      assert.equal(p.addToCartUrl, `${STORE_ORIGIN}/cart/add?id=${live.variants[0].id}&quantity=1&return_to=%2Fcart`);
    } else {
      assert.equal(p.addToCartUrl, null, `${p.title} has ${live.variants.length} variants`);
    }
  }
  assert.ok(result.products.some((p) => p.addToCartUrl), "expected at least one cart link");
  assert.ok(result.products.some((p) => p.addToCartUrl === null), "expected a multi-variant product without one");
});

test("catalog: the live product record wins: sold out or removed products are dropped, prices are refreshed", async () => {
  const first = (await find(SCENARIOS.pool)).result.products;
  const target = first[0].url.split("/products/")[1];

  resetCatalogState();
  const soldOut = await find(SCENARIOS.pool, { liveOverrides: { [target]: { available: false } } });
  assert.ok(!soldOut.result.products.some((p) => p.url.endsWith(target)), "a product that sold out must not be shown");

  resetCatalogState();
  const repriced = await find(SCENARIOS.pool, { liveOverrides: { [target]: { price_min: 12345, variants: liveByHandle[target].variants.map((v) => ({ ...v, price: 12345 })) } } });
  assert.equal(repriced.result.products.find((p) => p.url.endsWith(target)).price.display, "£123.45");
});

test("catalog: if the per-product lookup fails, the search data is used and no cart link is offered", async () => {
  const { result } = await find(SCENARIOS.pool, { failLive: true });
  assert.equal(result.status, "ok");
  for (const p of result.products) {
    assert.equal(p.addToCartUrl, null);
    assert.match(p.price.display, /^£\d/);
    assert.equal(p.price.amount, Number.parseFloat(productByHandle[p.url.split("/products/")[1]].price).toFixed(2));
  }
});

test("catalog: an unreachable store is 'unavailable', not an empty result", async () => {
  const failed = await find(SCENARIOS.pool, { failSearch: true });
  assert.equal(failed.result.status, "unavailable");
  assert.deepEqual(failed.result.products, []);
});

test("catalog: a store that never answers gives up after 5s", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  installWorld({ store: createFakeStore({ hang: true }), llm: llmReply("unused") });
  const pending = findProducts(analyzeNeeds(SCENARIOS.pool));
  mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.match(result.meta.error, /timeout/);
});

test("catalog: identical searches are cached for a few minutes", async () => {
  const store = createFakeStore();
  installWorld({ store, llm: llmReply("unused") });
  await findProducts(analyzeNeeds(SCENARIOS.pool));
  const searches = () => store.calls.filter((c) => c.path === "/search/suggest.json").length;
  const first = searches();
  await findProducts(analyzeNeeds(SCENARIOS.buyForPool));
  assert.equal(searches(), first, "the same queries must not hit the store again");
});

test("catalog: link and image helpers refuse anything that is not the store or Shopify's CDN over https", () => {
  assert.equal(safeProductUrl("palintest-chlorine-ph-pooltester"), `${CODE_STORE_ORIGIN}/products/palintest-chlorine-ph-pooltester`);
  for (const bad of ["../admin", "a/b", "A B", "javascript:alert(1)", "", "x?y=1", "https://evil.com"]) assert.equal(safeProductUrl(bad), null, bad);

  assert.equal(
    safeImageUrl("//cdn.shopify.com/s/files/1/0/files/a.jpg?v=1"),
    "https://cdn.shopify.com/s/files/1/0/files/a.jpg?v=1&width=360"
  );
  assert.match(safeImageUrl("https://cdn.shopify.com/a.jpg"), /width=360/);
  for (const bad of ["http://cdn.shopify.com/a.jpg", "https://evil.com/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://cdn.shopify.com.evil.com/a.jpg", null, ""]) {
    assert.equal(safeImageUrl(bad), null, String(bad));
  }
});

// selection rules on hand-made candidates
const cand = (over) => ({
  handle: "x", rank: 0, title: "Pool Test Strips", vendor: "V1", type: "Test Kits", tags: ["Swimming Pools", "Chlorine Test Kits"],
  body: "", available: true, price: 5, image: null, ...over,
});

test("selection: excludes out-of-stock, expired, refills, chemicals, accessories and kits for a different kind of water", () => {
  const needs = analyzeNeeds(["My pool is cloudy"]);
  const bad = [
    cand({ handle: "a", title: "Pool Test Strips Expired 04/26" }),
    cand({ handle: "b", title: "Pool Test Strips", available: false }),
    cand({ handle: "c", title: "Pool Chlorine Photometer Reagent Refill" }),
    cand({ handle: "d", title: "Spa Non Chlorine Shock With Testing Strips" }),
    cand({ handle: "e", title: "Palintest Glass Test Tubes", type: "Accessories" }),
    cand({ handle: "f", title: "Aquarium Chlorine Test Strips", tags: ["Aquariums & Ponds", "Chlorine Test Kits"] }),
    cand({ handle: "g", title: "Chlorine Tablets 5kg", type: "Pool Chemicals", tags: ["Chlorine"] }),
  ];
  assert.deepEqual(selectProducts(bad, needs), []);
  assert.equal(selectProducts([...bad, cand({ handle: "ok" })], needs).length, 1);
});

test("selection: a generic tag is not enough: the title must name the parameter or the kind of water", () => {
  const needs = analyzeNeeds(["My well water has orange stains"]);
  const sdi = cand({ handle: "sdi", title: "Manual Silt Density Index Kit", tags: ["Iron", "Well Water", "Industrial"] });
  const iron = cand({ handle: "iron", title: "Iron Test Strips", tags: ["Iron"] });
  assert.deepEqual(selectProducts([sdi, iron], needs).map((p) => p.handle), ["iron"]);
});

test("selection: at most three, no duplicate titles, at most two per vendor", () => {
  const needs = analyzeNeeds(["My pool is cloudy"]);
  const many = Array.from({ length: 8 }, (_, i) => cand({ handle: `h${i}`, rank: i, title: `Pool Test Kit ${i}`, vendor: i < 5 ? "Same" : `V${i}` }));
  const dup = cand({ handle: "dup", rank: 9, title: "Pool Test Kit 0", vendor: "Other" });
  const picked = selectProducts([...many, dup], needs);
  assert.equal(picked.length, 3);
  assert.ok(picked.filter((p) => p.vendor === "Same").length <= 2);
  assert.equal(new Set(picked.map((p) => p.title)).size, 3);
});

test("selection: together the picks cover different parameters, and simple kits come before instruments", () => {
  const needs = analyzeNeeds(["My aquarium fish are gasping"]);
  const nitrate = cand({ handle: "n1", title: "Aquarium Nitrate Test Strips", tags: ["Aquariums & Ponds", "Nitrate & Nitrite Test Kits"], vendor: "A" });
  const nitrate2 = cand({ handle: "n2", rank: 1, title: "Aquarium Nitrate Nitrite Strips", tags: ["Aquariums & Ponds", "Nitrate & Nitrite Test Kits"], vendor: "B" });
  const ammonia = cand({ handle: "am", rank: 2, title: "Aquarium Ammonia Test Strips", tags: ["Aquariums & Ponds", "Ammonia Test Kits"], vendor: "C" });
  const oxygen = cand({ handle: "do", rank: 3, title: "Aquaculture Photometer Kit for Dissolved Oxygen", tags: ["Aquariums & Ponds"], vendor: "D" });
  const picked = selectProducts([nitrate, nitrate2, ammonia, oxygen], needs).map((p) => p.handle);
  assert.ok(picked.includes("am"), "ammonia must be covered, not just nitrate twice");
  assert.ok(picked.includes("do"), "an instrument is offered when it adds a parameter (dissolved oxygen)");
  assert.equal(picked.length, 3);
});

test("reason: lists only covered parameters (at most four, the customer's own first)", () => {
  const needs = analyzeNeeds(["My pool is cloudy and my ph is 8"]);
  const reason = buildReason(["chlorine", "alkalinity", "ph", "cyanuric_acid", "calcium_hardness"], needs);
  assert.equal(reason, "Listed for pH, chlorine, alkalinity and cyanuric acid testing — relevant to cloudy pool water.");
  assert.equal(buildReason(["nitrate"], analyzeNeeds(["where can I buy nitrate strips"])), "Listed for nitrate testing — relevant to what you asked about.");
});

// ---------------------------------------------------------------------------------------------
// The guard: nothing invented reaches the customer
// ---------------------------------------------------------------------------------------------

test("guard: removes prices, links and unlisted branded products, keeps ordinary advice and Markdown", () => {
  const reply = [
    "Cloudy water usually means low chlorine or a high pH.",
    "The Lovibond Pool Test Kit is only £12.99 today.",
    "Buy it at https://cheap-tests.example/kit now.",
    "**Test next:**",
    "- Free chlorine",
    "- The Hanna checker costs $30 or 25 pounds",
    "- pH",
    "You can also try Tetra test strips.",
    "Retest after 24 hours.",
  ].join("\n");
  const { text, removed } = guardReply(reply, []);
  assert.equal(text, ["Cloudy water usually means low chlorine or a high pH.", "**Test next:**", "- Free chlorine", "- pH", "Retest after 24 hours."].join("\n"));
  assert.equal(removed, 4); // the Lovibond price, the link, the Hanna line, the Tetra line
});

test("guard: a brand is fine when its product is one of the cards being shown; the store's own address is fine", () => {
  const shown = [{ vendor: "Lovibond" }];
  const ok = "The Lovibond kit below covers chlorine. See testallwater.co.uk for more.";
  assert.equal(guardReply(ok, shown).text, ok);
  assert.equal(guardReply("The Palintest kit below covers chlorine.", shown).removed, 1);
  assert.equal(guardReply(ok, []).removed, 1, "with no cards, naming a brand's kit is an unverified claim");
});

test("guard: ordinary numbers and units are not mistaken for prices, and empty input is safe", () => {
  const text = "Keep free chlorine at 1-3 ppm, pH at 7.2-7.8 and alkalinity at 80-120 mg/l. Test 2 times a week.";
  assert.deepEqual(guardReply(text, []), { text, removed: 0 });
  assert.deepEqual(guardReply("", []), { text: "", removed: 0 });
  assert.equal(guardReply("The API is down.", []).removed, 0, "lower-case 'API' is not the aquarium brand");
});

// ---------------------------------------------------------------------------------------------
// Through the chat handler
// ---------------------------------------------------------------------------------------------

function call(messages) {
  const res = {
    headers: {}, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return handler({ method: "POST", headers: {}, body: { messages } }, res).then(() => res);
}
const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

async function chat(messages, { reply = "A few tests will tell us what is going on. See the options below.", ...storeOptions } = {}) {
  const store = createFakeStore(storeOptions);
  const world = installWorld({ store, llm: llmReply(reply) });
  const res = await call(messages);
  return { res, store, world, system: world.llmCalls[0]?.body.messages[0].content ?? "" };
}

test("chat: a pool question returns the model's answer plus real product cards", async () => {
  const { res, world } = await chat([u("My pool water is cloudy")]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.reply, "A few tests will tell us what is going on. See the options below.");
  assert.ok(res.payload.products.length >= 1 && res.payload.products.length <= 3);
  for (const p of res.payload.products) {
    assert.ok(productByHandle[p.url.split("/products/")[1]], `${p.title} must exist in the store`);
    assert.deepEqual(Object.keys(p).sort(), ["addToCartUrl", "available", "covers", "id", "image", "price", "reason", "title", "url", "vendor"]);
  }
  assert.equal(world.llmCalls.length, 1);
});

test("chat: the model is told how many products are shown and what they cover, but never their names, prices or links", async () => {
  const { res, system } = await chat([u("My pool water is cloudy")]);
  assert.match(system, /PRODUCT CONTEXT: The app is showing \d real TestAllWater products? as product cards/);
  assert.match(system, /Tests relevant to this conversation: free and total chlorine, pH/);
  for (const p of res.payload.products) {
    assert.ok(!system.includes(p.title), `system prompt leaks the title "${p.title}"`);
    assert.ok(!system.includes(p.price.display), "system prompt leaks a price");
    assert.ok(!system.includes(p.url), "system prompt leaks a link");
  }
  assert.doesNotMatch(system, /Lovibond|Palintest|Hanna|Test All Water:/);
  assert.match(system, /Never invent, guess or recall product names/);
});

test("chat: whatever the model says about products, prices and links is removed, the advice stays", async () => {
  const reply = "Test pH and free chlorine first.\nThe Lovibond Pool Test Kit costs £12.99 at https://shop.example/x.\nRetest after a day.";
  const { res } = await chat([u("My pool water is cloudy")], { reply });
  assert.equal(res.payload.reply, "Test pH and free chlorine first.\nRetest after a day.");
  assert.equal(JSON.parse(logs.out[0]).guardRemoved, 1);
  assert.doesNotMatch(JSON.stringify(res.payload.reply), /£|https?:/);
});

test("chat: no matching product: the customer is told plainly, no card is shown, and the model is told not to invent one", async () => {
  const { res, system } = await chat([u("Do you sell a kit to test my tap water for PFAS?")], { reply: "PFAS need a specialist laboratory test." });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.products, undefined);
  assert.match(res.payload.reply, /\*\*No matching product found:\*\* the TestAllWater catalog doesn't currently list a product for PFAS\./);
  assert.match(system, /PRODUCT CONTEXT: The TestAllWater catalog has NO product matching: PFAS/);
  assert.match(system, /Do not name, suggest or invent any product/);
});

test("chat: the no-match line is not repeated when the model already said it, however it words it", async () => {
  const said = [
    "I couldn't find a matching product in the catalog for radon, so a lab test is your best route.",
    "No matching PFAS test product was found in the TestAllWater catalog. PFAS needs a laboratory.",
    "There is no suitable kit in the catalog for that.",
    "No matching product was found for radon.",
    "We don't currently stock a radon test.",
  ];
  for (const reply of said) {
    const { res } = await chat([u("I need a radon test for my well water")], { reply });
    assert.equal(res.payload.reply.match(/No matching product found:/g), null, `duplicated after: ${reply}`);
  }
  // ...but it is added when the model says nothing about it
  const { res } = await chat([u("I need a radon test for my well water")], { reply: "Radon in water is measured by a laboratory." });
  assert.match(res.payload.reply, /\*\*No matching product found:\*\*/);
});

test("page CSS: card buttons are a comfortable touch size on phones", () => {
  const css = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(css, /@media\(max-width:760px\)\{[\s\S]*\.tw-pbtn\{flex:1 1 120px;height:42px\}/);
});

test("chat: if the catalog cannot be reached the chat still answers, and says so instead of guessing", async () => {
  const { res, system } = await chat([u("What test should I buy for my pool?")], { failSearch: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.products, undefined);
  assert.match(res.payload.reply, /\*\*Product options unavailable:\*\*/);
  assert.match(system, /product catalog could not be checked/);
  assert.equal(JSON.parse(logs.err[0] ?? logs.out[0]).catalog.status, "unavailable");
});

test("chat: a repeated message does not search or show the products again", async () => {
  const message = "My pool water is cloudy and I use chlorine";
  const { res, store, system } = await chat([u(message), a("Here are some options."), u(message)]);
  assert.equal(store.calls.length, 0);
  assert.equal(res.payload.products, undefined);
  assert.doesNotMatch(system, /PRODUCT CONTEXT:/); // the standing rule mentions the phrase; the note has a colon
  assert.match(system, /REPEATED MESSAGE/);
});

test("chat: small talk makes no store requests and shows no products", async () => {
  const { res, store, system } = await chat([u("hello, how are you?")]);
  assert.equal(store.calls.length, 0);
  assert.equal(res.payload.products, undefined);
  assert.doesNotMatch(system, /PRODUCT CONTEXT:/); // the standing rule mentions the phrase; the note has a colon
});

test("chat: a slow catalog cannot stall the model beyond its own 5s budget", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const store = createFakeStore({ hang: true });
  const world = installWorld({ store, llm: llmReply("Let's work out what to test.") });
  const pending = call([u("My pool water is cloudy")]);
  await new Promise((r) => setImmediate(r));
  mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  const res = await pending;
  assert.equal(res.statusCode, 200);
  assert.equal(world.llmCalls.length, 1, "the model was still asked");
  assert.match(res.payload.reply, /Product options unavailable/);
});

test("chat: the log records what was searched and shown, without any product text", async () => {
  await chat([u("My aquarium fish are gasping at the surface")]);
  const entry = JSON.parse(logs.out[0]);
  assert.equal(entry.catalog.status, "ok");
  assert.ok(entry.catalog.queries >= 3 && entry.catalog.shown >= 1 && entry.catalog.candidates > 0);
  assert.equal(entry.needs.context, "aquarium");
  assert.doesNotMatch(logs.out[0], /Test All Water|Hanna|£/);
});

test("chat: the same customer in the same chat gets the same products for the same need (deterministic)", async () => {
  const one = (await chat([u("My pool water is cloudy")])).res.payload.products.map((p) => p.url);
  resetCatalogState();
  const two = (await chat([u("My pool water is cloudy")])).res.payload.products.map((p) => p.url);
  assert.deepEqual(one, two);
});
