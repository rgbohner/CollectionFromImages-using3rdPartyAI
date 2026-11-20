/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Coordinates image scans, recognition, research, resumable state and spreadsheet export.
 * Why: Preserves progress and evidence while checking sources, settings and configuration before resuming.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { scanImages, readSource, prepareImage } = require("./images.cjs");
const { atomicWrite, lockOutput } = require("./files.cjs");
const { identifyPhoto, researchItem } = require("./photo-recognition.cjs");
const { environment, modelId, providerId } = require("./ai-provider.cjs");
const { researchProfile } = require("./research-profile.cjs");
const { emptyUsage, addUsage } = require("./ai-usage.cjs");

const {
  loadCollectionTypes,
  validateCollectionTypes,
} = require("./collection-types.cjs");

const STATE_FILE = "collection.json";
const hash = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
const dataURL = (bytes) => "data:image/jpeg;base64," + bytes.toString("base64");

function settingsFor(options, env, saved = {}) {
  const provider = providerId(
    options.provider ?? saved.provider ?? environment(env).provider,
  );
  const defaults = environment(env, provider);
  const settings = {
    provider,
    model: options.model ?? saved.model ?? defaults.model,
    researchModel:
      options.researchModel ?? saved.researchModel ?? defaults.researchModel,
    researchMode: options.mode ?? saved.researchMode ?? "quick",
    researchEffort: options.effort ?? saved.researchEffort ?? "medium",
    researchToolBudget: options.searchBudget ?? saved.researchToolBudget ?? 4,
    research: options.research ?? saved.research ?? "none",
    recursive: options.recursive ?? saved.recursive ?? false,
    offline: options.offline ?? saved.offline ?? false,
    limit: options.limit ?? saved.limit ?? null,
  };
  modelId(provider, settings.model);
  modelId(provider, settings.researchModel);
  if (!["quick", "detailed"].includes(settings.researchMode))
    throw Error("Mode must be quick or detailed.");
  if (!["none", "catalog", "resale", "all"].includes(settings.research))
    throw Error("Research must be none, catalog, resale, or all.");
  if (
    settings.limit !== null &&
    (!Number.isInteger(settings.limit) ||
      settings.limit < 1 ||
      settings.limit > 10000)
  )
    throw Error("Limit must be an integer from 1 to 10,000.");
  if (settings.offline && settings.research !== "none")
    throw Error("Offline mode cannot perform research.");
  if (provider === "gemini" && settings.research !== "none")
    throw Error("Web research requires OpenAI.");
  researchProfile(settings);
  return settings;
}

async function readState(file) {
  const stat = await fs.stat(file);
  if (stat.size > 200 * 1024 * 1024)
    throw Error("Collection JSON exceeds 200 MiB.");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  if (
    state.version !== 1 ||
    !Array.isArray(state.files) ||
    !Array.isArray(state.items) ||
    !state.settings ||
    !state.usage ||
    !Array.isArray(state.usage.cost_issues) ||
    typeof state.sourceDirectory !== "string"
  )
    throw Error("Unsupported collection JSON.");
  const filePaths = new Set();
  for (const file of state.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes("..") ||
      file.id !== hash(file.path) ||
      filePaths.has(file.path) ||
      !["pending", "processing", "done", "unidentified", "failed"].includes(
        file.status,
      ) ||
      (file.hash !== undefined && !/^[a-f0-9]{64}$/.test(file.hash))
    ) {
      throw Error("Invalid image manifest in collection JSON.");
    }
    filePaths.add(file.path);
  }
  const ids = new Set();
  for (const item of state.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      !Array.isArray(item.fields) ||
      !Array.isArray(item.photos) ||
      item.fields.some(
        (f) => !f || typeof f.label !== "string" || typeof f.value !== "string",
      )
    )
      throw Error("Invalid item in collection JSON.");
    ids.add(item.id);
    for (const photo of item.photos)
      if (
        !photo ||
        typeof photo.file !== "string" ||
        !filePaths.has(photo.file) ||
        !/^[a-f0-9]{24}\.jpg$/.test(photo.cache)
      )
        throw Error("Invalid photo in collection JSON.");
  }
  return state;
}

