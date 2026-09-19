// Tests for the chat page (index.html): Markdown rendering, XSS safety, friendly errors,
// and end-to-end conversation flows. The page script is executed as shipped (in a fake
// DOM), and the flow tests connect it to the real /api/chat handler with a scripted upstream.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import handler from "../api/chat.js";
import { resetCatalogState } from "../api/_catalog.js";
import { createFakeDocument, FakeEl, toHtml, textOf, allElements } from "./fake-dom.js";
import { createFakeStore, installWorld, llmReply, liveByHandle } from "./fake-store.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const renderCode = /\/\*<render>\*\/([\s\S]*?)\/\*<\/render>\*\//.exec(script)[1];
const { renderMarkdown, friendlyError, renderProductCards } = new Function(
  `${renderCode}\nreturn { renderMarkdown, friendlyError, renderProductCards };`
)();

const realFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  process.env.NARA_ROUTER_API_KEY = "test-key";
  process.env.NARA_ROUTER_BASE_URL = "https://router.example/v1";
  process.env.SHOPIFY_CATALOG = "off";
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  mock.restoreAll();
});

// ---------------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------------

function md(text) {
  const root = new FakeEl("div");
  renderMarkdown(text, createFakeDocument(), root);
  return { root, html: root.children.map(toHtml).join("") };
}

test("markdown: **bold** renders as <strong>, with no literal ** left over", () => {
  assert.equal(md("**Test next:** check pH").html, "<p><strong>Test next:</strong> check pH</p>");
  assert.equal(md("__Test next:__ check pH").html, "<p><strong>Test next:</strong> check pH</p>");
});

test("markdown: a real model reply (bold, bullets, paragraphs) renders cleanly", () => {
  const reply =
    "For cloudy chlorine pool water, test:\n\n" +
    "- **Free and total chlorine** — confirms sanitizer level\n" +
    "- **pH and total alkalinity** — checks water balance\n\n" +
    "A **pool liquid test kit** is best.\n\n**One quick question:** Is the pool indoor or outdoor?";
  const { html: out } = md(reply);
  assert.equal(
    out,
    "<p>For cloudy chlorine pool water, test:</p>" +
      "<ul><li><strong>Free and total chlorine</strong> — confirms sanitizer level</li>" +
      "<li><strong>pH and total alkalinity</strong> — checks water balance</li></ul>" +
      "<p>A <strong>pool liquid test kit</strong> is best.</p>" +
      "<p><strong>One quick question:</strong> Is the pool indoor or outdoor?</p>"
  );
  assert.doesNotMatch(out, /\*\*/);
});

test("markdown: italics, snake_case, and lone asterisks", () => {
  assert.equal(md("Use *gentle* and _soft_ words").html, "<p>Use <em>gentle</em> and <em>soft</em> words</p>");
  assert.equal(md("***very*** important").html, "<p><strong><em>very</em></strong> important</p>");
  assert.equal(md("snake_case_name and 2 * 3 * 4").html, "<p>snake_case_name and 2 * 3 * 4</p>");
  assert.equal(md("*a **b** c*").html, "<p><em>a <strong>b</strong> c</em></p>");
});

test("markdown: inline code is literal (no formatting, escaped)", () => {
  assert.equal(md("Run `pH < 7.2` now").html, "<p>Run <code>pH &lt; 7.2</code> now</p>");
  assert.equal(md("`**not bold**`").html, "<p><code>**not bold**</code></p>");
});

test("markdown: backslash-escaped markers show literally (the \\*\\*Test next:\\*\\* case)", () => {
  assert.equal(md("\\*\\*Test next:\\*\\*").html, "<p>**Test next:**</p>");
});

test("markdown: unmatched or unsupported syntax degrades to plain text", () => {
  assert.equal(md("**oops and *this").html, "<p>**oops and *this</p>");
  assert.equal(md("| a | b |\n|---|---|").html, "<p>| a | b |<br>|---|---|</p>");
  assert.equal(md("").html, "");
  assert.equal(md(null).html, "<p>null</p>");
});

