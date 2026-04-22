#!/usr/bin/env bash
# bisect-automation.sh
# Automates git bisect using a reproduction test script.
#
# Usage:
#   chmod +x bisect-automation.sh
#   ./bisect-automation.sh <good-commit> <bad-commit> <repro-command>
#
# Example:
#   ./bisect-automation.sh v1.2.0 HEAD "npm test -- --grep 'should parse dates'"
#
# Requirements:
#   - The repro-command must exit 0 when the bug is absent (good)
#     and non-zero when the bug is present (bad).
#   - Run from the root of a git repository.

set -euo pipefail

GOOD="${1:-}"
BAD="${2:-}"
REPRO="${3:-}"

if [[ -z "$GOOD" || -z "$BAD" || -z "$REPRO" ]]; then
  echo "Usage: $0 <good-commit> <bad-commit> <repro-command>"
  exit 1
fi

# Validate we are in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: not inside a git repository."
  exit 1
fi

# Validate commits exist
if ! git rev-parse --quiet --verify "${GOOD}^{commit}" > /dev/null; then
  echo "Error: good commit '${GOOD}' not found."
  exit 1
fi
if ! git rev-parse --quiet --verify "${BAD}^{commit}" > /dev/null; then
  echo "Error: bad commit '${BAD}' not found."
  exit 1
fi

# Write a temporary bisect runner
BISECT_RUNNER=$(mktemp)
trap "rm -f ${BISECT_RUNNER}" EXIT

cat > "${BISECT_RUNNER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if ${REPRO}; then
  exit 0  # good
else
  exit 1  # bad
fi
EOF
chmod +x "${BISECT_RUNNER}"

echo "Starting bisect..."
echo "  good: ${GOOD}"
echo "  bad:  ${BAD}"
echo "  test: ${REPRO}"

git bisect start
git bisect bad "${BAD}"
git bisect good "${GOOD}"
git bisect run "${BISECT_RUNNER}"
