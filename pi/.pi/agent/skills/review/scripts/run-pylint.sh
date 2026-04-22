#!/usr/bin/env bash
# Run Pylint on changed or staged Python files.
# Usage: ./run-pylint.sh [base-branch]
# Requires: pylint, git

set -euo pipefail

BASE_BRANCH="${1:-origin/main}"

if ! command -v pylint >/dev/null 2>&1; then
  echo "Error: pylint is not installed. Install with: pip install pylint" >&2
  exit 1
fi

# Gather changed Python files against base branch
FILES=$(git diff --name-only --diff-filter=ACM "${BASE_BRANCH}" -- '*.py' 2>/dev/null || true)

if [ -z "${FILES}" ]; then
  echo "No Python files changed."
  exit 0
fi

echo "Running Pylint on changed files..."
echo "${FILES}" | xargs pylint --output-format=colorized