test("markdown: bullet, numbered and nested lists", () => {
  assert.equal(md("- a\n- b\n* c").html, "<ul><li>a</li><li>b</li><li>c</li></ul>");
  assert.equal(md("1. one\n2. two").html, "<ol><li>one</li><li>two</li></ol>");
  assert.equal(md("3. x\n4. y").html, '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(
    md("- a\n  - a1\n  - a2\n- b").html,
    "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>"
  );
  assert.equal(md("Start with:\n- x\n- y").html, "<p>Start with:</p><ul><li>x</li><li>y</li></ul>");
  assert.equal(md("- a\n\n- b").html, "<ul><li>a</li><li>b</li></ul>");
});

test("markdown: headings become bold lines, rules, and line breaks", () => {
  assert.equal(md("## Next steps\nDo this").html, "<p><strong>Next steps</strong></p><p>Do this</p>");
  assert.equal(md("a\n\n---\n\nb").html, "<p>a</p><hr><p>b</p>");
  assert.equal(md("line one\nline two").html, "<p>line one<br>line two</p>");
});

test("markdown: fenced code blocks are literal and safe, even when unclosed", () => {
  assert.equal(md("```\n**x** <b>\n```").html, "<pre><code>**x** &lt;b&gt;</code></pre>");
  assert.equal(md("```js\nlet a = 1;\n```\nafter").html, "<pre><code>let a = 1;</code></pre><p>after</p>");
  assert.equal(md("```\ncode").html, "<pre><code>code</code></pre>");
});

test("markdown: only http(s) links become links, always opened safely", () => {
  assert.equal(
    md("See [the guide](https://example.com/a?b=1&c=2) now").html,
    '<p>See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">the guide</a> now</p>'
  );
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.com", "ftp://x.com/a"]) {
    const { html: out, root } = md(`[click](${bad})`);
    assert.ok(!allElements(root).some((e) => e.tag === "a"), `must not link ${bad}`);
    assert.match(out, /click/);
  }
});

const ALLOWED_TAGS = new Set(["div", "p", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "br", "hr"]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "start"]);

test("markdown XSS: hostile model output never becomes markup or unsafe attributes", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "**<img src=x onerror=alert(1)>**",
    "*<svg onload=alert(1)>*",
    "[x](javascript:alert(1))",
    "[<img onerror=1 src=x>](https://a.com)",
    "[a](https://a.com\" onmouseover=\"alert(1))",
    "`<script>alert(1)</script>`",
    "```\n<script>alert(1)</script>\n```",
    '<a href="javascript:alert(1)">x</a>',
    "- <iframe src=javascript:alert(1)>",
    "# <b onclick=alert(1)>x</b>",
    "&lt;b&gt; &amp; &#60;script&#62;",
    "<style>body{display:none}</style>",
    "</p><script>alert(1)</script><p>",
  ];
  for (const payload of payloads) {
    const { root, html: out } = md(payload); // FakeEl throws if innerHTML is ever touched
    for (const el of allElements(root)) {
      assert.ok(ALLOWED_TAGS.has(el.tag), `unexpected <${el.tag}> from: ${payload}`);
      for (const [name, value] of Object.entries(el.attrs)) {
        assert.ok(ALLOWED_ATTRS.has(name), `unexpected attribute ${name} from: ${payload}`);
        if (name === "href") assert.match(value, /^https?:\/\//i);
      }
    }
    // After removing the whitelisted tags we generated, no raw angle bracket may remain:
    // everything from the payload must have been escaped to text.
    const withoutOurTags = out.replace(/<\/?(p|strong|em|code|pre|ul|ol|li|a|br|hr)( [^<>]*)?>/g, "");
    assert.doesNotMatch(withoutOurTags, /[<>]/, `raw markup leaked from: ${payload}`);
  }
});

