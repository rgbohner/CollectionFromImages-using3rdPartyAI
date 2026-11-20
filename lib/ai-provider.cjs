/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Resolves providers, model identifiers and credentials from environment settings.
 * Why: Keeps provider selection portable and rejects invalid model or provider combinations.
 */
"use strict";
const OPENAI_MODEL = "gpt-4.1-mini",
  OPENAI_RESEARCH_MODEL = "gpt-6.1-terra",
  GEMINI_MODEL = "gemini-3.8-flash";
const names = { openai: "OpenAI", gemini: "Gemini" };
function providerId(value = "openai") {
  if (typeof value !== "string" || !Object.hasOwn(names, value))
    throw Error("Choose OpenAI or Gemini.");
  return value;
}
function modelId(provider, id) {
  if (
    typeof id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(id) ||
    (provider === "gemini" && !id.startsWith("gemini-"))
  )
    throw Error("Enter a valid " + names[provider] + " model ID.");
  return id;
}
function environment(
  env,
  provider = env.COLLECTION_AI_PROVIDER ||
    (env.GEMINI_API_KEY && !env.OPENAI_API_KEY ? "gemini" : "openai"),
) {
  providerId(provider);
  const gemini = provider === "gemini",
    prefix = gemini ? "GEMINI_" : "OPENAI_";
  return {
    provider,
    apiKey: env[prefix + "API_KEY"],
    model: env[prefix + "MODEL"] || (gemini ? GEMINI_MODEL : OPENAI_MODEL),
    researchModel:
      env[prefix + "RESEARCH_MODEL"] ||
      env[prefix + "MODEL"] ||
      (gemini ? GEMINI_MODEL : OPENAI_RESEARCH_MODEL),
  };
}
function assertProvider(expected, actual = "openai") {
  if (expected !== undefined && providerId(expected) !== providerId(actual)) {
    const e = Error(
      "AI provider changed. Review the selected provider before continuing.",
    );
    e.providerChanged = true;
    throw e;
  }
}
module.exports = {
  assertProvider,
  OPENAI_MODEL,
  OPENAI_RESEARCH_MODEL,
  GEMINI_MODEL,
  names,
  providerId,
  modelId,
  environment,
};
