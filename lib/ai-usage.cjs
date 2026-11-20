"use strict";
// Standard USD rates per million tokens, checked 2026-10-29.
// https://developers.openai.com/api/docs/pricing
// Keep explicit model families: never infer pricing for custom/fine-tuned IDs.
const PRICING_DATE = "2026-10-29";
const RATES = {
  "gpt-4.1": { input: 2, cached: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6, searchTokens: 8000 },
  "gpt-4.1-nano": { input: 0.1, cached: 0.025, output: 0.4 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15, longContext: true },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30, longContext: true },
  "gpt-6-astra": {
    input: 10,
    cached: 1,
    output: 50,
    longContext: true,
    cacheWrites: true,
    ultrafast: true,
  },
  "gpt-6.1-sol": {
    input: 2,
    cached: 0.1,
    output: 10,
    longContext: true,
    cacheWrites: true,
    ultrafast: true,
  },
  "gpt-6.1-terra": {
    input: 1,
    cached: 0.05,
    output: 5,
    longContext: true,
    cacheWrites: true,
  },
  "gpt-6-sol": {
    input: 2,
    cached: 0.2,
    output: 10,
    longContext: true,
    cacheWrites: true,
  },
  "gpt-6-luna": {
    input: 0.1,
    cached: 0.01,
    output: 0.5,
    longContext: true,
    cacheWrites: true,
  },
};
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const validCount = (n) => Number.isSafeInteger(n) && n >= 0;
const dollars = (n) => Math.round(n * 1e12) / 1e12;
function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    web_search_calls: 0,
    estimated_cost_usd: 0,
    cost_complete: true,
    cost_issues: [],
    pricing_date: PRICING_DATE,
  };
}
function responseUsage(data, requestedModel) {
  const usage = data.usage || {},
    model = String(data.model || requestedModel || "").replace(
      /-\d{4}-\d{2}-\d{2}$/,
      "",
    ),
    rate = Object.hasOwn(RATES, model) ? RATES[model] : null;
  const details = usage.input_tokens_details || {},
    input = count(usage.input_tokens),
    output = count(usage.output_tokens),
    cached = count(details.cached_tokens),
    writes = count(details.cache_write_tokens);
  const writeDetails = details.cache_write_tokens_details,
    write30 = writeDetails ? count(writeDetails.ttl_30m_tokens) : writes,
    write12 = writeDetails ? count(writeDetails.ttl_12h_tokens) : 0;
  const searches = (data.output || []).filter(
    (o) => o.type === "web_search_call",
  ).length;
  const tier = data.service_tier || "default",
    multiplier =
      tier === "default"
        ? 1
        : rate?.cacheWrites
          ? tier === "flex"
            ? 0.5
            : ["priority", "fast"].includes(tier)
              ? 2
              : tier === "ultrafast" && rate.ultrafast
                ? 6
                : 0
          : 0;
  const issues = [];
  if (!rate)
    issues.push(
      `No token pricing for model ${model.slice(0, 100) || "(missing)"}.`,
    );
  else if (!multiplier)
    issues.push(
      `No token pricing for service tier ${String(tier).slice(0, 100)} on ${model}.`,
    );
  const optionalCount = (n) => n === undefined || validCount(n);
  if (
    !validCount(usage.input_tokens) ||
    !validCount(usage.output_tokens) ||
    !optionalCount(details.cached_tokens) ||
    !optionalCount(details.cache_write_tokens) ||
    cached + writes > input ||
    (writeDetails &&
      (!validCount(writeDetails.ttl_30m_tokens) ||
        !validCount(writeDetails.ttl_12h_tokens) ||
        write30 + write12 !== writes))
  )
    issues.push("Token usage details are missing or invalid.");
  if (writes && !rate?.cacheWrites)
    issues.push("Cache-write pricing is unavailable.");
  const complete = issues.length === 0;
  const long = rate?.longContext && input > 272000;
  // Mini's non-preview search content is billed as a separate fixed input block.
  // Cache writes replace ordinary input charges; absent TTL details use our requests' default 30m lifetime.
  const tokens = complete
    ? (((input - cached - writes + write30 * 1.25 + write12 * 2.5) *
        (long ? 2 : 1) *
        rate.input +
        cached * (long ? 2 : 1) * rate.cached +
        output * (long ? 1.5 : 1) * rate.output +
        searches * (rate.searchTokens || 0) * rate.input) *
        multiplier) /
      1e6
    : 0;
  // Search call fees remain known even when a model's token pricing is unavailable.
  return {
    ...emptyUsage(),
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_write_tokens: writes,
    web_search_calls: searches,
    estimated_cost_usd: dollars(tokens + searches * 0.01),
    cost_complete: complete,
    cost_issues: issues,
  };
}
function addUsage(total = {}, next = {}) {
  const result = emptyUsage();
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "web_search_calls",
  ])
    result[key] = count(total[key]) + count(next[key]);
  // Legacy totals lack model/cached-token details. Do not invent a historical cost.
  const complete = (u) =>
    (u.cost_complete === true &&
      Number.isFinite(u.estimated_cost_usd) &&
      u.estimated_cost_usd >= 0) ||
    (u.cost_complete === undefined &&
      !count(u.input_tokens) &&
      !count(u.output_tokens) &&
      !count(u.web_search_calls));
  result.cost_complete = complete(total) && complete(next);
  if (total.gemini_usage || next.gemini_usage) result.gemini_usage = true;
  // The old calculator stored zero for every unsupported model, including its known search fees.
  const cost = (u) =>
    Number.isFinite(u.estimated_cost_usd) && u.estimated_cost_usd > 0
      ? u.estimated_cost_usd
      : !complete(u)
        ? count(u.web_search_calls) * 0.01
        : 0;
  result.estimated_cost_usd = dollars(cost(total) + cost(next));
  result.cost_issues = [
    ...new Set(
      [total, next].flatMap((u) =>
        complete(u)
          ? []
          : u.cost_issues?.length
            ? u.cost_issues
            : ["Earlier usage is missing model or pricing details."],
      ),
    ),
  ].slice(0, 10);
  return result;
}
// Preserve usage even if parsing fails, research's second request fails, or it is paused.
async function withUsage(config, operation) {
  let usage = emptyUsage();
  try {
    return {
      ...(await operation({
        ...config,
        onUsage: (next) => {
          usage = addUsage(usage, next);
        },
      })),
      usage,
    };
  } catch (error) {
    error.usage = usage;
    throw error;
  }
}
module.exports = { emptyUsage, responseUsage, addUsage, withUsage };
