#!/usr/bin/env bash
# Dockerfile validator
# Runs hadolint if available, falls back to basic structural checks
# Usage: ./validate-dockerfile.sh <Dockerfile> [--strict]
# Exit codes: 0 = pass, 1 = fail

set -euo pipefail

DOCKERFILE="${1:-}"
STRICT=false
if [[ "${2:-}" == "--strict" ]]; then
    STRICT=true
fi

if [[ -z "$DOCKERFILE" ]]; then
    echo "Usage: $0 <Dockerfile> [--strict]"
    exit 1
fi

if [[ ! -f "$DOCKERFILE" ]]; then
    echo "Error: File not found: $DOCKERFILE"
    exit 1
fi

echo "Validating: $DOCKERFILE"
ERRORS=0

# ---- hadolint check ----
if command -v hadolint &> /dev/null; then
    echo "Running hadolint..."
    if $STRICT; then
        # Strict: treat all warnings as errors
        if ! hadolint --failure-threshold info "$DOCKERFILE"; then
            ERRORS=$((ERRORS + 1))
        fi
    else
        if ! hadolint "$DOCKERFILE"; then
            ERRORS=$((ERRORS + 1))
        fi
    fi
else
    echo "hadolint not found. Install with: wget -qO- https://install.hadolint.dev | sh -"
    echo "Falling back to basic structural checks..."
fi

# ---- Basic structural checks ----

# Check: Do not use FROM ... latest
echo "Checking for 'latest' tag usage..."
if grep -iP '^FROM\s+\S+:latest\b' "$DOCKERFILE" > /dev/null; then
    echo "  FAIL: Image uses 'latest' tag. Pin to a specific version."
    ERRORS=$((ERRORS + 1))
else
    echo "  PASS: No 'latest' tag found."
fi

# Check: Do not run as root (look for USER instruction)
echo "Checking for non-root USER..."
if grep -iP '^USER\s+' "$DOCKERFILE" > /dev/null; then
    echo "  PASS: USER instruction found."
else
    echo "  FAIL: No USER instruction found. Containers should not run as root."
    ERRORS=$((ERRORS + 1))
fi

# Check: Avoid ADD when COPY suffices (ADD is for tar/remote URLs)
echo "Checking for unnecessary ADD..."
if grep -iP '^ADD\s+\S+\s+\S+' "$DOCKERFILE" > /dev/null; then
    echo "  WARN: ADD instruction found. Prefer COPY unless extracting archives or fetching URLs."
    if $STRICT; then
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "  PASS: No unnecessary ADD found."
fi

# Check: HEALTHCHECK present
echo "Checking for HEALTHCHECK..."
if grep -iP '^HEALTHCHECK\b' "$DOCKERFILE" > /dev/null; then
    echo "  PASS: HEALTHCHECK found."
else
    echo "  WARN: No HEALTHCHECK instruction found. Consider adding one."
    if $STRICT; then
        ERRORS=$((ERRORS + 1))
    fi
fi

# Check: apt-get update paired with install and cleanup
echo "Checking apt-get hygiene..."
if grep -i 'apt-get update' "$DOCKERFILE" > /dev/null; then
    if ! grep -iP 'apt-get.*install.*&&.*rm.*(/var/lib/apt/lists/|/tmp/)' "$DOCKERFILE" > /dev/null; then
        echo "  WARN: apt-get update detected but no cleanup of /var/lib/apt/lists found."
        if $STRICT; then
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo "  PASS: apt-get update with cleanup detected."
    fi
else
    echo "  SKIP: No apt-get usage."
fi

# Check: Do not hardcode secrets
echo "Checking for hardcoded secrets..."
if grep -iP '(password|secret|token|key)\s*=\s*["\047][^"\047]{4,}["\047]' "$DOCKERFILE" > /dev/null; then
    echo "  FAIL: Possible hardcoded secret detected."
    ERRORS=$((ERRORS + 1))
else
    echo "  PASS: No obvious hardcoded secrets."
fi

echo ""
if [[ "$ERRORS" -gt 0 ]]; then
    echo "Validation FAILED with $ERRORS error(s)."
    exit 1
else
    echo "Validation PASSED."
    exit 0
fi
