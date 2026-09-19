// TEMPORARY: runs the exact /api/chat flow (retry, timeouts, key, system prompt,
// settings) with a chosen Free-plan model so models can be compared on the live
// deployment. Only the whitelisted Free-plan IDs are accepted. Delete after the test.
import { createHandler } from "./chat.js";

const ALLOWED = [
  "nemotron-3.5-lightning-free", // current model (control)
  "nemotron-3-super-free",
  "nemotron-3-ultra-free",
  "laguna-s-2.1",
  "nex-n2.5-pro",
];

export default function modelProbe(req, res) {
  const model = req.query?.model;
  if (!ALLOWED.includes(model)) {
    return res.status(400).json({ error: "model not allowed", allowed: ALLOWED });
  }
  return createHandler(model)(req, res);
}
