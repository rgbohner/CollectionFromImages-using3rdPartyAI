#!/usr/bin/env node
/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Parses CLI commands and runs build, export or stdio MCP mode.
 * Why: Provides one executable entry point with consistent cancellation and exit codes.
 */
"use strict";

const { parseArgs } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildCollection, readState } = require("../lib/collection.cjs");
const { exportCollection } = require("../lib/spreadsheet.cjs");
const { lockOutput } = require("../lib/files.cjs");

const HELP = `CollectionFromImages-using3rdPartyAI — build a spreadsheet from photographs

Usage:
  collection-from-images-using3rdpartyai build <image-directory> [options]
  collection-from-images-using3rdpartyai export <collection.json> [--output <directory>] [--no-images]
  collection-from-images-using3rdpartyai mcp

Build options:
  -o, --output <directory>   Output folder (default: ./output)
  --recursive               Include subdirectories; skip hidden files and symlinks
  --resume                  Resume the saved scan; reuse successful requests
  --offline                 Use filenames only, with no AI requests or API key
  --provider <name>         openai or gemini (default: environment, then openai)
  --model <id>              Recognition model for quick mode
  --mode <name>             quick (default) or detailed (uses research model)
  --research <scope>        none (default), catalog, resale, or all; OpenAI only
  --research-model <id>     Model for optional research and detailed recognition
  --effort <level>          low, medium (default), high, xhigh, or max
  --search-budget <n>       3–20 web calls allocated per item (default: 4)
  --limit <n>               Process the first n images in sorted order
  -h, --help                Show help
  -v, --version             Show version

Classification uses hosted OpenAI or Google Gemini models; no custom model is bundled.
Set OPENAI_API_KEY or GEMINI_API_KEY in the environment. Images are sent to
the selected provider unless --offline is used. Research makes paid web calls.
Attributes: edit config/collection-types.json beside the app (see README).
Outputs: collection.xlsx, collection.csv, collection.json, and .images/.
Exit codes: 0 complete, 1 invalid request/fatal error, 2 partial, 130 interrupted.
`;

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      recursive: { type: "boolean" },
      resume: { type: "boolean" },
      offline: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      mode: { type: "string" },
      research: { type: "string" },
      "research-model": { type: "string" },
      effort: { type: "string" },
      "search-budget": { type: "string" },
      limit: { type: "string" },
      "no-images": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(require("../package.json").version);
    return 0;
  }
  if (values.help || !args.length) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, input] = positionals;
  if (command === "mcp") {
    if (positionals.length !== 1 || Object.keys(values).length)
      throw Error(
        "The mcp command accepts no options; configure its environment.",
      );
    await require("../lib/mcp.cjs").serve();
    return 0;
  }
  if (!["build", "export"].includes(command) || positionals.length !== 2)
    throw Error(
      "Use build <directory> or export <collection.json>. See --help.",
    );
  if (command === "export") {
    if (
      Object.keys(values).some((key) => !["output", "no-images"].includes(key))
    )
      throw Error("Export accepts only --output and --no-images.");
    const file = path.resolve(input),
      output = path.resolve(values.output ?? path.dirname(file));
    await fs.mkdir(output, { recursive: true });
    const unlock = await lockOutput(output);
    try {
      console.log(
        JSON.stringify(
          await exportCollection(await readState(file), output, {
            cacheDirectory: path.join(path.dirname(file), ".images"),
            images: !values["no-images"],
          }),
          null,
          2,
        ),
      );
    } finally {
      await unlock();
    }
    return 0;
  }
  if (values["no-images"]) throw Error("--no-images applies only to export.");
  const options = { ...values };
  if (values["research-model"] !== undefined)
    options.researchModel = values["research-model"];
  if (values["search-budget"] !== undefined)
    options.searchBudget = Number(values["search-budget"]);
  if (values.limit !== undefined) options.limit = Number(values.limit);
  const controller = new AbortController();
  const interrupt = () => {
    process.stderr.write("\nStopping and saving progress…\n");
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await buildCollection(
      input,
      { ...options, signal: controller.signal },
      { onProgress: (text) => process.stderr.write(text + "\n") },
    );
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted
      ? 130
      : result.status === "complete"
        ? 0
        : 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (require.main === module)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write("Error: " + error.message + "\n");
      process.exitCode = 1;
    });
module.exports = { main };
