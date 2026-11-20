/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Tests configurable recognition, aliases, required attributes, research, export types and resume compatibility.
 * Why: Protects the shared configuration contract using offline fixtures and mocked providers.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const {
  loadCollectionTypes,
  validateCollectionTypes,
} = require("../lib/collection-types.cjs");
const { buildCollection, readState } = require("../lib/collection.cjs");
const { identifyPhoto, researchItem } = require("../lib/photo-recognition.cjs");
const { exportCollection } = require("../lib/spreadsheet.cjs");

const image = "data:image/jpeg;base64,/9j/";
const comic = {
  name: "Example Adventures 007",
  type: "comic",
  confidence: "ready",
  evidence: "The title and issue are readable.",
  box: [0, 0, 1, 1],
  sameItemId: "",
  fields: [
    { label: "Series", value: "Example Adventures" },
    { label: "Writer", value: "Example Author" },
    { label: "Date", value: "June 1984" },
    { label: "Issue", value: "007" },
    { label: "Publication year", value: "1984" },
    { label: "Visible marking", value: "=1+1" },
  ],
};
const response = (data, sources = []) => ({
  ok: true,
  text: async () =>
    JSON.stringify({
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10 },
      output: [
        ...sources.map((url) => ({
          type: "web_search_call",
          action: { sources: [{ url }] },
        })),
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: typeof data === "string" ? data : JSON.stringify(data),
            },
          ],
        },
      ],
    }),
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-types-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "photos");
  await fs.mkdir(input);
  await fs.copyFile(
    path.join(__dirname, "../examples/sample.heic"),
    path.join(input, "comic.heic"),
  );
  return { root, input, output: path.join(root, "output") };
}

async function table(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Collection");
  const headers = sheet.getRow(1).values;
  return {
    headers,
    cell: (header, row = 2) =>
      sheet.getCell(row, headers.indexOf(header)).value,
  };
}

test("comic configuration reaches recognition and ordered XLSX/CSV columns, including unreadable fields", async (t) => {
  const f = await fixture(t);
  const result = await buildCollection(
    f.input,
    { output: f.output },
    {
      env: { OPENAI_API_KEY: "test" },
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        const definitions = JSON.parse(
          body.input[0].content[0].text,
        ).collectionTypes;
        assert.deepEqual(
          definitions.comic.attributes.slice(0, 5).map((a) => a.label),
          ["Series", "Publisher", "Publication date", "Author", "Issue number"],
        );
        assert.deepEqual(
          body.text.format.schema.properties.items.items.properties.type.enum,
          Object.keys(definitions),
        );
        return response({ items: [comic] });
      },
    },
  );
  const state = await readState(result.stateFile);
  assert.equal(state.items[0].confidence, "ready");
  assert.equal(
    state.items[0].fields.find((f) => f.label === "Author").value,
    "Example Author",
  );
  assert.deepEqual(state.collectionTypes, loadCollectionTypes());
  const { headers, cell } = await table(result.xlsx);
  const expected = state.collectionTypes.types.comic.attributes.map(
    (a) => "Observed: " + a.label,
  );
  assert.deepEqual(headers.slice(10, 10 + expected.length), expected);
  assert.equal(cell("Observed: Publisher"), "");
  assert.equal(cell("Observed: Issue number"), "007");
  assert.equal(cell("Observed: Publication date"), "June 1984");
  assert.equal(cell("Observed: Publication year"), 1984);
  assert.equal(cell("Observed: Visible marking"), "=1+1");
  const csv = await fs.readFile(result.csv, "utf8");
  assert.ok(
    csv
      .split("\r\n")[0]
      .includes(expected.map((label) => '"' + label + '"').join(",")),
  );
  assert.match(csv, /"007"/);
  assert.match(csv, /"'=1\+1"/);
  assert.equal(
    headers.some((header) => header.startsWith("Researched:")),
    false,
  );
});

