// Last line of defence for "never invent products, prices, or links".
//
// The model is told not to name products or quote prices, but a language model can still slip.
// Real products are only ever shown as cards built from Shopify data, so anything the model
// writes about prices, links or specific branded products is removed from its reply here.
// The check works sentence by sentence and keeps the reply's Markdown structure.
//
// Files starting with "_" in /api are helpers, not Vercel functions.

import { STORE_HOST } from "./_catalog.js";

// A money amount: a currency symbol/code next to a number, or a number followed by a currency word.
const PRICE = /(?:[£$€]|\b(?:gbp|usd|eur|pkr|inr|rs\.?)\s?)\s?\d|\d[\d,.]*\s?(?:[£$€]|\b(?:pounds?|gbp|usd|euros?|dollars?)\b)/i;

// A link or a web address.
const URL_LIKE = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co\.uk|net|org|io|store|shop|uk)\b\S*/gi;

// Brands that sell water-test products. A sentence naming one of these next to a product word is
// treated as a product claim, and only allowed when that brand is on a card being shown.
const BRANDS = [
  "lovibond", "palintest", "hanna", "hach", "lamotte", "la motte", "milwaukee", "eutech", "trace2o", "idexx",
  "johnson analytica", "water-i.d", "water-id", "poollab", "test all water", "testallwater", "easy dip", "exact micro",
  "tetra", "jbl", "sera", "salifert", "seachem", "red sea", "nyos", "aquachek", "taylor", "api",
];
const BRAND_RE = new RegExp(`(?:^|[^a-z0-9])(${BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`, "i");
const PRODUCT_WORD = /\b(kits?|strips?|tablets?|testers?|photometers?|meters?|checkers?|reagents?|packs?|model|series|comparators?|dipslides?)\b/i;

const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ");

function isUnverifiedClaim(sentence, shownVendors) {
  if (PRICE.test(sentence)) return true;
  const links = sentence.match(URL_LIKE) ?? [];
  if (links.some((l) => !l.toLowerCase().replace(/^https?:\/\//, "").startsWith(STORE_HOST))) return true;
  const brand = BRAND_RE.exec(sentence)?.[1];
  if (brand && PRODUCT_WORD.test(sentence)) {
    // "API" is only a brand when written in capitals ("the API kit"), not in ordinary text
    if (brand.toLowerCase() === "api" && !/\bAPI\b/.test(sentence)) return false;
    const b = normalize(brand);
    return !shownVendors.some((v) => normalize(v).includes(b) || b.includes(normalize(v)));
  }
  return false;
}

// reply: the model's text. shownProducts: the cards that will be displayed (may be empty).
// Returns the cleaned reply and how many sentences were removed.
export function guardReply(reply, shownProducts = []) {
  const shownVendors = shownProducts.map((p) => p.vendor).filter(Boolean);
  let removed = 0;

  const lines = [];
  for (const line of reply.split("\n")) {
    if (!line.trim()) {
      lines.push(""); // an original blank line stays
      continue;
    }
    const marker = /^(\s*(?:[-*+]|\d+[.)])\s+|\s*#{1,6}\s+|\s*>\s*)?/.exec(line)[0];
    const kept = line
      .slice(marker.length)
      .split(/(?<=[.!?])\s+/)
      .filter((s) => {
        const bad = s.trim() && isUnverifiedClaim(s, shownVendors);
        if (bad) removed++;
        return !bad;
      });
    const text = kept.join(" ").trim();
    // A line that held nothing but claims disappears together with its bullet, leaving no gap.
    if (text) lines.push(`${marker}${text}`);
  }

  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