async function buildCollection(directory, options = {}, dependencies = {}) {
  const collectionTypes = dependencies.collectionTypes
    ? validateCollectionTypes(dependencies.collectionTypes)
    : loadCollectionTypes();
  const env = dependencies.env ?? process.env;
  const output = path.resolve(options.output ?? "output");
  await fs.mkdir(output, { recursive: true });
  const outputReal = await fs.realpath(output);
  const root = await fs.realpath(directory);
  if (root === outputReal)
    throw Error("Output must differ from the input directory.");
  const unlock = await lockOutput(outputReal);
  try {
    const stateFile = path.join(outputReal, STATE_FILE);
    let state;
    try {
      state = await readState(stateFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (state && !options.resume)
      throw Error(
        "Output already contains a collection. Use --resume or a new output directory.",
      );
    if (!state && options.resume) throw Error("No saved collection to resume.");
    if (!state)
      for (const name of ["collection.xlsx", "collection.csv", ".images"]) {
        try {
          await fs.lstat(path.join(outputReal, name));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        throw Error(
          "Output already contains " +
            name +
            ". Choose a new output directory.",
        );
      }
    const settings = settingsFor(options, env, state?.settings);
    if (
      state &&
      (state.sourceDirectory !== root ||
        !isDeepStrictEqual(settings, state.settings))
    )
      throw Error(
        "Resume requires the same directory and analysis options. Use a new output directory for a different scan.",
      );
    if (
      state?.collectionTypes &&
      !isDeepStrictEqual(collectionTypes, state.collectionTypes)
    )
      throw Error(
        "Collection-type configuration changed. Restore the original config to resume, or use a new output directory. Use export to update columns without AI calls.",
      );
    if (state && !state.collectionTypes)
      throw Error(
        "This collection predates configurable attributes. Use export to update columns, or start a new build in a new output directory.",
      );
    const scanned = await scanImages(root, {
      recursive: settings.recursive,
      exclude: outputReal,
    });
    const files = settings.limit
      ? scanned.files.slice(0, settings.limit)
      : scanned.files;
    if (!files.length)
      throw Error(
        "No supported images found. Use --recursive to include subdirectories.",
      );
    if (
      state &&
      JSON.stringify(state.files.map((f) => f.path)) !== JSON.stringify(files)
    )
      throw Error(
        "Input file list changed. Use a new output directory to scan the changed collection.",
      );
    const config = {
      ...environment(env, settings.provider),
      ...settings,
      collectionTypes,
      signal: options.signal,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    };
    if (!settings.offline && !config.apiKey)
      throw Error(
        "Set " +
          (settings.provider === "openai"
            ? "OPENAI_API_KEY"
            : "GEMINI_API_KEY") +
          " before analysis, or use --offline.",
      );
    state ??= {
      version: 1,
      name: path.basename(root),
      sourceDirectory: root,
      createdAt: new Date().toISOString(),
      settings,
      collectionTypes,
      status: "running",
      files: files.map((file) => ({
        path: file,
        id: hash(file),
        status: "pending",
      })),
      items: [],
      usage: emptyUsage(),
    };
    const cache = path.join(outputReal, ".images");
    await fs.mkdir(cache, { recursive: true });
    const save = async () => {
      state.updatedAt = new Date().toISOString();
      await atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    };
    const progress = dependencies.onProgress ?? (() => {});
    const identify = dependencies.identify ?? identifyPhoto;
    const research = dependencies.research ?? researchItem;
    let stopped = false;
    if (
      options.resume &&
      (state.files.some((file) => file.status === "processing") ||
        state.items.some((item) => item.researchPending))
    ) {
      state.usage.cost_complete = false;
      state.usage.cost_issues = [
        ...new Set([
          ...state.usage.cost_issues,
          "An unfinished request from an earlier process may have incurred unreported charges.",
        ]),
      ];
    }
    // Validate every previously read original before making any further paid requests.
    if (options.resume)
      for (const file of state.files) {
        if (file.hash && (await readSource(root, file.path)).hash !== file.hash)
          throw Error(
            "Image changed since the saved scan: " +
              file.path +
              ". Use a new output directory.",
          );
      }
    await save();
    for (const file of state.files) {
      if (["done", "unidentified"].includes(file.status)) continue;
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }
      progress("Recognizing " + file.path);
      let attempted = false;
      try {
        const source = await readSource(root, file.path);
        file.hash = source.hash;
        const preview = await prepareImage(source.buffer, file.path);
        const cacheName = file.id + ".jpg";
        await atomicWrite(path.join(cache, cacheName), preview);
        file.status = "processing";
        delete file.error;
        await save();
        attempted = !settings.offline;
        const result = settings.offline
          ? {
              items: [
                {
                  name: path.parse(file.path).name,
                  type: "items",
                  confidence: "review",
                  evidence:
                    "Filename only; image identification has not been run.",
                  box: [0, 0, 1, 1],
                  fields: [],
                  unresolved: ["Not analyzed."],
                  sameItemId: "",
                },
              ],
            }
          : await identify(
              {
                image: dataURL(preview),
                previous: state.items,
                provider: settings.provider,
              },
              config,
            );
        state.usage = addUsage(state.usage, result.usage);
        const detected = result.items.length
          ? result.items
          : [
              {
                name: "Unidentified — " + path.basename(file.path),
                type: "items",
                confidence: "review",
                evidence: "No collectible object could be identified.",
                box: [0, 0, 1, 1],
                fields: [],
                unresolved: ["Review or exclude this photograph."],
                sameItemId: "",
              },
            ];
        const additions = detected.map((item, index) => ({
          id: file.id + "-" + (index + 1),
          name: item.name,
          type: item.type,
          confidence: item.confidence,
          evidence: item.evidence,
          fields: item.fields,
          unresolved: item.unresolved ?? [],
          possibleSameItemId: item.sameItemId ?? "",
          excluded: false,
          photos: [{ file: file.path, cache: cacheName, box: item.box }],
        }));
        // Keep separate physical copies. A model grouping suggestion requires human review.
        state.items.push(...additions);
        file.status = result.items.length ? "done" : "unidentified";
      } catch (error) {
        file.status = "failed";
        file.error = error.message;
        state.usage = addUsage(state.usage, error.usage);
        if (attempted) {
          state.usage.cost_complete = false;
          state.usage.cost_issues = [
            ...new Set([
              ...state.usage.cost_issues,
              "A failed or interrupted request may have incurred unreported charges.",
            ]),
          ];
        }
        if (error.apiAccessBlocked || options.signal?.aborted) stopped = true;
      }
      await save();
      if (stopped) break;
    }
    if (!stopped && settings.research !== "none")
      for (const item of state.items) {
        if (
          item.excluded ||
          item.research?.complete ||
          item.photos.every(
            (photo) =>
              state.files.find((file) => file.path === photo.file)?.status ===
              "unidentified",
          )
        )
          continue;
        if (options.signal?.aborted) {
          stopped = true;
          break;
        }
        progress("Researching " + item.name);
        try {
          const images = await Promise.all(
            item.photos.map(async (photo) => ({
              image: dataURL(await fs.readFile(path.join(cache, photo.cache))),
              label: "Source photograph",
            })),
          );
          item.researchPending = true;
          await save();
          const findings = await research(
            {
              provider: settings.provider,
              item,
              images,
              catalog: ["catalog", "all"].includes(settings.research),
              resale: ["resale", "all"].includes(settings.research),
            },
            config,
          );
          item.research = { ...findings, complete: true };
          delete item.researchError;
          state.usage = addUsage(state.usage, findings.usage);
        } catch (error) {
          item.researchError = error.message;
          if (error.partialResearch) item.research = error.partialResearch;
          state.usage = addUsage(state.usage, error.usage);
          state.usage.cost_complete = false;
          state.usage.cost_issues = [
            ...new Set([
              ...state.usage.cost_issues,
              "A failed research request may have incurred unreported charges.",
            ]),
          ];
          if (error.apiAccessBlocked || options.signal?.aborted) stopped = true;
        }
        delete item.researchPending;
        await save();
        if (stopped) break;
      }
    state.status = stopped
      ? "interrupted"
      : state.files.some((f) => f.status === "failed") ||
          state.items.some((i) => i.researchError)
        ? "partial"
        : "complete";
    await save();
    const exports = await require("./spreadsheet.cjs").exportCollection(
      state,
      outputReal,
      { cacheDirectory: cache, collectionTypes },
    );
    return {
      output: outputReal,
      stateFile,
      ...exports,
      status: state.status,
      images: state.files.length,
      items: state.items.filter((i) => !i.excluded).length,
      review: state.items.filter((i) => !i.excluded && i.confidence !== "ready")
        .length,
      failed: state.files.filter((f) => f.status === "failed").length,
      usage: state.usage,
    };
  } finally {
    await unlock();
  }
}

module.exports = { buildCollection, readState, settingsFor };
