#!/usr/bin/env bash
# Run ESLint on changed or staged JavaScript/TypeScript files.
# Usage: ./run-eslint.sh [base-branch]
# Requires: eslint, npx

set -euo pipefail

BASE_BRANCH="${1:-origin/main}"

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx is required." >&2
  exit 1
fi

# Gather changed JS/TS/JSX/TSX files against base branch
FILES=$(git diff --name-only --diff-filter=ACM "${BASE_BRANCH}" -- '*.js' '*.jsx' '*.ts' '*.tsx' 2>/dev/null || true)

if [ -z "${FILES}" ]; then
  echo "No JavaScript/TypeScript files changed."
  exit 0
fi

echo "Running ESLint on changed files..."
echo "${FILES}" | xargs npx eslint --ext .js,.jsx,.ts,.tsx --format stylish
