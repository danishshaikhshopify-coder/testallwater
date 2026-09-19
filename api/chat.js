import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://router.bynara.id/v1";
// Zero-cost model on NaraRouter's Free plan (GET https://router.bynara.id/api/plans).
// Chosen by a live comparison of the Free-plan chat models through this exact flow
// (2 interleaved runs, 48 requests per model): nex-n2.5-pro answered 79% of requests
// with no hard errors; nemotron-3-super-free 60% (11 "empty reply" errors),
// nemotron-3-ultra-free 40%, laguna-s-2.1 35%, nemotron-3.5-lightning-free 17%.
// See "Model selection" in the README.
const MODEL = "nex-n2.5-pro";

// The Free-plan models are reasoning models, but this is simple customer-support chat,
// so thinking is disabled ("none", per NaraRouter's docs): it only adds latency, and
// every model tested worked with it.
const REASONING_EFFORT = "none";

// Each attempt (connect + headers + body) gets its own hard deadline. Live data showed
// the free models either answer within ~12s or stall; NaraRouter also has stall
// episodes lasting 10+ minutes that hit every model at once. A stalled attempt is
// abandoned early and retried once. Worst case is 2 x 9s = 18s, inside the browser's
// 30s limit (see index.html) and maxDuration (60s, see vercel.json), so the client
// always receives a JSON answer.
const ATTEMPT_TIMEOUT_MS = 9000;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 1000;
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
- Use the whole conversation. Never ask again for something the customer already told you.
- If the customer repeats themselves, do not repeat your earlier reply; briefly acknowledge it and move forward.

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

// --- Repeated messages -------------------------------------------------------------
// If the customer sends the same message again after the AI already answered it, the
// model is told so, otherwise it tends to re-run the same list, reasoning and question.
const MIN_REPEAT_CHARS = 10; // shorter replies ("yes", "chlorine") are legitimately reused

const REPEATED_MESSAGE_NOTE = `IMPORTANT - REPEATED MESSAGE: The customer's latest message is word-for-word the same as one they already sent earlier in this conversation, and you already answered it. Treat it as a cue to move the conversation forward, not to answer again.
- Begin with a brief, warm acknowledgement that does not sound like a correction (for example: "Thanks, I've got that.").
- Do NOT repeat or restate anything you already told them: do not re-list tests or parameters, do not repeat your reasoning, do not summarise your earlier recommendation. At most point back to it in a few words (for example: "the tests I listed above").
- Do NOT ask any question you have already asked, even reworded.
- Then add something NEW and useful: ONE different, more specific question you have not asked yet, or a concrete next step (for example how to collect a sample, which result to look out for, or which test format suits them). Only if you have not yet given any recommendation, give your best one now from what you know.
- If the message is a short reply that plausibly answers a newer question than before, just continue normally.`;

// Compare ignoring case, spacing and surrounding punctuation.
const normalizeForCompare = (text) =>
  text.toLowerCase().replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// A message that was sent again straight away, with no AI reply in between, was never
// answered (typically the first attempt failed or timed out). Keep only the last copy so
// a plain "send it again" is treated as the first time, not as a repeat.
function dropUnansweredRepeats(history) {
  return history.filter(
    (m, i) =>
      !(
        m.role === "user" &&
        history[i + 1]?.role === "user" &&
        normalizeForCompare(m.content) === normalizeForCompare(history[i + 1].content)
      )
  );
}

