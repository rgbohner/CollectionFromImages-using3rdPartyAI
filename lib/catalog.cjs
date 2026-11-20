/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Normalizes catalog labels and values against the collection-type configuration.
 * Why: Keeps aliases and typed attributes consistent across recognition, research and exports.
 */
"use strict";
// Catalog-only normalization; no UI or storage dependencies.
const currencies = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "SGD",
  "HKD",
];
const validNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const dateOK = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const safeURL = (s) => {
  try {
    const u = new URL(s);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : "";
  } catch {
    return "";
  }
};
const safeImage = (s) =>
  typeof s === "string" &&
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(s) &&
  s.length < 12e6
    ? s
    : "";
const {
  loadCollectionTypes,
  attributesFor,
  fieldKey,
} = require("./collection-types.cjs");

// Configuration owns canonical labels and aliases; retain extra observations.
function catalogField(label, type, configuration = loadCollectionTypes()) {
  const trimmed = String(label || "").trim();
  const key = fieldKey(trimmed);
  const attribute = attributesFor(configuration, type).find((attribute) =>
    [attribute.label, ...(attribute.aliases ?? [])].some(
      (name) => fieldKey(name) === key,
    ),
  );
  const field = attribute ?? { label: trimmed, type: "text" };
  return { ...field, key: "detail:" + fieldKey(field.label) };
}
function catalogValue(value, field) {
  let text = String(value ?? "").trim();
  if (field.type === "number" && /\((?:mm|g)\)$/.test(field.label))
    text = text.replace(/\s*(?:mm|g)$/i, "");
  if (
    field.type === "number" &&
    field.key === "detail:page count" &&
    /^\d+\s*(?:pages?|pp\.?)(?:\s*\([^)]*\)\.?)?$/i.test(text)
  )
    text = text.match(/^\d+/)[0];
  return typedValue(text, field);
}
function catalogFields(fields, type, configuration = loadCollectionTypes()) {
  const out = [],
    seen = new Set();
  for (const f of fields || []) {
    const col = catalogField(f.label, type, configuration);
    if (seen.has(col.key)) continue;
    seen.add(col.key);
    out.push({
      ...f,
      label: col.label,
      key: col.key,
      value: String(catalogValue(f.value, col)),
    });
  }
  return out;
}
function typedValue(value, column) {
  let text = String(value ?? "").trim();
  if (column.type === "number") {
    if (!text) return "";
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ||
      !Number.isFinite(Number(text))
    )
      throw new Error("Enter a number or leave blank.");
    return Number(text);
  }
  if (column.type === "date") {
    if (text && !dateOK(text))
      throw new Error("Use YYYY-MM-DD or leave blank.");
    return text;
  }
  if (column.type === "boolean") {
    if (!text) return "";
    if (["true", "yes", "1"].includes(text.toLowerCase())) return true;
    if (["false", "no", "0"].includes(text.toLowerCase())) return false;
    throw new Error("Use TRUE or FALSE.");
  }
  if (column.type === "url") {
    if (!text) return "";
    if (text.length > 4000 || !safeURL(text))
      throw new Error("Use a valid HTTP(S) link.");
    return safeURL(text);
  }
  if (String(value ?? "").length > 10000)
    throw new Error("Maximum 10000 characters.");
  return String(value ?? "");
}
module.exports = {
  currencies,
  validNumber,
  dateOK,
  safeURL,
  safeImage,
  catalogField,
  catalogValue,
  catalogFields,
};
