/*
 * Author: rgbohner (with Codex assistance)
 * Date: 2026-11-20
 * Used for: Checks sample modes, credential loading and forwarding to the CLI without API requests.
 * Why: Prevents sample examples from accidentally making paid requests or mixing output folders.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runSample } = require("../examples/run-sample.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sample-runs-"));
  for (const sample of ["coins", "msg", "comics"]) {
    fs.mkdirSync(path.join(root, "sample-data", sample), { recursive: true });
  }
  fs.writeFileSync(path.join(root, ".env"), "# Local test placeholder\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("all samples default to offline without reading credentials", async (t) => {
  const root = fixture(t);
  for (const sample of ["coins", "msg", "comics"]) {
    const code = await runSample(sample, [], {
      root,
      loadEnvFile: () => assert.fail("Offline run must not load credentials"),
      main: async (args) => {
        assert.equal(args[1], path.join(root, "sample-data", sample));
        assert.ok(args.includes("--offline"));
        assert.ok(!args.includes("--provider"));
        assert.equal(
          args[args.indexOf("--output") + 1],
          path.join(root, "output", "samples", `${sample}-offline`),
        );
        return 2;
      },
    });
    assert.equal(code, 2, "preserve the CLI's partial-result exit code");
  }
});

test("explicit AI modes load local credentials and forward build options", async (t) => {
  const root = fixture(t);
  for (const mode of ["openai", "gemini"]) {
    let loaded = false;
    await runSample("comics", [mode, "--limit", "3", "--resume"], {
      root,
      loadEnvFile: (file) => {
        assert.equal(file, path.join(root, ".env"));
        loaded = true;
      },
      main: async (args) => {
        assert.ok(loaded);
        assert.ok(!args.includes("--offline"));
        assert.equal(args[args.indexOf("--provider") + 1], mode);
        assert.equal(args[args.indexOf("--research") + 1], "none");
        assert.deepEqual(args.slice(-3), ["--limit", "3", "--resume"]);
        assert.equal(
          args[args.indexOf("--output") + 1],
          path.join(root, "output", "samples", `comics-${mode}`),
        );
        return 0;
      },
    });
  }
});

test("invalid modes, conflicting provider flags and missing data fail before CLI work", async (t) => {
  const root = fixture(t);
  const deps = { root, main: () => assert.fail("Must not invoke CLI") };
  await assert.rejects(runSample("coins", ["invalid"], deps), /Choose offline/);
  await assert.rejects(
    runSample("coins", ["offline", "--provider=gemini"], deps),
    /Select the provider/,
  );
  await assert.rejects(
    runSample("coins", ["openai", "--offline"], deps),
    /Select the provider/,
  );
  fs.rmSync(path.join(root, "sample-data", "coins"), { recursive: true });
  await assert.rejects(
    runSample("coins", [], deps),
    /Sample images are missing/,
  );
});
