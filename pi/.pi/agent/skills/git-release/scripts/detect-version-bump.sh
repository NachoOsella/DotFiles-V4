#!/usr/bin/env bash
set -euo pipefail

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
CURRENT=${LAST_TAG#v}

MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
PATCH=$(echo "$CURRENT" | cut -d. -f3)

RANGE="${LAST_TAG}..HEAD"
[ "$LAST_TAG" = "v0.0.0" ] && RANGE="HEAD"

# Check for breaking changes
if git log "$RANGE" --pretty=format:"%s" | grep -qE '^[a-z]+(\([^)]*\))?!:|BREAKING CHANGE'; then
  MAJOR=$((MAJOR + 1))
  MINOR=0
  PATCH=0
  echo "v${MAJOR}.${MINOR}.${PATCH}"
  exit 0
fi

# Check for features
if git log "$RANGE" --pretty=format:"%s" | grep -qE '^feat(\([^)]*\))?:'; then
  MINOR=$((MINOR + 1))
  PATCH=0
  echo "v${MAJOR}.${MINOR}.${PATCH}"
  exit 0
fi

# Check for fixes
if git log "$RANGE" --pretty=format:"%s" | grep -qE '^fix(\([^)]*\))?:'; then
  PATCH=$((PATCH + 1))
  echo "v${MAJOR}.${MINOR}.${PATCH}"
  exit 0
fi

# No conventional commits detected
PATCH=$((PATCH + 1))
echo "v${MAJOR}.${MINOR}.${PATCH}"