test("markdown: pathological input renders quickly (no catastrophic backtracking)", () => {
  const inputs = ["*".repeat(4000), "[".repeat(4000), "`".repeat(4000), "_a*".repeat(1500), "- ".repeat(2000), "**a ".repeat(1500), "[a](".repeat(1000)];
  for (const input of inputs) {
    const t0 = Date.now();
    md(input);
    assert.ok(Date.now() - t0 < 1500, `slow on ${input.slice(0, 12)}...`);
  }
});

// ---------------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------------

const TECHNICAL = /HTTP|50\d|429|NaraRouter|Cloudflare|token|tried \d|\d+s each|environment|API key|AbortError|origin/i;

test("friendly errors: clean copy for timeout, busy and everything else (no technical detail)", () => {
  const timeout = friendlyError(Object.assign(new Error("The AI took too long to respond (tried 2 times, 9s each)."), { status: 504, code: "timeout" }));
  const abort = friendlyError(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const busy = friendlyError(Object.assign(new Error("HTTP 429"), { status: 429, code: "rate_limited" }));
  const other = friendlyError(Object.assign(new Error("The AI service returned an error (HTTP 502): Cloudflare origin"), { status: 502, code: "upstream_error" }));
  const unknown = friendlyError(new TypeError("Failed to fetch"));

  assert.equal(timeout, abort);
  assert.match(timeout, /took longer than expected/);
  assert.match(timeout, /send your message again/);
  assert.match(timeout, /conversation is still here/);
  assert.match(busy, /try again in a moment/);
  assert.match(other, /something went wrong/);
  assert.equal(other, unknown);
  for (const message of [timeout, abort, busy, other, unknown]) assert.doesNotMatch(message, TECHNICAL);
});

// ---------------------------------------------------------------------------------
// The page script, run as shipped, in a fake DOM
// ---------------------------------------------------------------------------------

function bootPage(fetchImpl) {
  const doc = createFakeDocument();
  const consoleErrors = [];
  const sandbox = {
    document: doc,
    fetch: fetchImpl,
    AbortController,
    URL, // the product-card link checks use it
    // resolved at call time so mock timers apply
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    requestAnimationFrame: (fn) => fn(),
    console: { error: (...args) => consoleErrors.push(args), log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const el = (id) => doc.getElementById(id);
  const settle = async () => {
    for (let i = 0; i < 300 && el("send").disabled; i++) await flush();
  };
  const submit = (text) => {
    el("input").value = text;
    el("form").onsubmit({ preventDefault() {} });
  };
  return {
    el,
    consoleErrors,
    submit,
    settle,
    async send(text) {
      submit(text);
      await settle();
    },
    isIdle: () => !el("send").disabled && !el("input").disabled && !el("typing").classList.contains("show"),
    rows: () =>
      el("messages").children.map((row) => ({
        role: row.classes.has("user") ? "user" : "assistant",
        bubble: row.children[row.children.length - 1],
      })),
  };
}

// The page's fetch -> the real /api/chat handler.
function apiFetch(_url, init) {
  return new Promise((resolve) => {
    const res = {
      setHeader() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve(new Response(JSON.stringify(payload), { status: this.statusCode ?? 200 }));
      },
    };
    handler({ method: init.method, headers: {}, body: JSON.parse(init.body) }, res);
  });
}

const ok = (content) => ({ body: { choices: [{ message: { content }, finish_reason: "stop" }] } });

// Scripted NaraRouter: what attempt 1, 2, 3... do. The last step repeats.
function scriptUpstream(...steps) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === "stall") {
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
  };
  return { calls };
}

// ---------------------------------------------------------------------------------------------
// Product cards
// ---------------------------------------------------------------------------------------------

const STORE = "https://testallwater.co.uk";
const product = (over = {}) => ({
  id: "8030002643202",
  title: "Palintest Chlorine/pH Pooltester",
  vendor: "Palintest",
  url: `${STORE}/products/palintest-chlorine-ph-pooltester`,
  image: "https://cdn.shopify.com/s/files/1/0574/5511/6439/files/2_b7afde52.jpg?v=1746103500&width=360",
  price: { amount: "18.19", currency: "GBP", display: "£18.19", from: false },
  available: true,
  addToCartUrl: `${STORE}/cart/add?id=43714841051394&quantity=1&return_to=%2Fcart`,
  reason: "Listed for chlorine and pH testing — relevant to cloudy pool water.",
  covers: ["free and total chlorine", "pH"],
  ...over,
});

