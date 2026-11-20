/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Tests the image-to-spreadsheet pipeline, state handling, CLI and image processing.
 * Why: Checks real file and workbook behavior without paid API requests or personal data.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const { buildCollection, readState } = require("../lib/collection.cjs");
const { exportCollection } = require("../lib/spreadsheet.cjs");
const { scanImages, prepareImage, thumbnail } = require("../lib/images.cjs");
const { lockOutput } = require("../lib/files.cjs");

const exec = promisify(execFile);
const cli = path.resolve(__dirname, "../bin/collection-from-images.cjs");
const detection = (extra = {}) => ({
  name: "Example coin",
  type: "coin",
  confidence: "ready",
  evidence: "The marking 001 is visible.",
  box: [0, 0, 1, 1],
  fields: [{ label: "Serial number", value: "001" }],
  sameItemId: "",
  ...extra,
});
const reply = (items) => ({
  ok: true,
  text: async () =>
    JSON.stringify({
      status: "completed",
      model: "gpt-4.1-mini",
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ items }) }],
        },
      ],
    }),
});

async function fixture(t, names = ["a.jpg", "b.png"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "photos"),
    output = path.join(root, "result");
  await fs.mkdir(input);
  for (const name of names) {
    const file = path.join(input, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#7a963b" },
    })
      .toFormat(path.extname(name) === ".png" ? "png" : "jpeg")
      .toFile(file);
  }
  return { root, input, output };
}

test("folder -> actual AI transport -> workbook, CSV and evidence JSON; resume skips paid successes", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const dependencies = {
    env: { OPENAI_API_KEY: "private-test-key" },
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(request.body);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.model, "gpt-4.1-mini");
      assert.ok(
        body.input[0].content.some((part) => part.type === "input_image"),
      );
      const previous = JSON.parse(body.input[0].content[0].text).previous;
      return reply([
        detection({ name: "=1+1", sameItemId: previous[0]?.id ?? "" }),
      ]);
    },
  };
  const result = await buildCollection(
    f.input,
    { output: f.output },
    dependencies,
  );
  assert.equal(result.status, "complete");
  assert.equal(result.items, 2);
  assert.equal(calls, 2);
  const state = await readState(result.stateFile);
  assert.equal(state.items[1].possibleSameItemId, state.items[0].id);
  assert.equal(state.items[0].fields[0].value, "001");
  assert.equal(JSON.stringify(state).includes("private-test-key"), false);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.xlsx);
  const sheet = workbook.getWorksheet("Collection");
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getImages().length, 2);
  assert.equal(sheet.getCell("C2").value, "=1+1");
  assert.equal(sheet.getCell("C2").type, ExcelJS.ValueType.String);
  assert.equal(
    sheet.getCell(2, sheet.getRow(1).values.indexOf("Observed: Serial number"))
      .value,
    "001",
  );
  assert.equal(sheet.views[0].ySplit, 1);
  assert.match(await fs.readFile(result.csv, "utf8"), /"'=1\+1"/);
  assert.equal(workbook.getWorksheet("Photos").rowCount, 3);
  await buildCollection(
    f.input,
    { output: f.output, resume: true },
    dependencies,
  );
  assert.equal(calls, 2);
});

test("corrupt and unidentified photos stay accounted for; no silent lost images", async (t) => {
  const f = await fixture(t, ["good.jpg"]);
  await fs.writeFile(path.join(f.input, "bad.jpg"), "not an image");
  const result = await buildCollection(
    f.input,
    { output: f.output },
    { env: { OPENAI_API_KEY: "test" }, fetchImpl: async () => reply([]) },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.images, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.items, 1);
  const state = await readState(result.stateFile);
  assert.equal(state.files[0].status, "failed");
  assert.ok(state.files[0].error);
  assert.equal(state.files[1].status, "unidentified");
  assert.match(state.items[0].name, /Unidentified/);
});

