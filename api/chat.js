import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://router.bynara.id/v1";
// Zero-cost model on NaraRouter's Free plan (GET https://router.bynara.id/api/plans).
const MODEL = "nemotron-3.5-lightning-free";

// It is a reasoning model. NaraRouter's docs recommend "low" for everyday chat and
// simple Q&A ("none" disables thinking); the default depth took 22s to 50s+ per reply.
const REASONING_EFFORT = "low";

// The whole upstream exchange (connect + headers + body) gets one hard deadline. It
// must finish inside maxDuration (60s, see vercel.json) and before the browser gives
// up (58s, see index.html), so the client always receives a JSON answer.
const MODEL_TIMEOUT_MS = 45000;
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

// An error that maps to a specific HTTP status and a message that is safe to show
// to customers.
class ChatError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const timeoutError = () =>
  new ChatError(
    "timeout",
    504,
    `The AI took too long to respond (over ${MODEL_TIMEOUT_MS / 1000}s). Please try again.`
  );

function toChatError(error, meta) {
  if (error instanceof ChatError) return error;
  if (error?.name === "AbortError") return timeoutError();
  meta.errorDetail = [error?.message, error?.cause?.code].filter(Boolean).join(" / ");
  return new ChatError("unreachable", 502, "Could not reach the AI service. Please try again.");
}

// One JSON log line per request for Vercel Runtime Logs. Never includes the API
// key or any message text; only sizes, timings and outcomes.
function logRequest(meta) {
  const { startedAt, ...fields } = meta;
  const line = JSON.stringify({ event: "chat", ...fields, totalMs: Date.now() - startedAt });
  if (meta.outcome === "ok") console.log(line);
  else console.error(line);
}

async function callModel({ baseUrl, apiKey, messages, meta }) {
  const controller = new AbortController();
  let timer;
  // The deadline is a race, not only an abort signal, so the client gets an answer
  // even if the socket never reacts to the abort.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, MODEL_TIMEOUT_MS);
  });

  const exchange = (async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.35,
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning_effort: REASONING_EFFORT,
      }),
      signal: controller.signal,
    });
    meta.upstreamStatus = response.status;
    meta.headersMs = Date.now() - meta.startedAt;

    // Read the body as text under the same signal: a body that stalls is a timeout,
    // not an "empty response".
    const raw = await response.text();
    meta.bodyMs = Date.now() - meta.startedAt;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      meta.rawSnippet = raw.slice(0, 200);
    }

    if (!response.ok) {
      meta.errorDetail = data?.error?.message || data?.message || meta.rawSnippet || "";
      meta.upstreamRequestId = data?.error?.request_id;
      if (response.status === 429) {
        throw new ChatError(
          "rate_limited",
          429,
          "The AI service is busy right now. Please try again in a moment."
        );
      }
      throw new ChatError(
        "upstream_error",
        502,
        `The AI service returned an error (HTTP ${response.status})${
          meta.errorDetail ? `: ${meta.errorDetail}` : "."
        }`
      );
    }

    if (!data) {
      throw new ChatError("bad_response", 502, "The AI service returned an unreadable response.");
    }

    const choice = data.choices?.[0];
    meta.finishReason = choice?.finish_reason;
    meta.promptTokens = data.usage?.prompt_tokens;
    meta.completionTokens = data.usage?.completion_tokens;
    meta.reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    meta.hadReasoning = Boolean(choice?.message?.reasoning_content || choice?.message?.reasoning);

    const reply = choice?.message?.content?.trim();
    if (!reply) {
      throw new ChatError(
        "empty_reply",
        502,
        choice?.finish_reason === "length"
          ? "The AI ran out of tokens before answering. Please try again."
          : "The AI returned an empty answer. Please try again."
      );
    }
    return reply;
  })();

  try {
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    throw toChatError(error, meta);
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
    console.error(JSON.stringify({ event: "chat_config_error", problem: "NARA_ROUTER_API_KEY is not set" }));
    return res.status(500).json({ error: "NARA_ROUTER_API_KEY is not configured in Vercel." });
  }

  const history = sanitizeHistory(parseBody(req).messages);

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "No user message supplied." });
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const requestId = req.headers?.["x-vercel-id"] || randomUUID();
  const meta = {
    requestId,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    historyMessages: history.length,
    startedAt: Date.now(),
  };

  try {
    const reply = await callModel({ baseUrl, apiKey, messages, meta });
    meta.outcome = "ok";
    meta.replyChars = reply.length;
    logRequest(meta);
    return res.status(200).json({ reply, model: MODEL });
  } catch (error) {
    meta.outcome = error.code;
    logRequest(meta);
    return res.status(error.status).json({ error: error.message, code: error.code, requestId });
  }
}
