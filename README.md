# TestAllWater AI Assistant

A direct chat interface that helps customers work out which water test they need.

```
Browser (index.html)  ──POST /api/chat──▶  Vercel function (api/chat.js)  ──▶  NaraRouter
   no secrets                               holds the API key + system prompt     /v1/chat/completions
```

- **Frontend** – `index.html`, a single static page. Every message is sent to `/api/chat` and the reply shown is the real model response. There is no demo or canned-reply fallback: if the request fails, the error is shown.
- **Backend** – `api/chat.js`, a Vercel serverless function. It adds the system prompt, calls NaraRouter's OpenAI-compatible API with the `deepseek-v4-flash` model only (no fallback model).
- **Conversation context** – the browser keeps the conversation and sends the last 12 turns with each request; the server forwards them to the model after the system prompt.

## Security

- `NARA_ROUTER_API_KEY` exists only as a Vercel environment variable and is only read inside `api/chat.js`. It never appears in `index.html` or any client-side code.
- The system prompt is server-side. Any `system` message sent by a client is discarded, so the endpoint cannot be repurposed as a general-purpose LLM proxy. History length (12 turns) and message size (4,000 chars) are capped.
- The endpoint has no rate limiting. If abuse becomes a concern, add one (e.g. Vercel WAF rate-limit rule or Upstash Ratelimit).

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