test("a new collection type guides the prompt, canonicalizes aliases and requires missing attributes", async () => {
  const configuration = loadCollectionTypes();
  configuration.types.stamps = {
    label: "Postage stamps",
    attributes: [
      {
        label: "Catalog number",
        type: "text",
        aliases: ["Stamp ID"],
        required: true,
      },
      {
        label: "Designer",
        type: "text",
        required: true,
        description: "Read printed designer credits.",
      },
      { label: "Perforation", type: "number" },
    ],
  };
  const result = await identifyPhoto(
    { image },
    {
      apiKey: "test",
      collectionTypes: configuration,
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        assert.ok(
          body.text.format.schema.properties.items.items.properties.type.enum.includes(
            "stamps",
          ),
        );
        assert.equal(
          JSON.parse(body.input[0].content[0].text).collectionTypes.stamps
            .attributes[1].description,
          "Read printed designer credits.",
        );
        return response({
          items: [
            {
              ...comic,
              type: "stamps",
              fields: [
                { label: "Stamp ID", value: "0008a" },
                { label: "Perforation", value: "unknown" },
              ],
            },
          ],
        });
      },
    },
  );
  assert.equal(result.items[0].fields[0].label, "Catalog number");
  assert.equal(result.items[0].fields[0].value, "0008a");
  assert.equal(result.items[0].confidence, "review");
  assert.ok(
    result.items[0].unresolved.some((message) => message.includes("Designer")),
  );
  assert.ok(
    result.items[0].unresolved.some((message) =>
      message.includes("Perforation"),
    ),
  );
});

test("research and its required-field follow-up use the configured checklist and aliases", async () => {
  const configuration = loadCollectionTypes();
  configuration.types.comic.attributes = [
    { label: "Author", type: "text", aliases: ["Writer"], required: true },
    { label: "Letterer", type: "text", required: true },
  ];
  const source = "https://example.com/comic";
  let searches = 0,
    structures = 0;
  const result = await researchItem(
    { item: comic, catalog: true, resale: false },
    {
      apiKey: "test",
      collectionTypes: configuration,
      researchMode: "quick",
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        const context = body.tools
          ? JSON.parse(body.input[0].content[0].text)
          : JSON.parse(body.input);
        assert.deepEqual(
          context.requestedAttributes,
          configuration.types.comic.attributes,
        );
        if (body.tools) {
          searches++;
          if (searches === 2) assert.match(body.instructions, /Letterer/);
          return response(
            "The writer is Example Author. No letterer was verified.",
            [source],
          );
        }
        structures++;
        return response({
          fields: [{ label: "Writer", value: "Example Author", url: source }],
          comparables: [],
          condition: "",
          confidence: "high",
          notes: "",
          unresolved: [],
        });
      },
    },
  );
  assert.equal(searches, 2);
  assert.equal(structures, 2);
  assert.equal(result.fields[0].label, "Author");
  assert.ok(
    result.report.unresolved.includes("Letterer could not be verified."),
  );
  assert.equal(result.confidence, "low");
});

test("invalid configuration is rejected before creating output or calling a provider", async (t) => {
  const f = await fixture(t);
  const invalid = loadCollectionTypes();
  invalid.types.comic.attributes.push({ label: "Writer", type: "text" });
  let called = false;
  const dependencies = {
    collectionTypes: invalid,
    env: { OPENAI_API_KEY: "test" },
    fetchImpl: async () => {
      called = true;
      throw Error("must not call");
    },
  };
  await assert.rejects(
    buildCollection(f.input, { output: f.output }, dependencies),
    /duplicate label or alias Writer/,
  );
  await assert.rejects(
    identifyPhoto(
      { image },
      { collectionTypes: invalid, fetchImpl: dependencies.fetchImpl },
    ),
    /duplicate label/,
  );
  await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  assert.equal(called, false);
  for (const mutate of [
    (c) => {
      delete c.types.items;
    },
    (c) => {
      c.types.comic.attributes[0].type = "date-ish";
    },
    (c) => {
      c.types.comic.attributes[0].required = "yes";
    },
    (c) => {
      c.types.comic.attributes[0].requireded = true;
    },
  ]) {
    const config = loadCollectionTypes();
    mutate(config);
    assert.throws(
      () => validateCollectionTypes(config),
      /Invalid collection-types/,
    );
  }
  const file = path.join(f.root, "bad.json");
  await fs.writeFile(file, "{ /* comments are not JSON */ }");
  assert.throws(
    () => loadCollectionTypes(file),
    /Cannot read collection-types/,
  );
});