test("quota failures stop the run and resume retries only unfinished work", async (t) => {
  const f = await fixture(t, ["a.jpg", "b.jpg", "c.jpg"]);
  let calls = 0;
  const dependencies = {
    env: { OPENAI_API_KEY: "test" },
    fetchImpl: async () =>
      ++calls === 2
        ? {
            ok: false,
            status: 429,
            text: async () =>
              JSON.stringify({ error: { code: "insufficient_quota" } }),
          }
        : reply([detection()]),
  };
  const first = await buildCollection(
    f.input,
    { output: f.output },
    dependencies,
  );
  assert.equal(first.status, "interrupted");
  assert.equal(calls, 2);
  assert.equal(first.usage.cost_complete, false);
  assert.deepEqual(
    (await readState(first.stateFile)).files.map((f) => f.status),
    ["done", "failed", "pending"],
  );
  const resumed = await buildCollection(
    f.input,
    { output: f.output, resume: true },
    dependencies,
  );
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.items, 3);
  assert.equal(calls, 4);
});

test("changed source and analysis options fail before spending on a resumed scan", async (t) => {
  const f = await fixture(t, ["a.jpg"]);
  await buildCollection(f.input, { output: f.output, offline: true });
  await assert.rejects(
    buildCollection(f.input, {
      output: f.output,
      resume: true,
      mode: "detailed",
    }),
    /same directory and analysis options/,
  );
  await fs.appendFile(path.join(f.input, "a.jpg"), "changed");
  await assert.rejects(
    buildCollection(f.input, { output: f.output, resume: true }),
    /Image changed/,
  );
  await assert.rejects(
    buildCollection(f.input, { output: f.output, offline: true }),
    /already contains/,
  );
});

test("abort saves progress and JSON edits re-export without AI", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await buildCollection(
    f.input,
    { output: f.output, signal: controller.signal },
    {
      env: { OPENAI_API_KEY: "test" },
      identify: async () => {
        controller.abort();
        return { items: [detection()] };
      },
    },
  );
  assert.equal(result.status, "interrupted");
  assert.equal(result.items, 1);
  const state = await readState(result.stateFile);
  state.items[0].name = "Human correction";
  state.items[0].fields.push({ label: "Note", value: "@untrusted" });
  await fs.writeFile(result.stateFile, JSON.stringify(state));
  const exported = await exec(process.execPath, [
    cli,
    "export",
    result.stateFile,
    "--no-images",
  ]);
  const info = JSON.parse(exported.stdout);
  assert.match(await fs.readFile(info.csv, "utf8"), /Human correction/);
  assert.match(await fs.readFile(info.csv, "utf8"), /'@untrusted/);
  state.items[0].excluded = true;
  const removed = await exportCollection(state, f.output, { images: false });
  assert.equal(
    (await fs.readFile(removed.csv, "utf8")).split("\r\n").length,
    2,
  );
});

test("recursive discovery skips hidden files, symlinks, and generated output", async (t) => {
  const f = await fixture(t, ["a.jpg", ".hidden.jpg", "nested/b.png"]);
  assert.deepEqual((await scanImages(f.input)).files, ["a.jpg"]);
  assert.deepEqual((await scanImages(f.input, { recursive: true })).files, [
    "a.jpg",
    path.join("nested", "b.png"),
  ]);
  if (process.platform !== "win32") {
    await fs.symlink(f.input, path.join(f.input, "loop"));
    await fs.symlink(
      path.join(f.input, "a.jpg"),
      path.join(f.input, "linked.jpg"),
    );
    assert.equal(
      (await scanImages(f.input, { recursive: true })).files.length,
      2,
    );
  }
  const result = await buildCollection(f.input, {
    output: path.join(f.input, "result"),
    recursive: true,
    offline: true,
  });
  const again = await buildCollection(f.input, {
    output: result.output,
    resume: true,
  });
  assert.equal(again.images, 2);
});