function cards(list) {
  const root = new FakeEl("div");
  const shown = renderProductCards(list, createFakeDocument(), root);
  return { root, shown, html: root.children.map(toHtml).join("") };
}

test("cards: a product renders image, title, price, stock, reason and both buttons, all as real links", () => {
  const { root, shown } = cards([product()]);
  assert.equal(shown.length, 1);
  const el = allElements(root);
  const byClass = (c) => el.filter((e) => e.classes.has(c));

  assert.equal(root.children[0].tag, "article");
  assert.equal(textOf(byClass("tw-ptitle")[0]), "Palintest Chlorine/pH Pooltester");
  assert.equal(byClass("tw-ptitle")[0].getAttribute("href"), `${STORE}/products/palintest-chlorine-ph-pooltester`);
  assert.equal(textOf(byClass("tw-pprice")[0]), "£18.19");
  assert.equal(textOf(byClass("tw-pstock")[0]), "In stock");
  assert.equal(textOf(byClass("tw-pvendor")[0]), "Palintest");
  assert.match(textOf(byClass("tw-preason")[0]), /^Listed for chlorine and pH testing/);

  const img = el.find((e) => e.tag === "img");
  assert.match(img.getAttribute("src"), /^https:\/\/cdn\.shopify\.com\//);
  assert.equal(img.getAttribute("alt"), "Palintest Chlorine/pH Pooltester");
  assert.equal(img.getAttribute("loading"), "lazy");

  const [view, cart] = byClass("tw-pbtn");
  assert.equal(textOf(view), "View Product");
  assert.equal(view.getAttribute("href"), `${STORE}/products/palintest-chlorine-ph-pooltester`);
  assert.equal(textOf(cart), "Add to Cart");
  assert.equal(cart.getAttribute("href"), `${STORE}/cart/add?id=43714841051394&quantity=1&return_to=%2Fcart`);
  for (const link of el.filter((e) => e.tag === "a")) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  }
});

test("cards: no Add to Cart when the product has options to choose; 'From' price when it varies; no image is honest", () => {
  const html = cards([product({ addToCartUrl: null, price: { amount: "7.84", currency: "GBP", display: "£7.84", from: true }, image: null })]).html;
  assert.doesNotMatch(html, /Add to Cart/);
  assert.match(html, /From £7\.84/);
  assert.match(html, /No image/);
  assert.doesNotMatch(html, /<img/);
});

test("cards: anything that is not verifiably the store's own product is skipped", () => {
  const bad = [
    product({ url: "https://evil.example/products/x" }),
    product({ url: "http://testallwater.co.uk/products/x" }), // not https
    product({ url: `${STORE}/pages/about` }), // not a product page
    product({ url: "javascript:alert(1)" }),
    product({ url: "https://testallwater.co.uk.evil.example/products/x" }),
    product({ price: { display: "$12.99", from: false } }), // wrong currency
    product({ price: { display: "PKR 6,900.00", from: false } }),
    product({ price: { display: "£12.9", from: false } }),
    product({ price: { display: "£12.99 <b>", from: false } }),
    product({ price: null }),
    product({ title: "   " }),
    product({ available: false }),
    null,
    "not an object",
  ];
  const { shown, html } = cards(bad);
  assert.equal(shown.length, 0);
  assert.equal(html, "");
});

