/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Builds validated recognition and research model, effort, timeout and search-budget settings.
 * Why: Keeps quick and detailed analysis behavior consistent across request stages.
 */
"use strict";
const PIPELINE_VERSION = "research-3",
  IMAGE_VERSION = "analysis-2560-v1";
const {
  GEMINI_MODEL,
  OPENAI_MODEL,
  OPENAI_RESEARCH_MODEL: DEFAULT_RESEARCH_MODEL,
} = require("./ai-provider.cjs");
const DEFAULT_RESEARCH_EFFORT = "medium";
function researchProfile(config = {}) {
  const mode = config.researchMode === "quick" ? "quick" : "detailed",
    detailed = mode === "detailed";
  const model =
    config.researchModel ||
    (config.provider === "gemini" ? GEMINI_MODEL : DEFAULT_RESEARCH_MODEL);
  const effort = /^gpt-6(?:[.-]|$)/.test(model)
    ? config.researchEffort || DEFAULT_RESEARCH_EFFORT
    : /^gpt-5(?:[.-]|$)/.test(model)
      ? "high"
      : "";
  const toolBudget = Number(config.researchToolBudget ?? (detailed ? 12 : 4));
  if (!Number.isInteger(toolBudget) || toolBudget < 3 || toolBudget > 20)
    throw Error("Choose a research search budget from 3 to 20.");
  if (!["", "low", "medium", "high", "xhigh", "max"].includes(effort))
    throw Error("Choose a supported reasoning effort.");
  return {
    ...(config.provider === "gemini" ? { provider: "gemini" } : {}),
    version: PIPELINE_VERSION,
    imageVersion: IMAGE_VERSION,
    mode,
    model,
    recognitionModel:
      detailed && config.provider !== "gemini"
        ? model
        : config.model ||
          (config.provider === "gemini" ? GEMINI_MODEL : OPENAI_MODEL),
    effort,
    toolBudget,
    maxOutputTokens: detailed ? 24000 : 8000,
    structureMaxOutputTokens: 8000,
    timeoutMs: detailed ? 600000 : 180000,
  };
}
const profileKey = (config) => JSON.stringify(researchProfile(config));
module.exports = {
  PIPELINE_VERSION,
  IMAGE_VERSION,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_RESEARCH_EFFORT,
  researchProfile,
  profileKey,
};
