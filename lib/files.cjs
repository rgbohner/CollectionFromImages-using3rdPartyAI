/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Writes files atomically and locks output directories during updates.
 * Why: Reduces partial-file corruption and prevents concurrent writers from colliding.
 */
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

async function atomicWrite(file, content) {
  const temp = path.join(
    path.dirname(file),
    "." + path.basename(file) + "." + randomUUID() + ".tmp",
  );
  try {
    await fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function lockOutput(directory) {
  const file = path.join(directory, ".collection.lock");
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: os.hostname() }),
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw Error(
      "Output is locked by another run. If no run is active, remove " + file,
    );
  }
  return () => fs.unlink(file);
}

module.exports = { atomicWrite, lockOutput };