// True when the latest user message equals an earlier one that the AI already answered.
function isAnsweredRepeat(history) {
  const last = history[history.length - 1];
  const key = normalizeForCompare(last.content);
  if (key.length < MIN_REPEAT_CHARS) return false;
  return history.some(
    (m, i) =>
      i < history.length - 1 &&
      m.role === "user" &&
      normalizeForCompare(m.content) === key &&
      history.slice(i + 1, -1).some((later) => later.role === "assistant")
  );
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
  new ChatError("timeout", 504, "The AI took too long to respond. Please try again.");

// Only stalled or unreachable upstreams are worth retrying. Anything the upstream
// actually answered (400/401/403/429/5xx, bad or empty body) is returned as-is.
const isRetryable = (error) => error.code === "timeout" || error.code === "unreachable";

function toChatError(error, meta) {
  if (error instanceof ChatError) return error;
  if (error?.name === "AbortError") return timeoutError();
  meta.errorDetail = [error?.message, error?.cause?.code].filter(Boolean).join(" / ");
  return new ChatError("unreachable", 502, "Could not reach the AI service. Please try again.");
}

// Human-readable message from an upstream error body: {error:{message}}, {error:"..."},
// {message}, or {detail}.
function upstreamMessage(data) {
  const found = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? data?.detail;
  if (!found) return "";
  return (typeof found === "string" ? found : JSON.stringify(found)).slice(0, 300);
}

// nex-n2.5-pro occasionally answers with a JSON object instead of prose, e.g.
// {"water_type":"aquarium","message":"First, are your fish freshwater or saltwater?"}
// (seen once in ~50 replies). Show the customer just the message text.
function unwrapJsonMessage(reply) {
  if (!reply.startsWith("{") || !reply.endsWith("}")) return reply;
  try {
    const parsed = JSON.parse(reply);
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // not JSON: leave the reply untouched
  }
  return reply;
}

// One JSON log line per request for Vercel Runtime Logs. Never includes the API
// key or any message text; only sizes, timings and outcomes.
function logRequest(meta) {
  const { startedAt, ...fields } = meta;
  const line = JSON.stringify({ event: "chat", ...fields, totalMs: Date.now() - startedAt });
  if (meta.outcome === "ok") console.log(line);
  else console.error(line);
}

async function attemptOnce({ baseUrl, apiKey, messages, meta }) {
  const attemptStartedAt = Date.now();
  const controller = new AbortController();
  let timer;
  // The deadline is a race, not only an abort signal, so the client gets an answer
  // even if the socket never reacts to the abort.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, ATTEMPT_TIMEOUT_MS);
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
    meta.headersMs = Date.now() - attemptStartedAt;

    // Read the body as text under the same signal: a body that stalls is a timeout,
    // not an "empty response".
    const raw = await response.text();
    meta.bodyMs = Date.now() - attemptStartedAt;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      meta.rawSnippet = raw.slice(0, 200);
    }

    if (!response.ok) {
      const message = upstreamMessage(data);
      // errorDetail keeps the raw body when there is no structured message, so logs
      // and the JSON "detail" field always show why the upstream failed.
      meta.errorDetail = message || raw.slice(0, 300) || "(empty response body)";
      meta.upstreamRequestId = data?.error?.request_id || response.headers.get("x-request-id");
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
        `The AI service returned an error (HTTP ${response.status})${message ? `: ${message}` : "."}`
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
    const shown = unwrapJsonMessage(reply);
    if (shown !== reply) meta.unwrappedJson = true;
    return shown;
  })();

  try {
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    throw toChatError(error, meta);
  } finally {
    clearTimeout(timer);
  }
}

// Up to MAX_ATTEMPTS identical requests; the first success is returned immediately.
async function callModel({ baseUrl, apiKey, messages, meta }) {
  meta.attempts = [];
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-attempt fields describe the attempt that decided the outcome.
    delete meta.upstreamStatus;
    delete meta.headersMs;
    delete meta.bodyMs;
    delete meta.rawSnippet;

    const startedAt = Date.now();
    try {
      const reply = await attemptOnce({ baseUrl, apiKey, messages, meta });
      meta.attempts.push({ attempt, outcome: "ok", ms: Date.now() - startedAt });
      return reply;
    } catch (error) {
      meta.attempts.push({ attempt, outcome: error.code, ms: Date.now() - startedAt });
      lastError = error;
      if (!isRetryable(error)) break;
    }
  }

  if (lastError.code === "timeout") {
    throw new ChatError(
      "timeout",
      504,
      `The AI took too long to respond (tried ${meta.attempts.length} times, ${
        ATTEMPT_TIMEOUT_MS / 1000
      }s each). Please try again.`
    );
  }
  throw lastError;
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

  const conversation = dropUnansweredRepeats(history);
  const repeated = isAnsweredRepeat(conversation);
  // The note goes into the single system message (some models mishandle several).
  const system = repeated ? `${SYSTEM_PROMPT}\n\n${REPEATED_MESSAGE_NOTE}` : SYSTEM_PROMPT;
  const messages = [{ role: "system", content: system }, ...conversation];
  const requestId = req.headers?.["x-vercel-id"] || randomUUID();
  const meta = {
    requestId,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    historyMessages: conversation.length,
    startedAt: Date.now(),
  };
  if (repeated) meta.repeatedMessage = true;
  if (conversation.length !== history.length) meta.droppedUnansweredRepeats = history.length - conversation.length;

  try {
    const reply = await callModel({ baseUrl, apiKey, messages, meta });
    meta.outcome = "ok";
    meta.replyChars = reply.length;
    logRequest(meta);
    return res.status(200).json({ reply, model: MODEL });
  } catch (error) {
    meta.outcome = error.code;
    logRequest(meta);
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code, requestId, detail: meta.errorDetail });
  }
}
