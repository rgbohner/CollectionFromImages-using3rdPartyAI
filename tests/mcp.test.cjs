"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const { createMCPHandler, serve } = require("../lib/mcp.cjs");
const rpc = (id, method, params) => ({
  jsonrpc: "2.0",
  ...(id === undefined ? {} : { id }),
  method,
  ...(params ? { params } : {}),
});
async function ready(handler) {
  await handler(rpc(1, "initialize", { protocolVersion: "2025-11-25" }));
  await handler(rpc(undefined, "notifications/initialized"));
}

test("MCP negotiation, validation and shared pipeline calls", async () => {
  let received;
  const handler = createMCPHandler({
    build: async (directory, args) => {
      received = { directory, args };
      return { status: "complete", items: 2 };
    },
  });
  assert.equal((await handler(rpc(0, "tools/list"))).error.code, -32002);
  await ready(handler);
  assert.equal((await handler(rpc(2, "tools/list"))).result.tools.length, 2);
  assert.equal(
    (
      await handler(
        rpc(3, "tools/call", {
          name: "build_collection_spreadsheet",
          arguments: { directory: "relative", output: path.resolve("out") },
        }),
      )
    ).error.code,
    -32602,
  );
  assert.equal(
    (
      await handler(
        rpc(4, "tools/call", {
          name: "build_collection_spreadsheet",
          arguments: {
            directory: path.resolve("photos"),
            output: path.resolve("out"),
            offline: "yes",
          },
        }),
      )
    ).error.code,
    -32602,
  );
  const result = await handler(
    rpc(5, "tools/call", {
      name: "build_collection_spreadsheet",
      arguments: {
        directory: path.resolve("photos"),
        output: path.resolve("out"),
        offline: true,
      },
    }),
  );
  assert.equal(JSON.parse(result.result.content[0].text).items, 2);
  assert.equal(received.args.offline, true);
});

test("MCP cancellation reaches an active build while ping remains responsive", async () => {
  const handler = createMCPHandler({
    build: async (_, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({ status: "interrupted" }),
        ),
      ),
  });
  await ready(handler);
  const build = handler(
    rpc(3, "tools/call", {
      name: "build_collection_spreadsheet",
      arguments: {
        directory: path.resolve("photos"),
        output: path.resolve("out"),
      },
    }),
  );
  assert.deepEqual((await handler(rpc(4, "ping"))).result, {});
  await handler(rpc(undefined, "notifications/cancelled", { requestId: 3 }));
  assert.equal((await build).result.isError, true);
});

test("stdio handles split JSON frames and emits only protocol messages", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const serving = serve({ input, output });
  input.write(
    "{bad}\n" +
      JSON.stringify(
        rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
      ).slice(0, 10),
  );
  input.end(
    JSON.stringify(
      rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
    ).slice(10) +
      "\n" +
      JSON.stringify(rpc(undefined, "notifications/initialized")) +
      "\n" +
      JSON.stringify(rpc(2, "tools/list")) +
      "\n",
  );
  await serving;
  const messages = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].result.protocolVersion, "2025-06-18");
  assert.equal(messages[2].result.tools.length, 2);
});

test("real CLI MCP subprocess creates an offline collection workbook", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "images"),
    output = path.join(root, "out");
  await fs.mkdir(directory);
  await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#448899" },
  })
    .jpeg()
    .toFile(path.join(directory, "sample.jpg"));
  const child = spawn(process.execPath, [
    path.resolve(__dirname, "../bin/collection-from-images.cjs"),
    "mcp",
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const messages = [
    rpc(1, "initialize", { protocolVersion: "2025-11-25" }),
    rpc(undefined, "notifications/initialized"),
    rpc(2, "tools/call", {
      name: "build_collection_spreadsheet",
      arguments: { directory, output, offline: true },
    }),
  ];
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  assert.equal(await ended, 0, stderr);
  const result = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((m) => m.id === 2).result;
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).items, 1);
  await fs.access(path.join(output, "collection.xlsx"));
});
