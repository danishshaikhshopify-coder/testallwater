const DEFAULT_BASE_URL = "https://router.bynara.id/v1";
// Zero-cost model on NaraRouter's Free plan (GET https://router.bynara.id/api/plans).
// It is a reasoning model, so it gets extra token and time headroom below.
const MODEL = "nemotron-3.5-lightning-free";

// Must finish inside maxDuration (60s, see vercel.json) and before the browser
// gives up (58s, see index.html).
const MODEL_TIMEOUT_MS = 50000;
// Reasoning tokens count toward max_tokens; too low a cap leaves no room for the answer.
const MAX_OUTPUT_TOKENS = 2000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;

// The system prompt lives on the server so clients cannot replace it and use
// this endpoint as a free general-purpose LLM proxy.
const SYSTEM_PROMPT = `
You are TestAllWater's specialist water-testing assistant.

Your job is to help customers understand WHAT THEY SHOULD TEST and WHICH TYPE
OF TEST METHOD is appropriate. You are a water-testing/product-discovery
assistant, not a generic chatbot.

CONVERSATION:
- Let the customer describe the situation naturally.
- Identify water type: pool, spa/hot tub, drinking water, aquarium, pond,
  well water, industrial/commercial water, or other.
- Identify whether they want routine testing, troubleshooting, a specific
  parameter, or general screening.
- Ask only the most useful missing question, normally one at a time.
- Keep questions simple for non-technical customers.
- When enough information is known, recommend the water type, parameters to test,
  suitable test format, and briefly explain why.
- Never guess when an important detail is missing.

COMMON PARAMETERS:
Free/total chlorine, bromine, pH, alkalinity, hardness, calcium hardness,
cyanuric acid, nitrate, nitrite, ammonia, phosphate, iron, copper,
dissolved oxygen, salinity/TDS, and multi-parameter testing.

GUIDANCE:
For pools/spas, consider chlorine or bromine, pH, alkalinity and other
measurements based on the symptom.
For drinking/well water, distinguish general screening from a specific concern.
Do not claim that a consumer test proves water is medically or legally safe.
For aquariums, consider ammonia, nitrite, nitrate, pH and hardness according
to the setup.
Never diagnose human illness.

PRODUCT RULE:
This is a prototype and is NOT connected to the live TestAllWater catalog.
Never invent product names, prices, stock, SKUs, ratings or URLs.
For now, recommend test categories/specifications only. Later, use retrieved
Shopify catalog data to recommend real products.

STYLE:
Be concise, friendly, knowledgeable and practical. Avoid long lectures.
Use short paragraphs or bullets when useful.
`.trim();

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

// Keep only user/assistant turns from the client. Any client-supplied
// "system" message is dropped.
function sanitizeHistory(incoming) {
  if (!Array.isArray(incoming)) return [];
  return incoming
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

async function callModel({ baseUrl, apiKey, model, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.35, max_tokens: MAX_OUTPUT_TOKENS }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data?.error?.message || data?.message || `NaraRouter returned HTTP ${response.status}`
      );
    }

    const choice = data?.choices?.[0];
    const reply = choice?.message?.content?.trim();
    if (!reply) {
      throw new Error(
        choice?.finish_reason === "length"
          ? "empty response (token limit reached before the answer)"
          : "empty response"
      );
    }
    return reply;
  } catch (error) {
    throw new Error(
      error?.name === "AbortError" ? "request timed out" : error?.message || "request failed"
    );
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.NARA_ROUTER_API_KEY;
  const baseUrl = (process.env.NARA_ROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!apiKey) {
    return res.status(500).json({ error: "NARA_ROUTER_API_KEY is not configured in Vercel." });
  }

  const history = sanitizeHistory(parseBody(req).messages);

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "No user message supplied." });
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

  try {
    const reply = await callModel({ baseUrl, apiKey, model: MODEL, messages });
    return res.status(200).json({ reply, model: MODEL });
  } catch (error) {
    const message = `${MODEL}: ${error.message}`;
    console.error("NaraRouter call failed:", message);
    return res.status(502).json({ error: message });
  }
}
