/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Sends bounded, cancellable AI requests and translates provider responses and errors.
 * Why: Centralizes transport behavior, non-stored OpenAI requests and usage reporting.
 */
"use strict";
const { responseUsage } = require("./ai-usage.cjs");
const { modelId, providerId } = require("./ai-provider.cjs");
const { geminiResponse } = require("./gemini.cjs");
function responseText(data) {
  return (data.output || [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n");
}
async function requestError(res) {
  let code = "";
  try {
    const raw = await res.text();
    if (raw.length <= 2 * 1024 * 1024) code = JSON.parse(raw).error?.code || "";
  } catch {}
  const messages = {
    credit_balance_exhausted:
      "OpenAI credits are exhausted. After adding credits, rerun with --resume.",
    organization_spend_limit_exceeded:
      "OpenAI organization spending limit reached. Update the limit, then rerun with --resume.",
    project_spend_limit_exceeded:
      "OpenAI project spending limit reached. Update the limit, then rerun with --resume.",
    organization_usage_limit_exceeded:
      "OpenAI organization usage limit reached. Update the limit, then rerun with --resume.",
    insufficient_quota:
      "OpenAI quota is unavailable. Check API credits and spending limits, then rerun with --resume.",
    rate_limit_exceeded:
      "OpenAI rate limit reached. Wait a moment, then rerun with --resume.",
    slow_down:
      "OpenAI requests need to slow down. Wait a moment, then rerun with --resume.",
  };
  const error = Error(
    res.status === 401
      ? "OpenAI rejected the API key. Update OPENAI_API_KEY."
      : res.status === 429
        ? Object.hasOwn(messages, code)
          ? messages[code]
          : "OpenAI usage limit reached. Check API credits or rate limits, then rerun with --resume."
        : `OpenAI request failed (${res.status}). Retry this item.`,
  );
  error.apiAccessBlocked = res.status === 401 || res.status === 429;
  if (res.status === 429) {
    const retry = res.headers?.get("retry-after");
    if (retry) {
      const at = /^\d+(\.\d+)?$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry);
      if (Number.isFinite(at) && at > Date.now())
        error.retryAt = new Date(at).toISOString();
    }
  }
  return error;
}
async function response(
  body,
  {
    provider = "openai",
    apiKey,
    fetchImpl = fetch,
    signal,
    onUsage,
    timeoutMs = 600000,
    maxBytes = 2 * 1024 * 1024,
  },
) {
  providerId(provider);
  modelId(provider, body.model);
  if (provider === "gemini")
    return geminiResponse(body, {
      apiKey,
      fetchImpl,
      signal,
      onUsage,
      timeoutMs,
      maxBytes,
    });
  if (!apiKey)
    throw Error(
      "Connect an OpenAI API key in your environment or CLI options first.",
    );
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({ ...body, store: false }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await requestError(res);
  const raw = await res.text();
  if (raw.length > maxBytes)
    throw Error("AI response exceeded the size limit.");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error("OpenAI returned an unreadable response. Try again.");
  }
  onUsage?.(responseUsage(data, body.model));
  if (data.status !== "completed") {
    const error = Error("AI analysis did not finish. Retry this item.");
    error.partialResponse = data;
    throw error;
  }
  return data;
}
module.exports = { response, responseText };
