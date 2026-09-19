# TestAllWater AI Assistant

A direct chat interface that helps customers work out which water test they need.

```
Browser (index.html)  ──POST /api/chat──▶  Vercel function (api/chat.js)  ──▶  NaraRouter
   no secrets                               holds the API key + system prompt     /v1/chat/completions
```

- **Frontend** – `index.html`, a single static page. Every message is sent to `/api/chat` and the reply shown is the real model response. There is no demo or canned-reply fallback: if the request fails, the error is shown.
- **Backend** – `api/chat.js`, a Vercel serverless function. It adds the system prompt, calls NaraRouter's OpenAI-compatible API with the `nex-n2.5-pro` model only (no fallback model). It is a zero-cost model on NaraRouter's Free plan; `deepseek-v4-flash` is not used because it requires a paid plan. Check the current list at `https://router.bynara.id/api/plans` before changing the model, and see [Model selection](#model-selection) for how this one was chosen.
- **Conversation context** – the browser keeps the conversation and sends the last 12 turns with each request; the server forwards them to the model after the system prompt.

## Security

- `NARA_ROUTER_API_KEY` exists only as a Vercel environment variable and is only read inside `api/chat.js`. It never appears in `index.html` or any client-side code.
- The system prompt is server-side. Any `system` message sent by a client is discarded, so the endpoint cannot be repurposed as a general-purpose LLM proxy. History length (12 turns) and message size (4,000 chars) are capped.
- The endpoint has no rate limiting. If abuse becomes a concern, add one (e.g. Vercel WAF rate-limit rule or Upstash Ratelimit).

## Model selection

The Free-plan chat models were compared on the live deployment through the exact production flow (server prompt, `reasoning_effort: "none"`, 1000 tokens, 2 x 9s attempts). Requests were interleaved model-by-model with identical prompts (six realistic customer messages, one of them multi-turn) so every model saw the same upstream conditions. 48 requests per model over two runs:

| Model | Answered | 95% CI | Timeouts | Hard errors | Median reply time | p90 |
| --- | --- | --- | --- | --- | --- | --- |
| **`nex-n2.5-pro`** (chosen) | **38/48 (79%)** | 66-88% | 10 | 0 | 7.4s | 15.5s |
| `nemotron-3-super-free` | 29/48 (60%) | 46-73% | 8 | 11 (empty reply) | 5.2s | 7.7s |
| `nemotron-3-ultra-free` | 19/48 (40%) | 27-54% | 23 | 6 | 13.8s | 17.3s |
| `laguna-s-2.1` | 17/48 (35%) | 23-50% | 24 | 7 | 8.9s | 18.1s |
| `nemotron-3.5-lightning-free` (previous) | 8/48 (17%) | 9-30% | 40 | 0 | 13.7s | 18.0s |

Caveats:
- NaraRouter has stall episodes lasting 10+ minutes in which **every** model times out at once (in the second run, 7 of 60 requests succeeded across all five models during one). Model choice cannot fix that; only same-window comparisons like the above are meaningful, and results will drift as NaraRouter's capacity changes.
- `nex-n2.5-pro` sometimes answers with a JSON object instead of prose (9 of 187 replies in later testing, mostly aquarium questions), and the key varies (`message`, `response`, `answer`, `question`, `assistant_response`, `assistantMessage`, or a structured `{"water_type": ..., "parameters": [...]}`) and sometimes stops before the closing brace. `api/chat.js` never lets raw JSON reach a customer: an object with a prose field shows just that text, a flat structured object is shown as a bullet list, and JSON it cannot render becomes a `bad_response` error (the customer sees the friendly error copy). Replies that are not a JSON object are untouched.
- `nex-n2.5-pro` occasionally stops after a token or two (a reply that is just `{` or `For`, roughly 1 in 40 in testing). A reply with fewer than 4 letters or digits is treated as an `empty_reply` error, so the customer sees the friendly error instead of a broken bubble. It is not retried automatically (only timeouts and network failures are).
- `nemotron-3-super-free` was the fastest when it worked, but about a quarter of its requests came back empty.

## Conversation behaviour

- **Repeated messages.** If the customer sends the same message again after the AI already answered it (compared ignoring case, spacing and end punctuation; messages under 10 characters such as "yes" are exempt), the server adds a note to the system prompt telling the model to acknowledge it and move forward instead of repeating its earlier reply or question. The base prompt also tells the model to use the whole conversation.
- **Failed then resent.** A message that got no answer (timeout or error) stays in the conversation as context. If the customer just sends it again, the unanswered copy is dropped so it is treated as a first-time message, not a repeat.
- **Errors.** Customers see plain, friendly copy (timeout: "…please send your message again, our conversation is still here…"; busy; generic). Technical details go to the browser console and the Vercel logs only, and the failed exchange never enters the history, so the next message continues normally.
- **Markdown.** Assistant replies render Markdown: `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, bullet / numbered / nested lists, headings (shown as bold lines), horizontal rules and `http(s)` links (opened with `noopener noreferrer nofollow`). Tables and other syntax appear as plain text. The customer's own messages are always plain text. The renderer builds DOM nodes (`createElement`, `createTextNode`) from a fixed tag whitelist and never uses `innerHTML`, so model output cannot inject markup or scripts; `test/ui.test.js` checks this with a DOM that throws if `innerHTML` is touched.

## Reliability and debugging

- The model is called with `reasoning_effort: "none"` and `max_tokens: 1000`. It is a reasoning model, but this is simple customer-support chat: at its default depth the free model took 22s to 50s+ per reply, and at `"low"` about one request in three still hit the deadline.
- **Retry:** each upstream attempt (connect + headers + body) has its own hard 9s deadline. Live data showed this free model either answers within ~12s or stalls indefinitely, so a stalled attempt is abandoned and retried **once** with the identical request; the first success is returned immediately. Only timeouts and network failures are retried. Anything NaraRouter actually answered (400, 401, 403, 429, 5xx, bad or empty body) is returned as-is. Worst case is 2 x 9s = 18s, inside the browser's own 30s safety limit, so the API always answers with JSON and the "thinking" indicator always clears. If both attempts fail the API returns `504` "The AI took too long to respond (tried 2 times, 9s each)".
- Error responses are JSON: `{ "error": "<friendly message>", "code": "...", "requestId": "..." }` with codes `timeout` (504), `rate_limited` (429), `upstream_error`, `unreachable`, `bad_response`, `empty_reply` (502). `detail` (the raw upstream reason) is for debugging and is not shown in the UI.
- Every request writes one JSON log line to **Vercel → Project → Logs** (`"event":"chat"`): `outcome`, `attempts` (outcome and ms of each attempt), `upstreamStatus`, `headersMs`, `bodyMs`, `totalMs`, `finishReason`, token counts (`reasoningTokens` shows how much time was spent thinking), and `requestId` (the `x-vercel-id`). Failures are logged at error level. Logs contain no API key and no message text.
- If too many requests still fail, check `attempts` and `totalMs` in the logs; the remaining lever is a different free model from `https://router.bynara.id/api/plans`.

## Deploy on Vercel

1. Import this GitHub repo in Vercel (framework preset: **Other**; no build command, no output directory).
2. Add environment variables (Project → Settings → Environment Variables), for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `NARA_ROUTER_API_KEY` | your NaraRouter key |
   | `NARA_ROUTER_BASE_URL` | `https://router.bynara.id/v1` |

3. Deploy. Every push to `main` then deploys automatically.

Environment variable changes only apply to **new** deployments — redeploy after editing them.

## Local development

```bash
npm test                                  # unit tests (mocked NaraRouter, no key needed)
cp .env.example .env.local                # then fill in NARA_ROUTER_API_KEY
npx vercel dev                            # serves index.html and /api/chat locally
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Chat UI (static) |
| `api/chat.js` | `/api/chat` serverless function |
| `vercel.json` | Function config (`maxDuration: 60`) |
| `package.json` | ESM + Node 22 + `npm test` |
| `test/chat.test.js` | Backend and no-secret-in-frontend tests |
| `.env.example` | Environment variable template |

## Notes

The assistant is a prototype and is not connected to the live TestAllWater product catalog; it recommends test categories and specifications, not specific products.
