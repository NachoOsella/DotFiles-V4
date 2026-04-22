#!/usr/bin/env bash
set -euo pipefail

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RANGE="${LAST_TAG}..HEAD"
[ -z "$LAST_TAG" ] && RANGE="HEAD"

DATE=$(date +%Y-%m-%d)

echo "## [UNRELEASED] - ${DATE}"
echo

print_section() {
  local title="$1"
  local pattern="$2"
  local commits
  commits=$(git log "$RANGE" --pretty=format:"- %s (%h)" --grep="^$pattern" 2>/dev/null || true)
  if [ -n "$commits" ]; then
    echo "### $title"
    echo "$commits" | sed -E 's/^'$pattern'\(([^)]+)\)!?: /- **\1**: /'
    echo
  fi
}

print_section "Added"      "feat"
print_section "Changed"    "refactor\|perf\|style"
print_section "Deprecated" "deprecate"
print_section "Removed"    "remove"
print_section "Fixed"      "fix"
print_section "Security"   "security"

# Detect breaking changes in any conventional commit with ! or BREAKING CHANGE footer
echo "### Breaking Changes"
breaking=$(git log "$RANGE" --pretty=format:"- %s (%h)" 2>/dev/null || true)
if [ -n "$breaking" ]; then
  echo "$breaking" | grep -E '^- .*!\:|BREAKING CHANGE' || echo "_None_"
else
  echo "_None_"
fi
