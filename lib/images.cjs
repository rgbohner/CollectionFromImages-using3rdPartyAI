/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Discovers supported images, decodes HEIC, normalizes previews and crops thumbnails.
 * Why: Provides bounded, portable image processing while leaving originals untouched.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");

const EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 80 * 1000 * 1000;

async function scanImages(directory, { recursive = false, exclude } = {}) {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory())
    throw Error("Input must be a directory.");
  const files = [];
  async function visit(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = path.join(folder, entry.name);
      if (full === exclude) continue;
      if (entry.isDirectory() && recursive) await visit(full);
      else if (
        entry.isFile() &&
        EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(path.relative(root, full));
        if (files.length > 10000)
          throw Error("Split directories containing more than 10,000 images.");
      }
    }
  }
  await visit(root);
  return { root, files };
}

async function readSource(root, relative) {
  const file = await fs.realpath(path.join(root, relative));
  const rel = path.relative(root, file);
  if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
    throw Error("Image resolves outside the input directory.");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw Error("Image must be a regular file smaller than 50 MiB.");
  const buffer = await fs.readFile(file);
  return {
    buffer,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function prepareImage(buffer, filename) {
  // libvips prebuilt binaries do not include HEVC. Use the bundled WASM decoder.
  if (/\.hei[cf]$/i.test(filename)) {
    const meta = await sharp(buffer, {
      limitInputPixels: MAX_PIXELS,
    }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS)
      throw Error("HEIC image exceeds 80 megapixels.");
    buffer = Buffer.from(
      await require("heic-convert")({ buffer, format: "JPEG", quality: 0.95 }),
    );
  }
  return sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate()
    .resize({
      width: 2560,
      height: 2560,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function thumbnail(buffer, box = [0, 0, 1, 1]) {
  const { width, height } = await sharp(buffer).metadata();
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
    box[2] <= box[0] ||
    box[3] <= box[1]
  )
    throw Error("Invalid object bounds.");
  const left = Math.min(width - 1, Math.floor(box[0] * width));
  const top = Math.min(height - 1, Math.floor(box[1] * height));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(box[2] * width)));
  const bottom = Math.max(
    top + 1,
    Math.min(height, Math.ceil(box[3] * height)),
  );
  return sharp(buffer)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(144, 108, { fit: "contain", background: "#ffffff" })
    .jpeg({ quality: 82 })
    .toBuffer();
}

module.exports = {
  scanImages,
  readSource,
  prepareImage,
  thumbnail,
  EXTENSIONS,
};