test("cards: a bad image or cart link only removes that part, never shows a foreign address", () => {
  const html = cards([
    product({ image: "https://evil.example/a.jpg", addToCartUrl: "https://evil.example/cart/add?id=1" }),
    product({ url: `${STORE}/products/second`, image: "http://cdn.shopify.com/a.jpg", addToCartUrl: `${STORE}/cart/add?id=abc&quantity=1` }),
    product({ url: `${STORE}/products/third`, image: "javascript:alert(1)", addToCartUrl: `${STORE}/checkout?id=1` }),
  ]).html;
  assert.equal((html.match(/<article/g) ?? []).length, 3);
  assert.doesNotMatch(html, /evil\.example|javascript:|http:\/\//);
  assert.doesNotMatch(html, /Add to Cart/);
  assert.equal((html.match(/No image/g) ?? []).length, 3);
});

test("cards: text from the catalog is only ever text (no markup, no innerHTML)", () => {
  const { root, html: out } = cards([
    product({
      title: '<img src=x onerror=alert(1)> Strips <script>alert(2)</script>',
      vendor: '<b onclick="x">Evil</b>',
      reason: '<a href="javascript:alert(3)">click</a>',
    }),
  ]); // FakeEl throws if innerHTML is ever used

  // Only the elements and attributes the renderer itself creates exist...
  const tags = new Set(allElements(root).map((e) => e.tag));
  assert.deepEqual([...tags].sort(), ["a", "article", "div", "img", "p", "span"]);
  const attrs = new Set(allElements(root).flatMap((e) => Object.keys(e.attrs)));
  for (const name of attrs) assert.ok(["role", "aria-label", "href", "target", "rel", "src", "alt", "loading", "width", "height"].includes(name), name);
  for (const a of allElements(root).filter((e) => e.tag === "a")) assert.match(a.getAttribute("href"), /^https:\/\/testallwater\.co\.uk\//);

  // ...and the hostile text is displayed as text: no raw angle bracket survives outside our own tags.
  const withoutOurTags = out.replace(/<\/?(article|a|img|div|span|p)( [^<>]*)?>/g, "");
  assert.doesNotMatch(withoutOurTags, /[<>]/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt; Strips &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("cards: at most three are shown", () => {
  const many = Array.from({ length: 6 }, (_, i) => product({ url: `${STORE}/products/p${i}`, title: `Product ${i}` }));
  assert.equal(cards(many).shown.length, 3);
});

// End to end: the real page script, the real handler, and the fake storefront built from real data.

const poolMessage = "My pool water is cloudy";

async function shopPage(reply = "A few tests will tell us what is going on. See the options below.", storeOptions = {}) {
  delete process.env.SHOPIFY_CATALOG;
  resetCatalogState();
  const store = createFakeStore(storeOptions);
  installWorld({ store, llm: llmReply(reply) });
  return { page: bootPage(apiFetch), store };
}

test("page: a pool question shows the answer bubble and then a separate row of real product cards", async () => {
  const { page } = await shopPage();
  await page.send(poolMessage);

  const rows = page.el("messages").children;
  assert.deepEqual(rows.map((r) => r.className), ["tw-row user", "tw-row assistant", "tw-row assistant tw-products"]);

  // the answer bubble is exactly what it always was: text only, no product markup inside it
  const bubble = rows[1].children[rows[1].children.length - 1];
  assert.equal(textOf(bubble), "A few tests will tell us what is going on. See the options below.");
  assert.equal(allElements(bubble).some((e) => e.tag === "article" || e.classes.has("tw-pcard")), false);

  const list = allElements(rows[2]).filter((e) => e.classes.has("tw-pcard"));
  assert.ok(list.length >= 1 && list.length <= 3, `${list.length} cards`);
  for (const card of list) {
    const title = textOf(allElements(card).find((e) => e.classes.has("tw-ptitle")));
    const href = allElements(card).find((e) => e.classes.has("tw-ptitle")).getAttribute("href");
    const real = liveByHandle[href.split("/products/")[1]];
    assert.ok(real, `${title} is not a real product`);
    assert.equal(title, real.title);
    assert.equal(textOf(allElements(card).find((e) => e.classes.has("tw-pprice"))).replace("From ", ""), `£${(real.price_min / 100).toFixed(2)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    assert.match(href, /^https:\/\/testallwater\.co\.uk\/products\//);
  }
  assert.ok(page.isIdle());
});

test("page: products already shown in this chat are not shown again for the next question", async () => {
  const { page } = await shopPage();
  await page.send(poolMessage);
  const before = page.el("messages").children.filter((r) => r.classes.has("tw-products")).length;
  assert.equal(before, 1);

  await page.send("What test should I buy for my pool?"); // same need, same products
  const after = page.el("messages").children.filter((r) => r.classes.has("tw-products")).length;
  assert.equal(after, 1, "the same three cards must not be repeated");
});

test("page: no matching product shows a clear line in the answer and no card", async () => {
  const { page } = await shopPage("PFAS need a specialist laboratory test.");
  await page.send("Do you sell a kit to test my tap water for PFAS?");
  const rows = page.el("messages").children;
  assert.equal(rows.filter((r) => r.classes.has("tw-products")).length, 0);
  const bubble = rows[1].children[rows[1].children.length - 1];
  assert.match(textOf(bubble), /No matching product found: the TestAllWater catalog doesn't currently list a product for PFAS\./);
  assert.match(toHtml(bubble), /<strong>No matching product found:<\/strong>/);
});

test("page: when the catalog is down the chat still answers and says so, with no cards", async () => {
  const { page } = await shopPage("Let's work out what to test.", { failSearch: true });
  await page.send(poolMessage);
  const rows = page.el("messages").children;
  assert.equal(rows.filter((r) => r.classes.has("tw-products")).length, 0);
  assert.match(textOf(rows[1].children[rows[1].children.length - 1]), /Product options unavailable/);
  assert.ok(page.isIdle());
});

test("page: a bad product from the server is dropped by the page itself, the good ones still show", async () => {
  const good = product();
  const evil = product({ url: "https://evil.example/products/x", title: "Evil" });
  const page = bootPage(async () =>
    new Response(JSON.stringify({ reply: "Here you go.", model: "m", products: [evil, good] }), { status: 200 })
  );
  await page.send("pool test please, my pool is cloudy");
  const cardsShown = allElements(page.el("messages")).filter((e) => e.classes.has("tw-pcard"));
  assert.equal(cardsShown.length, 1);
  assert.doesNotMatch(toHtml(page.el("messages").children.at(-1)), /Evil|evil\.example/);
});

test("page: the customer's own text and the answer bubble are unchanged by the product feature", async () => {
  const { page } = await shopPage("**Test** these:\n\n- Free chlorine\n- pH");
  await page.send(poolMessage);
  const [user, assistant] = page.rows();
  assert.equal(textOf(user.bubble), poolMessage);
  assert.equal(
    assistant.bubble.children.map(toHtml).join(""),
    "<p><strong>Test</strong> these:</p><ul><li>Free chlorine</li><li>pH</li></ul>"
  );
});

test("page: a product card row is a separate element, so it cannot break the bubble layout", () => {
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.match(css, /\.tw-row\.tw-products\{[^}]*padding-left:41px/); // avatar (31) + gap (10): aligns under the bubble
  assert.match(css, /@media\(max-width:760px\)\{[\s\S]*\.tw-row\.tw-products\{padding-left:0\}/);
  // the original bubble rule is untouched
  assert.match(css, /\.tw-bubble\{max-width:min\(720px,78%\);font-size:14px;line-height:1\.68;padding:14px 16px;border-radius:17px;background:#fff;border:1px solid #e3e9ed;box-shadow:0 5px 18px rgba\(25,48,65,\.045\);white-space:pre-wrap\}/);
});

test("page: assistant replies render Markdown; the user's own text stays plain", async () => {
  scriptUpstream(ok("**Test next:**\n\n- Free chlorine\n- pH"));
  const page = bootPage(apiFetch);
  await page.send("my **pool** is <b>cloudy</b>");

  const [user, assistant] = page.rows();
  assert.equal(user.role, "user");
  assert.equal(textOf(user.bubble), "my **pool** is <b>cloudy</b>");
  assert.equal(user.bubble.children.length, 1); // one text node, no markup
  assert.ok(!user.bubble.classes.has("md"));

  assert.ok(assistant.bubble.classes.has("md"));
  assert.equal(
    assistant.bubble.children.map(toHtml).join(""),
    "<p><strong>Test next:</strong></p><ul><li>Free chlorine</li><li>pH</li></ul>"
  );
  assert.doesNotMatch(textOf(assistant.bubble), /\*\*/);
});

test("page: a JSON-shaped model reply reaches the customer as normal formatted text, never as JSON", async () => {
  scriptUpstream(
    ok('{"response":"Thanks, I\'ve got that. Is this a **freshwater** or **saltwater** aquarium?"}'),
    ok(JSON.stringify({ water_type: "aquarium", parameters: ["ammonia", "nitrite"], test_format: "liquid drop kit" })),
    ok('{"messages":[{"role":"user","content":"x"}]}')
  );
  const page = bootPage(apiFetch);

  await page.send("My aquarium fish are gasping at the surface");
  await page.send("It is freshwater and about 60 litres");
  await page.send("Anything else I should check?");

  const [, first, , second, , third] = page.rows();
  assert.equal(textOf(first.bubble), "Thanks, I've got that. Is this a freshwater or saltwater aquarium?");
  assert.match(toHtml(first.bubble), /<strong>freshwater<\/strong>/);
  assert.equal(
    second.bubble.children.map(toHtml).join(""),
    "<ul><li><strong>Water type:</strong> aquarium</li><li><strong>Parameters:</strong> ammonia, nitrite</li><li><strong>Test format:</strong> liquid drop kit</li></ul>"
  );
  // unrenderable JSON becomes the friendly error, not a JSON dump
  assert.match(textOf(third.bubble), /something went wrong/);
  for (const { role, bubble } of page.rows()) if (role === "assistant") assert.doesNotMatch(textOf(bubble), /[{}]|"role"/);
  assert.ok(page.isIdle());
});

test("page: the raw Markdown text (not HTML) is what goes back to the model as history", async () => {
  const upstream = scriptUpstream(ok("**Bold** answer"), ok("second"));
  const page = bootPage(apiFetch);
  await page.send("first question here");
  await page.send("a different follow-up");
  const sent = upstream.calls[1].body.messages;
  assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(sent[2].content, "**Bold** answer");
});

test("E2E duplicate: the same message twice reaches the model flagged as a repeat, and both replies render", async () => {
  const upstream = scriptUpstream(
    ok("**Test** these:\n\n- Free chlorine\n- pH"),
    ok("Got it, I already have that.\n\n**Next question:** what kind of test kit do you have?")
  );
  const page = bootPage(apiFetch);
  const message = "My pool water is cloudy and I use chlorine";
  await page.send(message);
  await page.send(message);

  assert.equal(upstream.calls.length, 2);
  const [first, second] = upstream.calls.map((c) => c.body.messages);
  assert.doesNotMatch(first[0].content, /REPEATED MESSAGE/);
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.match(second[0].content, /REPEATED MESSAGE/);
  assert.equal(second.filter((m) => m.role === "system").length, 1);

  const rows = page.rows();
  assert.deepEqual(rows.map((r) => r.role), ["user", "assistant", "user", "assistant"]);
  assert.match(toHtml(rows[3].bubble), /<strong>Next question:<\/strong>/);
  assert.ok(page.isIdle());
});

test("timeout recovery: after both retries fail the user sees a clean message, and the chat carries on", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const upstream = scriptUpstream("stall", "stall", ok("Chlorine it is. Which test kit do you have?"));
  const page = bootPage(apiFetch);

  page.submit("My pool water is cloudy and I use chlorine");
  await flush();
  mock.timers.tick(9000); // attempt 1 times out
  await flush();
  mock.timers.tick(9000); // attempt 2 times out
  await page.settle();

  assert.equal(upstream.calls.length, 2);
  let rows = page.rows();
  assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
  const errorText = textOf(rows[1].bubble);
  assert.match(errorText, /took longer than expected/);
  assert.match(errorText, /conversation is still here/);
  assert.doesNotMatch(errorText, TECHNICAL);
  assert.ok(page.isIdle(), "thinking state must be cleared");
  assert.ok(page.consoleErrors.length > 0, "technical detail still goes to the console");

  // A different follow-up continues the conversation and keeps the earlier message as context.
  await page.send("It has been green for 3 days");
  const sent = upstream.calls[2].body.messages;
  assert.deepEqual(sent.map((m) => m.role), ["system", "user", "user"]);
  assert.equal(sent[1].content, "My pool water is cloudy and I use chlorine");
  assert.equal(sent[2].content, "It has been green for 3 days");
  assert.doesNotMatch(JSON.stringify(sent), /took longer|conversation is still here/);

  rows = page.rows();
  assert.equal(rows.at(-1).role, "assistant");
  assert.match(textOf(rows.at(-1).bubble), /Chlorine it is/);
  assert.ok(page.isIdle());
});

test("timeout recovery: resending the SAME message after a failure is answered normally, not treated as a repeat", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const upstream = scriptUpstream("stall", "stall", ok("Thanks. Is the pool indoor or outdoor?"));
  const page = bootPage(apiFetch);
  const message = "My pool water is cloudy and I use chlorine";

  page.submit(message);
  await flush();
  mock.timers.tick(9000);
  await flush();
  mock.timers.tick(9000);
  await page.settle();
  assert.ok(page.isIdle());

  await page.send(message); // the user just tries again
  const sent = upstream.calls[2].body.messages;
  assert.deepEqual(sent.map((m) => m.role), ["system", "user"], "the unanswered first copy is collapsed");
  assert.doesNotMatch(sent[0].content, /REPEATED MESSAGE/);
  assert.equal(textOf(page.rows().at(-1).bubble), "Thanks. Is the pool indoor or outdoor?");
});

test("timeout recovery: if the browser's own 30s limit fires, same friendly message and the chat still works", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  scriptUpstream(ok("Back online"));
  let hang = true;
  const page = bootPage((url, init) =>
    hang
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : apiFetch(url, init)
  );

  page.submit("hello there, my pool is cloudy");
  mock.timers.tick(30000);
  await page.settle();
  assert.match(textOf(page.rows()[1].bubble), /took longer than expected/);
  assert.doesNotMatch(textOf(page.rows()[1].bubble), TECHNICAL);
  assert.ok(page.isIdle());

  hang = false;
  await page.send("hello again, still cloudy");
  assert.equal(textOf(page.rows().at(-1).bubble), "Back online");
});

test("errors from the server (busy, upstream failure, bad JSON) show clean copy, details only in the console", async () => {
  const cases = [
    [{ error: "The AI service is busy right now.", code: "rate_limited" }, 429, /try again in a moment/],
    [{ error: "The AI service returned an error (HTTP 502): Cloudflare origin", code: "upstream_error", detail: "x" }, 502, /something went wrong/],
    [{ error: "NARA_ROUTER_API_KEY is not configured in Vercel." }, 500, /something went wrong/],
    [{ error: "The AI took too long to respond (tried 2 times, 9s each).", code: "timeout" }, 504, /took longer than expected/],
  ];
  for (const [payload, status, expected] of cases) {
    const page = bootPage(async () => new Response(JSON.stringify(payload), { status }));
    await page.send("hello there, my pool is cloudy");
    const text = textOf(page.rows().at(-1).bubble);
    assert.match(text, expected);
    assert.doesNotMatch(text, TECHNICAL);
    assert.ok(page.consoleErrors.length > 0);
    assert.ok(page.isIdle());
  }

  const html502 = bootPage(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
  await html502.send("hello there, my pool is cloudy");
  assert.match(textOf(html502.rows().at(-1).bubble), /something went wrong/);
  assert.ok(html502.isIdle());
});