test("CLI works without credentials offline, rejects bad options and returns partial exit code", async (t) => {
  const f = await fixture(t, ["item.jpg"]);
  const result = await exec(process.execPath, [
    cli,
    "build",
    f.input,
    "-o",
    f.output,
    "--offline",
  ]);
  assert.equal(JSON.parse(result.stdout).items, 1);
  assert.match(result.stderr, /Recognizing/);
  const help = await exec(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /--resume/);
  await assert.rejects(
    exec(process.execPath, [
      cli,
      "build",
      f.input,
      "--limit",
      "0",
      "-o",
      path.join(f.root, "bad"),
    ]),
    (error) => error.code === 1 && /Limit/.test(error.stderr),
  );
  await fs.writeFile(path.join(f.input, "corrupt.png"), "bad");
  await assert.rejects(
    exec(process.execPath, [
      cli,
      "build",
      f.input,
      "--offline",
      "-o",
      path.join(f.root, "partial"),
    ]),
    (error) => error.code === 2 && JSON.parse(error.stdout).failed === 1,
  );
});

test("output locking and validation prevent concurrent writes and accidental source replacement", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  const unlock = await lockOutput(f.output);
  await assert.rejects(
    buildCollection(f.input, { output: f.output, offline: true }),
    /locked/,
  );
  await unlock();
  await assert.rejects(
    buildCollection(f.input, { output: f.input, offline: true }),
    /must differ/,
  );
  await assert.rejects(
    buildCollection(f.input, { output: f.output }, { env: {} }),
    /OPENAI_API_KEY|GEMINI_API_KEY/,
  );
  await assert.rejects(fs.access(path.join(f.output, ".collection.lock")));
});

test("HEIC phone photos decode using the included converter", async () => {
  const input = await fs.readFile(
    path.join(__dirname, "../examples/sample.heic"),
  );
  const preview = await prepareImage(input, "sample.HEIC");
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 48);
});

test("new scans refuse to overwrite unrelated spreadsheet files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  const file = path.join(f.output, "collection.xlsx");
  await fs.writeFile(file, "existing workbook");
  await assert.rejects(
    buildCollection(f.input, { output: f.output, offline: true }),
    /already contains collection.xlsx/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "existing workbook");
});

test("normalization rotates, scales and crops without distorting the original", async () => {
  const original = await sharp({
    create: { width: 3000, height: 1000, channels: 3, background: "#aaaaaa" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const normalized = await prepareImage(original, "large.jpg");
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.height, 2560);
  assert.ok(metadata.width < metadata.height);
  assert.equal(metadata.orientation, undefined);
  const cropped = await sharp(
    await thumbnail(normalized, [0.1, 0.1, 0.6, 0.6]),
  ).metadata();
  assert.equal(cropped.width, 144);
  assert.equal(cropped.height, 108);
  await assert.rejects(thumbnail(normalized, [1, 0, 0, 1]), /bounds/);
});

test("long research stays in separate rows and valuations retain currency and source context", async (t) => {
  const f = await fixture(t, ["a.jpg"]);
  const result = await buildCollection(
    f.input,
    { output: f.output, research: "all" },
    {
      env: { OPENAI_API_KEY: "test" },
      identify: async () => ({ items: [detection()] }),
      research: async () => ({
        fields: [
          {
            label: "Maker",
            value: "Verified mint",
            url: "https://example.com/catalog",
          },
        ],
        estimate: {
          amount: 25,
          currency: "EUR",
          basis: "Median of 3 comparable reported sales",
        },
        sources: ["https://example.com/catalog"],
        report: {
          sections: [
            { title: "History", text: "a".repeat(60001), citations: [] },
          ],
          unresolved: [],
        },
        comparables: [
          {
            kind: "asking",
            amount: 50,
            currency: "USD",
            date: "2026-01-01",
            condition: "",
            editionMatch: true,
            url: "https://example.com/listing",
          },
        ],
      }),
    },
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.xlsx);
  assert.equal(workbook.getWorksheet("Research").rowCount, 4);
  assert.equal(
    workbook.getWorksheet("Comparables").getCell("B2").value,
    "asking",
  );
  const headers = workbook.getWorksheet("Collection").getRow(1).values;
  assert.equal(
    workbook
      .getWorksheet("Collection")
      .getCell(2, headers.indexOf("Market estimate")).value,
    25,
  );
  assert.equal(
    workbook.getWorksheet("Collection").getCell(2, headers.indexOf("Currency"))
      .value,
    "EUR",
  );
});
