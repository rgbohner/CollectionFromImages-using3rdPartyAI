#!/usr/bin/env node
/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Processes the local comic book sample collection.
 * Why: Provides a repeatable offline or explicitly selected AI run without embedding private data.
 */
"use strict";
require("./run-sample.cjs").entry("comics");
