/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Runs local sample collections through the existing CLI.
 * Why: Gives each sample portable defaults and requires an explicit provider for paid recognition.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function runSample(
  sample,
  args = process.argv.slice(2),
  dependencies = {},
) {
  const root = dependencies.root ?? path.resolve(__dirname, "..");
  const [mode = "offline", ...options] = args;
  if (["--help", "-h"].includes(mode)) {
    console.log(`Usage: node examples/run-${sample}.cjs [offline|openai|gemini] [build options]

Default: offline (filenames only, no API requests).
OpenAI/Gemini modes send images to the selected provider and may incur charges.
Credentials: process environment or the checkout's local .env file.
Input: sample-data/${sample}/ relative to the checkout, regardless of current directory.
Output: output/samples/${sample}-<mode>/; override with --output <directory>.
Build options include --limit 3, --resume, --model <id>, and --research <scope>.
For all build options: node bin/collection-from-images.cjs --help`);
    return 0;
  }
  if (!["offline", "openai", "gemini"].includes(mode)) {
    throw Error("Choose offline, openai or gemini; see --help.");
  }
  if (options.some((arg) => /^--(?:provider|offline)(?:=|$)/.test(arg))) {
    throw Error(
      "Select the provider using the offline, openai or gemini argument.",
    );
  }
  const input = path.join(root, "sample-data", sample);
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) {
    throw Error(
      `Sample images are missing. Place them in ${input}. See README: Sample collections.`,
    );
  }
  const envFile = path.join(root, ".env");
  if (mode !== "offline" && fs.existsSync(envFile)) {
    (dependencies.loadEnvFile ?? process.loadEnvFile)(envFile);
  }
  const main =
    dependencies.main ?? require("../bin/collection-from-images.cjs").main;
  return main([
    "build",
    input,
    "--recursive",
    "--research",
    "none",
    "--output",
    path.join(root, "output", "samples", `${sample}-${mode}`),
    ...(mode === "offline" ? ["--offline"] : ["--provider", mode]),
    ...options,
  ]);
}

function entry(sample) {
  runSample(sample)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("Error: " + error.message);
      process.exitCode = 1;
    });
}

module.exports = { runSample, entry };
