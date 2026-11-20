"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { buildCollection, readState } = require("./collection.cjs");
const { exportCollection } = require("./spreadsheet.cjs");
const { lockOutput } = require("./files.cjs");

const tools = [
  {
    name: "build_collection_spreadsheet",
    description:
      "Identify collectible objects in a local image directory and write XLSX, CSV and resumable JSON. Sends image previews to the configured AI provider unless offline is true. May incur API charges. Review uncertain fields and duplicate suggestions.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["directory", "output"],
      properties: {
        directory: {
          type: "string",
          description: "Absolute path to local image directory.",
        },
        output: {
          type: "string",
          description:
            "Absolute output directory; existing scans require resume.",
        },
        recursive: { type: "boolean" },
        resume: { type: "boolean" },
        offline: { type: "boolean" },
        provider: { type: "string", enum: ["openai", "gemini"] },
        model: { type: "string" },
        researchModel: { type: "string" },
        mode: { type: "string", enum: ["quick", "detailed"] },
        research: {
          type: "string",
          enum: ["none", "catalog", "resale", "all"],
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
        },
        searchBudget: { type: "integer", minimum: 3, maximum: 20 },
        limit: { type: "integer", minimum: 1, maximum: 10000 },
      },
    },
  },
  {
    name: "export_collection_spreadsheet",
    description:
      "Regenerate XLSX and CSV from a reviewed local collection.json. No AI requests. Updates only the two generated export files in the output directory.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file"],
      properties: {
        file: {
          type: "string",
          description: "Absolute path to collection.json.",
        },
        output: {
          type: "string",
          description: "Absolute export directory; defaults to JSON directory.",
        },
        images: { type: "boolean" },
      },
    },
  },
];

function validateArgs(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Error("Arguments must be an object.");
  for (const key of schema.required)
    if (!Object.hasOwn(args, key)) throw Error("Missing argument: " + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw Error("Unknown argument: " + key);
    if (
      rule.type === "integer"
        ? !Number.isInteger(value) ||
          value < rule.minimum ||
          value > rule.maximum
        : typeof value !== rule.type
    )
      throw Error("Invalid argument: " + key);
    if (rule.enum && !rule.enum.includes(value))
      throw Error("Invalid value for " + key);
    if (rule.type === "string" && (!value.trim() || value.length > 4000))
      throw Error("Invalid text for " + key);
    if (
      ["file", "directory", "output"].includes(key) &&
      !path.isAbsolute(value)
    )
      throw Error(key + " must be an absolute path.");
  }
}

async function exportSaved(args) {
  const output = args.output ?? path.dirname(args.file);
  await fs.mkdir(output, { recursive: true });
  const unlock = await lockOutput(output);
  try {
    return await exportCollection(await readState(args.file), output, {
      cacheDirectory: path.join(path.dirname(args.file), ".images"),
      images: args.images !== false,
    });
  } finally {
    await unlock();
  }
}

function createMCPHandler({
  build = buildCollection,
  exportSavedCollection = exportSaved,
} = {}) {
  let initialized = false,
    ready = false;
  const active = new Map();
  return async (message) => {
    const id = message?.id ?? null;
    const error = (code, text) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const result = (value) => ({ jsonrpc: "2.0", id, result: value });
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (Object.hasOwn(message, "id") &&
        !["string", "number"].includes(typeof id))
    )
      return error(-32600, "Invalid JSON-RPC request.");
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "notifications/initialized" && initialized)
        ready = true;
      if (message.method === "notifications/cancelled")
        active.get(message.params?.requestId)?.abort();
      return null;
    }
    if (message.method === "initialize") {
      initialized = true;
      ready = false;
      const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      return result({
        protocolVersion: versions.includes(message.params?.protocolVersion)
          ? message.params.protocolVersion
          : versions[0],
        capabilities: { tools: {} },
        serverInfo: {
          name: "collection-from-images",
          version: require("../package.json").version,
        },
        instructions:
          "Local stdio server. Build writes local files and may make paid AI requests. Review results before relying on them. No other application installation is required.",
      });
    }
    if (message.method === "ping") return result({});
    if (!initialized || !ready)
      return error(-32002, "Initialize the MCP session first.");
    if (message.method === "tools/list") return result({ tools });
    if (message.method !== "tools/call")
      return error(-32601, "Method not found.");
    const tool = tools.find((tool) => tool.name === message.params?.name);
    if (!tool) return error(-32602, "Unknown tool.");
    const args = message.params.arguments;
    try {
      validateArgs(args, tool.inputSchema);
    } catch (e) {
      return error(-32602, e.message);
    }
    if (active.has(id)) return error(-32600, "Request ID is already active.");
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const value =
        tool.name === "build_collection_spreadsheet"
          ? await build(args.directory, { ...args, signal: controller.signal })
          : await exportSavedCollection(args);
      return result({
        ...(value.status && value.status !== "complete"
          ? { isError: true }
          : {}),
        content: [{ type: "text", text: JSON.stringify(value) }],
      });
    } catch (e) {
      return result({
        isError: true,
        content: [{ type: "text", text: e.message }],
      });
    } finally {
      active.delete(id);
    }
  };
}

async function serve({
  input = process.stdin,
  output = process.stdout,
  handler = createMCPHandler(),
} = {}) {
  const max = 1024 * 1024;
  let buffer = "";
  const pending = new Set();
  const write = (value) => {
    if (value) output.write(JSON.stringify(value) + "\n");
  };
  function line(text) {
    if (!text.trim()) return;
    if (Buffer.byteLength(text) > max)
      return write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Message exceeds 1 MiB." },
      });
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON." },
      });
    }
    const task = handler(message)
      .then(write)
      .catch(() =>
        write({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32603, message: "MCP request failed." },
        }),
      )
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
    if (Buffer.byteLength(buffer) > max) {
      line(buffer);
      buffer = "";
      break;
    }
  }
  if (buffer.trim()) line(buffer);
  await Promise.allSettled(pending);
}

module.exports = { createMCPHandler, serve };
