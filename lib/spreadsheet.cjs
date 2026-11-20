"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { thumbnail } = require("./images.cjs");
const { atomicWrite } = require("./files.cjs");

const clean = (value) =>
  String(value ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
const cellText = (value) => clean(value).slice(0, 32767);
function csvCell(value) {
  let text = clean(value);
  // Quoting alone does not prevent spreadsheet formula execution.
  if (typeof value !== "number" && /^[\s\uFEFF]*[=+@-]/u.test(text))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function addTable(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(headers);
  for (const row of rows)
    sheet.addRow(
      row.map((value) => (typeof value === "number" ? value : cellText(value))),
    );
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEDEDED" },
  };
  sheet.getRow(1).height = 28;
  sheet.columns.forEach((column, i) => {
    column.width =
      /evidence|notes|unresolved|sources|report|photos|error/i.test(headers[i])
        ? 48
        : /name|path|value|basis/i.test(headers[i])
          ? 32
          : 22;
  });
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: headers.length },
  };
  return sheet;
}

async function exportCollection(
  state,
  output,
  { cacheDirectory, images = true } = {},
) {
  await fs.mkdir(output, { recursive: true });
  const items = state.items.filter((item) => !item.excluded);
  const observed = [
    ...new Set(items.flatMap((i) => i.fields.map((f) => f.label))),
  ].sort();
  const researched = [
    ...new Set(
      items.flatMap((i) => (i.research?.fields ?? []).map((f) => f.label)),
    ),
  ].sort();
  const headers = [
    "Preview",
    "ID",
    "Name",
    "Type",
    "Identification",
    "Photos",
    "Visible evidence",
    "Unresolved",
    "Possible same item",
    ...observed.map((l) => "Observed: " + l),
    ...researched.map((l) => "Researched: " + l),
    "Market estimate",
    "Currency",
    "Estimate basis",
    "Sources",
  ];
  const values = items.map((item) => {
    const estimate = item.research?.estimate;
    return [
      "",
      item.id,
      item.name,
      item.type,
      item.confidence === "ready" ? "Ready for review" : "Needs review",
      item.photos.map((p) => p.file).join("\n"),
      item.evidence,
      [
        ...(item.unresolved ?? []),
        ...(item.research?.report?.unresolved ?? []),
        ...(item.researchError ? [item.researchError] : []),
      ].join("\n"),
      item.possibleSameItemId ?? "",
      ...observed.map(
        (label) => item.fields.find((f) => f.label === label)?.value ?? "",
      ),
      ...researched.map(
        (label) =>
          item.research?.fields?.find((f) => f.label === label)?.value ?? "",
      ),
      estimate?.amount ?? "",
      estimate?.currency ?? "",
      estimate?.basis ?? "",
      (item.research?.sources ?? []).join("\n"),
    ];
  });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CollectionFromImages";
  const sheet = addTable(workbook, "Collection", headers, values);
  sheet.getColumn(1).width = 22;
  const warnings = [];
  if (images)
    for (let index = 0; index < items.length; index++) {
      const photo = items[index].photos[0];
      try {
        if (
          !cacheDirectory ||
          !photo ||
          !/^[a-f0-9]{24}\.jpg$/.test(photo.cache)
        )
          throw Error("No cached preview");
        const buffer = await thumbnail(
          await fs.readFile(path.join(cacheDirectory, photo.cache)),
          photo.box,
        );
        const id = workbook.addImage({ buffer, extension: "jpeg" });
        sheet.addImage(id, {
          tl: { col: 0, row: index + 1 },
          ext: { width: 144, height: 108 },
          editAs: "oneCell",
        });
        sheet.getRow(index + 2).height = 84;
      } catch {
        sheet.getCell(index + 2, 1).value = "Preview unavailable";
        warnings.push("Preview unavailable for " + items[index].id);
      }
    }
  addTable(
    workbook,
    "Photos",
    ["Path", "Status", "Error", "SHA-256"],
    state.files.map((file) => [
      file.path,
      file.status,
      file.error ?? "",
      file.hash ?? "",
    ]),
  );
  const reports = [];
  const comparables = [];
  for (const item of items) {
    for (const section of item.research?.report?.sections ?? []) {
      const text = clean(section.text);
      // Excel cells have a 32,767-character limit; retain long reports across rows.
      for (let start = 0; start < text.length; start += 30000)
        reports.push([
          item.id,
          item.name,
          section.title,
          text.slice(start, start + 30000),
          (section.citations ?? []).map((c) => c.url).join("\n"),
        ]);
    }
    if (item.research?.notes)
      reports.push([
        item.id,
        item.name,
        "Notes",
        item.research.notes,
        (item.research.sources ?? []).join("\n"),
      ]);
    for (const c of item.research?.comparables ?? [])
      comparables.push([
        item.id,
        c.kind,
        c.amount,
        c.currency,
        c.date,
        c.condition,
        c.editionMatch ? "Yes" : "No",
        c.url,
      ]);
  }
  if (reports.length)
    addTable(
      workbook,
      "Research",
      ["ID", "Name", "Section", "Report", "Sources"],
      reports,
    );
  if (comparables.length)
    addTable(
      workbook,
      "Comparables",
      [
        "ID",
        "Kind",
        "Amount",
        "Currency",
        "Date",
        "Condition",
        "Edition match",
        "Source",
      ],
      comparables,
    );
  const usage = state.usage ?? {};
  addTable(
    workbook,
    "About",
    ["Property", "Value"],
    [
      ["Collection", state.name],
      ["Run status", state.status],
      ["Source directory", state.sourceDirectory],
      ["Images", state.files.length],
      ["Included objects", items.length],
      ["Excluded objects", state.items.length - items.length],
      [
        "Recognition model",
        state.settings.researchMode === "detailed" &&
        state.settings.provider === "openai"
          ? state.settings.researchModel
          : state.settings.model,
      ],
      ["Research", state.settings.research],
      ["Input tokens", usage.input_tokens ?? 0],
      ["Output tokens", usage.output_tokens ?? 0],
      ["Estimated USD cost", usage.estimated_cost_usd ?? 0],
      [
        "Cost coverage",
        usage.cost_complete
          ? "Complete estimate; actual billing may differ"
          : "Partial estimate; charges may be missing",
      ],
      ["Pricing checked", usage.pricing_date ?? "Unknown"],
      ["Cost notes", (usage.cost_issues ?? []).join("\n")],
      [
        "Review",
        "AI identifications are proposals. Review names, editions, fields and possible duplicate views. No grade or authenticity is certified.",
      ],
      [
        "Exports",
        "CSV contains the Collection table; JSON retains the full scan, evidence and research. XLSX includes image thumbnails.",
      ],
      ["Warnings", warnings.join("\n")],
    ],
  );
  const xlsx = path.join(output, "collection.xlsx");
  const csv = path.join(output, "collection.csv");
  await atomicWrite(xlsx, Buffer.from(await workbook.xlsx.writeBuffer()));
  await atomicWrite(
    csv,
    "\uFEFF" +
      [headers.slice(1), ...values.map((row) => row.slice(1))]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n") +
      "\r\n",
  );
  return { xlsx, csv, warnings };
}

module.exports = { exportCollection, csvCell };
