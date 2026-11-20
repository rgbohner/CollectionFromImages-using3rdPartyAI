#!/usr/bin/env bash
# Author: rgbohner (with Codex assistance)
# Date: 2026-11-20
# Used for: Checks prerequisites, installs locked dependencies, creates a private local environment file and runs tests.
# Why: Provides a repeatable development setup while preserving an existing API-key file.

# Run from anywhere: /path/to/CollectionFromImages-using3rdPartyAI/setup.sh
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

run_tests=true
case "${1:-}" in
  "") ;;
  --skip-tests) run_tests=false ;;
  -h|--help)
    printf '%s\n' 'Usage: ./setup.sh [--skip-tests]' \
      'Checks Node.js 22+, installs locked dependencies, creates .env if absent,' \
      'and runs the offline test suite. Existing .env files are preserved.'
    exit 0 ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
esac
if (( $# > 1 )); then
  printf '%s\n' 'Pass at most one option. See ./setup.sh --help.' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is missing. Install Node.js 22 or newer from https://nodejs.org/ and rerun setup.' >&2
  exit 1
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  printf '%s\n' 'Node.js 22 or newer is required. Update Node.js and rerun setup.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  printf '%s\n' 'npm is missing or cannot run. Install the npm bundled with your Node.js version.' >&2
  exit 1
fi

printf 'Setting up CollectionFromImages-using3rdPartyAI with Node %s\n' "$(node --version)"
npm ci --no-fund --no-audit

# noclobber avoids overwriting credentials, including when setup runs twice.
if [[ -e .env || -L .env ]]; then
  printf '%s\n' 'Keeping your existing .env file.'
else
  (umask 077; set -o noclobber; cat .env.example > .env)
  printf '%s\n' 'Created .env. Add your own API key before using AI recognition.'
fi

if [[ "$run_tests" == true ]]; then
  npm test
fi

printf '\n%s\n' 'Development environment ready.' \
  'Try the offline demo:' \
  '  npm run dev -- build ./examples --offline -o ./output/demo' \
  'Then edit .env and analyze your images:' \
  '  npm run dev -- build /path/to/photos -o ./output/my-collection' \
  'To rerun a demo, use a new output directory or add --resume.'
