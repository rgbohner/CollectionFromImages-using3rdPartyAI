/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Translates the shared AI request and response format for Gemini.
 * Why: Allows alternate-provider recognition without duplicating the collection workflow.
 */
"use strict";
const { emptyUsage } = require("./ai-usage.cjs");
const ENDPOINT = "https://generativelanguage.googleapis.com/v1/interactions";
const WEB_UNAVAILABLE =
  "Saved web research requires OpenAI. Choose OpenAI in your environment or CLI options, or use Gemini without web search.";
function part(p) {
  if (p.type === "input_text") return { type: "text", text: p.text };
  const image =
    p.type === "input_image" &&
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
      p.image_url,
    );
  if (image) return { type: "image", mime_type: image[1], data: image[2] };
  throw Error("Gemini needs a local JPEG, PNG or WebP preview.");
}
function interaction(body) {
  if (body.tools?.length) throw Error(WEB_UNAVAILABLE);
  const input =
    typeof body.input === "string"
      ? body.input
      : body.input.map(({ role, content }) => ({
          type: role === "assistant" ? "model_output" : "user_input",
          content:
            typeof content === "string"
              ? [{ type: "text", text: content }]
              : content.map(part),
        }));
  return {
    model: body.model,
    input,
    system_instruction: body.instructions,
    store: false,
    generation_config: { max_output_tokens: body.max_output_tokens },
    ...(body.text?.format
      ? {
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: body.text.format.schema,
          },
        }
      : {}),
  };
}
async function geminiResponse(
  body,
  { apiKey, fetchImpl, signal, onUsage, timeoutMs, maxBytes },
) {
  if (!apiKey)
    throw Error(
      "Connect a Gemini API key in your environment or CLI options first.",
    );
  const payload = interaction(body);
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    signal?.throwIfAborted();
    throw Error("Gemini could not connect or timed out. Try again.");
  }
  if (!res.ok) {
    let invalidKey = false;
    try {
      const raw = await res.text();
      if (raw.length <= maxBytes)
        invalidKey = /API_KEY_INVALID|API key not valid|invalid API key/i.test(
          raw,
        );
    } catch {}
    const denied = [401, 403].includes(res.status) || invalidKey;
    const error = Error(
      denied
        ? "Gemini rejected the API key or its permissions. Check the key and project in Google AI Studio."
        : res.status === 429
          ? "Gemini usage limit reached. Check your project quota or billing and retry."
          : res.status === 404
            ? "Gemini model not found. Check the model ID in your environment or CLI options."
            : "Gemini request failed (" +
              res.status +
              "). Check the model and try again.",
    );
    error.apiAccessBlocked = denied || res.status === 429;
    const retry = res.headers?.get("retry-after");
    if (res.status === 429 && /^\d{1,6}$/.test(retry))
      error.retryAt = new Date(Date.now() + Number(retry) * 1000).toISOString();
    throw error;
  }
  const raw = await res.text();
  if (raw.length > maxBytes)
    throw Error("Gemini response exceeded the size limit.");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error("Gemini returned an unreadable response.");
  }
  const u = data.usage || {},
    count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const usage = {
    ...emptyUsage(),
    input_tokens: count(u.total_input_tokens),
    cached_input_tokens: count(u.total_cached_tokens),
    output_tokens: count(u.total_output_tokens) + count(u.total_thought_tokens),
    cost_complete: false,
    gemini_usage: true,
    cost_issues: ["Gemini cost is available from Google AI Studio billing."],
  };
  onUsage?.(usage);
  if (data.status !== "completed")
    throw Error("Gemini analysis did not finish. Try again.");
  const content = (data.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => ({ type: "output_text", text: p.text }));
  if (!content.length)
    throw Error("Gemini returned no answer. Try different input.");
  return {
    status: "completed",
    id: data.id,
    model: data.model || body.model,
    usage,
    output: [{ type: "message", content }],
  };
}
module.exports = { ENDPOINT, WEB_UNAVAILABLE, geminiResponse };