test("config edits prevent mixed resume while export uses new columns without changing saved evidence", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const dependencies = {
    env: { OPENAI_API_KEY: "test" },
    fetchImpl: async () => {
      calls++;
      return response({ items: [comic] });
    },
  };
  const result = await buildCollection(
    f.input,
    { output: f.output },
    dependencies,
  );
  const original = await fs.readFile(result.stateFile, "utf8");
  const changed = loadCollectionTypes();
  changed.types.comic.attributes = [
    { label: "Writer credit", type: "text", aliases: ["Author", "Writer"] },
    { label: "Letterer", type: "text" },
  ];
  await assert.rejects(
    buildCollection(
      f.input,
      { output: f.output, resume: true },
      { ...dependencies, collectionTypes: changed },
    ),
    /configuration changed/,
  );
  assert.equal(calls, 1);
  const exported = await exportCollection(
    await readState(result.stateFile),
    path.join(f.root, "export"),
    { images: false, collectionTypes: changed },
  );
  const { headers, cell } = await table(exported.xlsx);
  assert.deepEqual(headers.slice(10, 12), [
    "Observed: Writer credit",
    "Observed: Letterer",
  ]);
  assert.equal(cell("Observed: Writer credit"), "Example Author");
  assert.equal(cell("Observed: Letterer"), "");
  assert.equal(cell("Observed: Issue number"), "007");
  assert.equal(await fs.readFile(result.stateFile, "utf8"), original);
  const legacy = JSON.parse(original);
  delete legacy.collectionTypes;
  await fs.writeFile(result.stateFile, JSON.stringify(legacy));
  await assert.rejects(
    buildCollection(f.input, { output: f.output, resume: true }, dependencies),
    /predates configurable attributes/,
  );
  await exportCollection(legacy, path.join(f.root, "legacy"), {
    images: false,
  });
  assert.equal(calls, 1);
});

test("typed export keeps invalid old values as text, blank configured columns and separate research columns", async (t) => {
  const f = await fixture(t);
  const configuration = {
    version: 1,
    types: {
      items: {
        label: "Items",
        attributes: [
          { label: "Count", type: "number" },
          { label: "Signed", type: "boolean" },
          { label: "Issue date", type: "date" },
          { label: "Missing", type: "text" },
        ],
      },
    },
  };
  const state = {
    name: "Example",
    files: [],
    settings: { research: "catalog" },
    items: [
      {
        id: "example",
        name: "Example",
        type: "items",
        photos: [],
        fields: [
          { label: "Count", value: "unknown" },
          { label: "Signed", value: "yes" },
          { label: "Issue date", value: "2026-11-20" },
        ],
        research: { fields: [{ label: "Count", value: "2" }] },
      },
    ],
  };
  const result = await exportCollection(state, f.output, {
    images: false,
    collectionTypes: configuration,
  });
  const { cell } = await table(result.xlsx);
  assert.equal(cell("Observed: Count"), "unknown");
  assert.equal(cell("Observed: Signed"), true);
  assert.equal(cell("Observed: Issue date"), "2026-11-20");
  assert.equal(cell("Observed: Missing"), "");
  assert.equal(cell("Researched: Count"), 2);
  assert.equal(cell("Researched: Missing"), "");
  assert.ok(result.warnings.some((warning) => warning.includes("Count")));
});

test("export preserves conflicting false/zero evidence and obeys configured text/date types", async (t) => {
  const f = await fixture(t);
  const config = {
    version: 1,
    types: {
      items: {
        label: "Items",
        attributes: [
          { label: "Signed", type: "boolean" },
          { label: "Count", type: "number" },
          { label: "Page count", type: "text" },
          { label: "Date", type: "date" },
        ],
      },
    },
  };
  const state = {
    files: [],
    settings: {},
    items: [
      {
        id: "x",
        name: "x",
        type: "items",
        photos: [],
        fields: [
          { label: "Signed", value: "false" },
          { label: "Signed", value: "true" },
          { label: "Count", value: "0" },
          { label: "Count", value: "2" },
          { label: "Page count", value: "52 pages" },
          { label: "Date", value: "45616" },
        ],
      },
    ],
  };
  const exported = await exportCollection(state, f.output, {
    images: false,
    collectionTypes: config,
  });
  const { cell } = await table(exported.xlsx);
  assert.equal(cell("Observed: Signed"), "false\ntrue");
  assert.equal(cell("Observed: Count"), "0\n2");
  assert.equal(cell("Observed: Page count"), "52 pages");
  assert.equal(cell("Observed: Date"), "45616");
  assert.equal(exported.warnings.length, 3);
});
