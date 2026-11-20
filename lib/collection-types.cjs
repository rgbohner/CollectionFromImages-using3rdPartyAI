/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Loads and validates the editable collection-type configuration and resolves attribute requirements.
 * Why: Gives each operation one validated snapshot and rejects ambiguous or malformed definitions.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const CONFIG_FILE = path.resolve(__dirname, "../config/collection-types.json");
const fieldKey = (label) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, " ");
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validateCollectionTypes(value) {
  const fail = (message) => {
    throw Error("Invalid collection-types configuration: " + message);
  };
  const keys = (object, allowed, location) => {
    if (!plain(object)) fail(location + " must be an object.");
    for (const key of Object.keys(object))
      if (!allowed.includes(key))
        fail(location + ": unknown property " + key + ".");
  };
  const text = (value, max, location) => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value !== value.trim() ||
      value.length > max ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      fail(
        location +
          " must be nonempty text, trimmed, at most " +
          max +
          " characters.",
      );
  };
  keys(value, ["version", "types"], "configuration");
  if (value.version !== 1) fail("version must be 1.");
  if (!plain(value.types) || !Object.hasOwn(value.types, "items"))
    fail("types must include the items fallback.");
  if (Object.keys(value.types).length > 30)
    fail("at most 30 collection types are supported.");
  for (const [id, definition] of Object.entries(value.types)) {
    if (
      !/^[a-z][a-z0-9_-]{0,39}$/.test(id) ||
      ["constructor", "prototype", "__proto__"].includes(id)
    )
      fail("invalid collection type ID: " + id);
    keys(definition, ["label", "attributes"], id);
    text(definition.label, 80, id + ".label");
    if (
      !Array.isArray(definition.attributes) ||
      definition.attributes.length > 40
    )
      fail(id + ".attributes must be an array of at most 40 attributes.");
    const seen = new Set();
    for (const attribute of definition.attributes) {
      keys(
        attribute,
        ["label", "type", "aliases", "description", "required"],
        id + " attribute",
      );
      text(attribute.label, 80, id + " attribute label");
      if (
        !["text", "number", "date", "boolean", "url"].includes(attribute.type)
      )
        fail(
          id +
            "." +
            attribute.label +
            ": type must be text, number, date, boolean or url.",
        );
      if (
        attribute.required !== undefined &&
        typeof attribute.required !== "boolean"
      )
        fail(id + "." + attribute.label + ": required must be boolean.");
      if (attribute.description !== undefined)
        text(
          attribute.description,
          500,
          id + "." + attribute.label + ".description",
        );
      if (
        attribute.aliases !== undefined &&
        (!Array.isArray(attribute.aliases) || attribute.aliases.length > 20)
      )
        fail(
          id +
            "." +
            attribute.label +
            ": aliases must be an array of at most 20 labels.",
        );
      for (const label of [attribute.label, ...(attribute.aliases ?? [])]) {
        text(label, 80, id + " label/alias");
        const key = fieldKey(label);
        if (seen.has(key))
          fail(id + ": duplicate label or alias " + label + ".");
        seen.add(key);
      }
    }
  }
  // Snapshot caller-owned objects so a run cannot change under a pending request.
  return JSON.parse(JSON.stringify(value));
}

function loadCollectionTypes(file = CONFIG_FILE) {
  let value;
  try {
    if (fs.statSync(file).size > 256 * 1024)
      throw Error("file exceeds 256 KiB");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw Error(
      "Cannot read collection-types configuration at " +
        file +
        ": " +
        error.message,
    );
  }
  return validateCollectionTypes(value);
}

function attributesFor(configuration, type) {
  return (
    Object.hasOwn(configuration.types, type)
      ? configuration.types[type]
      : configuration.types.items
  ).attributes;
}

function missingRequired(configuration, type, fields) {
  return attributesFor(configuration, type)
    .filter(
      (attribute) =>
        attribute.required &&
        !fields.some(
          (field) =>
            field.label === attribute.label && String(field.value ?? "").trim(),
        ),
    )
    .map((attribute) => attribute.label);
}

module.exports = {
  CONFIG_FILE,
  loadCollectionTypes,
  validateCollectionTypes,
  attributesFor,
  missingRequired,
  fieldKey,
};
