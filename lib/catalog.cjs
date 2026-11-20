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
const sheetFields = [
  ["id", "ID", "text"],
  ["brand", "Brand", "text"],
  ["model", "Model", "text"],
  ["reference", "Reference", "text"],
  ["status", "Status", "text"],
  ["width", "Case width (mm)", "number"],
  ["thickness", "Thickness (mm)", "number"],
  ["purchasePrice", "Purchase price", "number"],
  ["purchaseCurrency", "Currency", "text"],
  ["notes", "Notes", "text"],
  ["pictureLink", "Picture link", "photos"],
  ["category", "Category", "text"],
  ["confidence", "Identification", "text"],
  ["lugToLug", "Lug-to-lug (mm)", "number"],
  ["lugWidth", "Lug width (mm)", "number"],
  ["material", "Case material", "text"],
  ["movement", "Movement", "text"],
  ["dial", "Dial", "text"],
  ["powerReserve", "Power reserve (hours)", "number"],
  ["waterResistance", "Water resistance (m)", "number"],
  ["purchaseDate", "Purchase date", "date"],
  ["favorite", "Favorite", "boolean"],
  ["tags", "Tags", "text"],
  ["identificationNote", "Identification notes", "text"],
  ["specNote", "Specification notes", "text"],
].map(([key, label, type]) => ({ key, label, type }));
const collectionTypes = {
  empty: "Empty",
  coin: "Coins",
  comic: "Comic books",
  magazines: "Magazines",
  watch: "Watches",
  cards: "Cards",
  items: "Items",
};
const templateDetails = {
  empty: [
    ["Example 1", "text"],
    ["Example 2", "text"],
  ],
  coin: [
    ["Country", "text"],
    ["Year", "number"],
    ["Denomination", "text"],
    ["Mint mark", "text"],
    ["Metal", "text"],
    ["Grade", "text"],
    ["Grading service", "text"],
    ["Certification number", "text"],
    ["Weight (g)", "number"],
    ["Diameter (mm)", "number"],
  ],
  comic: [
    ["Series", "text"],
    ["Issue number", "text"],
    ["Publisher", "text"],
    ["Publication year", "number"],
    ["Variant / edition", "text"],
    ["Writer", "text"],
    ["Artist", "text"],
    ["Grade", "text"],
    ["Grading service", "text"],
    ["Certification number", "text"],
  ],
  magazines: [
    ["Publication", "text"],
    ["Issue", "text"],
    ["Publisher", "text"],
    ["Publication date", "text"],
    ["Edition", "text"],
    ["Language", "text"],
    ["Cover subject", "text"],
    ["Page count", "number"],
  ],
  cards: [
    ["Game", "text"],
    ["Language", "text"],
    ["Printing", "text"],
    ["Collector number", "text"],
    ["Set", "text"],
    ["Card number", "text"],
    ["Year", "number"],
    ["Player / character", "text"],
    ["Manufacturer", "text"],
    ["Rarity", "text"],
    ["Condition", "text"],
    ["Grade", "text"],
    ["Grading service", "text"],
  ],
  items: [
    ["Maker", "text"],
    ["Category", "text"],
    ["Year", "number"],
    ["Material", "text"],
    ["Condition", "text"],
    ["Location", "text"],
  ],
};
function columnsForType(type) {
  if (!Object.hasOwn(collectionTypes, type))
    throw new Error("Choose a collection type.");
  if (type === "watch") return sheetFields.map((c) => ({ ...c }));
  const keys = [
    "id",
    "model",
    "status",
    "pictureLink",
    "purchasePrice",
    "purchaseCurrency",
    "purchaseDate",
    "notes",
    "favorite",
    "tags",
  ];
  const common = keys.map((key) => ({
    ...sheetFields.find((c) => c.key === key),
    ...(key === "model" ? { label: "Name" } : {}),
  }));
  return [
    ...common,
    ...templateDetails[type].map(([label, type]) => ({
      key: "detail:" + label.toLowerCase(),
      label,
      type,
    })),
  ];
}
function itemColumns(data, columns) {
  return columns;
}
// Stable catalog keys keep model wording from creating a new column on every run.
function catalogField(label, type, columns = []) {
  const key = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
  const canonicalKey =
    type === "watch" &&
    {
      "case diameter": "width",
      "case diameter (mm)": "width",
      "case width": "width",
      "case size": "width",
      "lug width": "lugWidth",
      "lug to lug": "lugToLug",
      "reference number": "reference",
    }[key];
  if (typeof canonicalKey === "string")
    return sheetFields.find((c) => c.key === canonicalKey);
  const numberFields = {
    quantity: "Quantity",
    copies: "Quantity",
    qty: "Quantity",
    "keep quantity": "Keep quantity",
    fineness: "Fineness",
    mintage: "Mintage",
    weight: "Weight (g)",
  };
  if (Object.hasOwn(numberFields, key)) {
    const label = numberFields[key];
    return { key: "detail:" + label.toLowerCase(), label, type: "number" };
  }
  const magazine = {
    publication: "Publication",
    magazine: "Publication",
    "magazine name": "Publication",
    "publication name": "Publication",
    issue: "Issue",
    "issue number": "Issue",
    number: "Issue",
    date: "Publication date",
    "publication date": "Publication date",
    "issue date": "Publication date",
    "cover date": "Publication date",
    publisher: "Publisher",
    "publisher credits": "Publisher",
    edition: "Edition",
    "cataloged edition": "Edition",
    language: "Language",
    country: "Country",
    cover: "Cover subject",
    "cover subject": "Cover subject",
    "cover feature": "Cover subject",
    "cover story": "Cover subject",
    "featured game": "Cover subject",
    pages: "Page count",
    "page count": "Page count",
    extent: "Page count",
    "cataloged extent": "Page count",
    "cataloged length": "Page count",
    length: "Page count",
    artist: "Cover artist",
    "cover artist": "Cover artist",
    "artwork artist": "Cover artist",
    "cover headline": "Cover headline",
    "catalog identifier": "Catalog identifier",
    "archive identifier": "Catalog identifier",
    "library identifier": "Catalog identifier",
    "library catalog identifier": "Catalog identifier",
  };
  const canonical =
    type === "magazines" && Object.hasOwn(magazine, key)
      ? magazine[key]
      : undefined;
  const field = canonical
    ? {
        key: "detail:" + canonical.toLowerCase(),
        label: canonical,
        type: canonical === "Page count" ? "number" : "text",
      }
    : ["name", "title", "item name", "title and issue"].includes(key)
      ? { key: "model", label: "Name", type: "text" }
      : columnsForType(
          Object.hasOwn(collectionTypes, type) ? type : "items",
        ).find((c) => c.label.toLowerCase() === key) || {
          key:
            "detail:" +
            String(label || "")
              .trim()
              .toLowerCase(),
          label: String(label || "").trim(),
          type: "text",
        };
  const existing =
    columns.find((c) => c.key === field.key) ||
    columns.find((c) => c.label.toLowerCase() === field.label.toLowerCase());
  return existing
    ? {
        ...field,
        key: existing.key,
        type: field.key === "detail:publication date" ? "text" : existing.type,
      }
    : field;
}
function catalogValue(value, field) {
  let text = String(value ?? "").trim();
  if (
    field.type === "number" &&
    /^(?:width|lugWidth|lugToLug|thickness|detail:weight \(g\))$/.test(
      field.key,
    )
  )
    text = text.replace(/\s*(?:mm|g)$/i, "");
  if (
    field.key === "detail:page count" &&
    /^\d+\s*(?:pages?|pp\.?)(?:\s*\([^)]*\)\.?)?$/i.test(text)
  )
    text = text.match(/^\d+/)[0];
  // Publication dates have month/year precision; purchase dates remain exact dates.
  if (field.key === "detail:publication date") return text;
  return typedValue(text, field);
}
function catalogFields(fields, type, columns = []) {
  const out = [],
    seen = new Set();
  for (const f of fields || []) {
    const col = catalogField(f.label, type, columns);
    if (seen.has(col.key)) continue;
    seen.add(col.key);
    out.push({
      ...f,
      label: col.label,
      key: col.key,
      value: String(catalogValue(f.value, col)),
    });
  }
  return itemColumns({ type, sheetColumns: columns }, out);
}
function typedValue(value, column) {
  let text = String(value ?? "").trim();
  if (column.type === "currency") {
    text = text
      .replace(/^(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)\s*/i, "")
      .replace(/^[$€£¥]\s*/, "")
      .trim();
    if (/^[-–—]$/.test(text) && /[$€£¥]/.test(String(value))) return 0;
    if (/^\(\s*[\d,.]+\s*\)$/.test(text)) text = "-" + text.slice(1, -1).trim();
    if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text))
      text = text.replace(/,/g, "");
  }
  if (column.type === "photos")
    throw Error("Photo fields are managed by the import.");
  if (["number", "currency"].includes(column.type)) {
    if (!text) return "";
    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ||
      !Number.isFinite(Number(text))
    )
      throw new Error("Enter a number or leave blank.");
    return Number(text);
  }
  if (column.type === "date") {
    let date = text;
    if (typeof value === "number" || /^\d{5}(?:\.\d+)?$/.test(text)) {
      const time = Date.UTC(1899, 11, 30) + Number(value) * 86400000;
      if (!Number.isFinite(time) || Math.abs(time) > 8.64e15)
        throw new Error("Invalid date.");
      date = new Date(time).toISOString().slice(0, 10);
    }
    if (date && !dateOK(date))
      throw new Error("Use YYYY-MM-DD or a Sheets date cell.");
    return date;
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
  collectionTypes,
  catalogFields,
};
