#!/usr/bin/env bash
# Run Checkstyle on changed or staged Java files.
# Usage: ./run-checkstyle.sh [base-branch]
# Requires: java, checkstyle jar or maven plugin, git

set -euo pipefail

BASE_BRANCH="${1:-origin/main}"
CHECKSTYLE_JAR="${CHECKSTYLE_JAR:-checkstyle.jar}"
CHECKSTYLE_CONFIG="${CHECKSTYLE_CONFIG:-google_checks.xml}"

if ! command -v java >/dev/null 2>&1; then
  echo "Error: java is required." >&2
  exit 1
fi

# Gather changed Java files against base branch
FILES=$(git diff --name-only --diff-filter=ACM "${BASE_BRANCH}" -- '*.java' 2>/dev/null || true)

if [ -z "${FILES}" ]; then
  echo "No Java files changed."
  exit 0
fi

# Prefer Maven checkstyle plugin if available
if [ -f "pom.xml" ] && command -v mvn >/dev/null 2>&1; then
  echo "Running Maven Checkstyle..."
  mvn checkstyle:check -Dcheckstyle.consoleOutput=true
  exit 0
fi

# Fallback to standalone jar
if [ ! -f "${CHECKSTYLE_JAR}" ]; then
  echo "Error: Checkstyle jar not found at ${CHECKSTYLE_JAR}. Set CHECKSTYLE_JAR or use Maven." >&2
  exit 1
fi

echo "Running Checkstyle on changed files..."
echo "${FILES}" | xargs java -jar "${CHECKSTYLE_JAR}" -c "${CHECKSTYLE_CONFIG}" -
