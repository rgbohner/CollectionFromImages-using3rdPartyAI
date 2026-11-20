"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  identifyPhoto,
  researchItem,
  valuation,
} = require("../lib/photo-recognition.cjs");
const { settingsFor } = require("../lib/collection.cjs");
const image = "data:image/jpeg;base64,/9j/";
const item = {
  name: "Magazine",
  type: "magazines",
  confidence: "ready",
  evidence: "Readable cover",
  fields: [
    { label: "Magazine name", value: "Example" },
    { label: "Issue number", value: "007" },
    { label: "Cover date", value: "June 1984" },
    { label: "Price", value: "100" },
  ],
  box: [0, 0, 1, 1],
  sameItemId: "invented",
};
const response = (output) => ({
  ok: true,
  text: async () =>
    JSON.stringify({
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10 },
      output,
    }),
});
const message = (text) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});

test("extracted catalog normalization preserves issue zeros and partial dates; removes inferred prices", async () => {
  const result = await identifyPhoto(
    { image },
    {
      apiKey: "test",
      researchMode: "quick",
      fetchImpl: async () =>
        response([message(JSON.stringify({ items: [item] }))]),
    },
  );
  assert.equal(result.items[0].sameItemId, "");
  assert.deepEqual(
    result.items[0].fields.map((f) => [f.label, f.value]),
    [
      ["Publication", "Example"],
      ["Issue", "007"],
      ["Publication date", "June 1984"],
    ],
  );
  assert.equal(result.items[0].confidence, "ready");
});

test("unreadable identity and unsafe catalog conversions require review", async () => {
  const result = await identifyPhoto(
    { image },
    {
      apiKey: "test",
      fetchImpl: async () =>
        response([
          message(
            JSON.stringify({
              items: [
                { ...item, fields: [{ label: "Pages", value: "about fifty" }] },
              ],
            }),
          ),
        ]),
    },
  );
  assert.equal(result.items[0].confidence, "review");
  assert.ok(result.items[0].unresolved.length >= 3);
  await assert.rejects(
    identifyPhoto(
      { image },
      {
        apiKey: "test",
        fetchImpl: async () =>
          response([
            message(
              JSON.stringify({ items: [{ ...item, box: [0.9, 0, 0.2, 1] }] }),
            ),
          ]),
      },
    ),
    /bounds/,
  );
});

test("research retains cited sources and rejects invented field URLs and unsupported sales", async () => {
  let calls = 0;
  const url = "https://example.com/catalog";
  const result = await researchItem(
    { item: { ...item, type: "coin" }, catalog: true, resale: false },
    {
      apiKey: "test",
      researchMode: "quick",
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        assert.equal(body.store, false);
        calls++;
        if (body.tools)
          return response([
            { type: "web_search_call", action: { sources: [{ url }] } },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Verified catalog.",
                  annotations: [
                    {
                      type: "url_citation",
                      url,
                      title: "Catalog",
                      start_index: 0,
                      end_index: 8,
                    },
                  ],
                },
              ],
            },
          ]);
        return response([
          message(
            JSON.stringify({
              fields: [
                { label: "Maker", value: "Verified", url },
                {
                  label: "Edition",
                  value: "Invented",
                  url: "https://invented.test",
                },
              ],
              comparables: [],
              condition: "",
              confidence: "high",
              notes: "Source checked",
              unresolved: [],
            }),
          ),
        ]);
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.fields.length, 1);
  assert.equal(result.report.sections[0].citations[0].url, url);
  assert.equal(result.estimate, null);
});

test("valuation uses exact-edition recent sales, never asking prices", () => {
  const sale = (amount, n, extra = {}) => ({
    amount,
    currency: "USD",
    date: "2026-10-01",
    condition: "Used",
    editionMatch: true,
    kind: "sold",
    url: "https://example.com/" + n,
    ...extra,
  });
  assert.equal(
    valuation(
      [sale(10, 1), sale(30, 2), sale(20, 3), sale(999, 4, { kind: "asking" })],
      "2026-11-20",
    ).amount,
    20,
  );
  assert.equal(
    valuation(
      [sale(10, 1), sale(20, 1), sale(100, 3, { date: "2025-01-01" })],
      "2026-11-20",
    ),
    null,
  );
});

test("provider and model configuration stays portable", async () => {
  const config = settingsFor({ provider: "gemini" }, {});
  assert.equal(config.provider, "gemini");
  assert.ok(config.model.startsWith("gemini-"));
  assert.throws(
    () => settingsFor({ provider: "gemini", research: "all" }, {}),
    /OpenAI/,
  );
  assert.throws(
    () => settingsFor({ offline: true, research: "catalog" }, {}),
    /Offline/,
  );
  assert.throws(() => settingsFor({ searchBudget: 21 }, {}), /budget/);
});
