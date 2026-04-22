#!/bin/bash
# Helper script for running single tests with verbose output
# Useful for debugging failing tests

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Show usage
usage() {
    echo "Usage: $0 <test-pattern>"
    echo "  <test-pattern>: Pattern to match test name (e.g., 'should return valid token')"
    echo ""
    echo "Examples:"
    echo "  $0 'should calculate total'"
    echo "  $0 'handles empty input'"
    exit 1
}

# Check if pattern provided
if [[ $# -lt 1 ]]; then
    usage
fi

TEST_PATTERN="$1"

# Detect project type and framework
detect_project() {
    local project_type="unknown"
    local test_cmd=""
    
    # Check for JavaScript/TypeScript
    if [[ -f "package.json" ]]; then
        project_type="javascript"
        if grep -q "\"jest\"" package.json || grep -q "\"vitest\"" package.json; then
            test_cmd="npm test -- --testNamePattern"
        elif grep -q "\"mocha\"" package.json || grep -q "\"jasmine\"" package.json; then
            test_cmd="npm test -- --grep"
        else
            test_cmd="npm test -- --testNamePattern"  # Default
        fi
    # Check for Python
    elif [[ -f "pyproject.toml" || -f "requirements.txt" || -f "setup.py" ]]; then
        project_type="python"
        test_cmd="pytest -k"
    # Check for Java
    elif [[ -f "pom.xml" || -f "build.gradle" || -f "build.gradle.kts" ]]; then
        project_type="java"
        if [[ -f "pom.xml" ]]; then
            test_cmd="mvn test -Dtest="
        else
            test_cmd="gradle test --tests"
        fi
    # Check for Go
    elif [[ -f "go.mod" ]]; then
        project_type="go"
        test_cmd="go test -run"
    fi
    
    echo "$project_type|$test_cmd"
}

# Main execution
main() {
    log_info "Starting test debug session..."
    log_info "Searching for tests matching: '$TEST_PATTERN'"
    
    # Detect project and get test command
    local project_info
    project_info=$(detect_project)
    local project_type="${project_info%%|*}"
    local base_cmd="${project_info#*|}"
    
    log_info "Detected project type: $project_type"
    
    # Build final command
    local final_cmd
    case "$project_type" in
        "javascript")
            final_cmd="$base_cmd \"$TEST_PATTERN\""
            ;;
        "python")
            final_cmd="$base_cmd \"$TEST_PATTERN\" -v"
            ;;
        "java")
            final_cmd="${base_cmd}${TEST_PATTERN}"
            ;;
        "go")
            final_cmd="$base_cmd \"$TEST_PATTERN\" -v"
            ;;
        *)
            log_error "Unsupported project type: $project_type"
            exit 1
            ;;
    esac
    
    log_info "Running command: $final_cmd"
    
    # Run the test command and capture output
    local output
    local exit_code
    
    output=$(eval "$final_cmd" 2>&1) || exit_code=$?
    
    # If exit_code is not set, command succeeded
    if [[ -z "${exit_code:-}" ]]; then
        exit_code=0
    fi
    
    # Output results
    echo "===== DEBUG OUTPUT ====="
    echo "$output"
    echo "========================"
    
    # Determine final status
    if [[ $exit_code -eq 0 ]]; then
        log_info "Test passed!"
        exit 0
    else
        log_error "Test failed or not found with exit code: $exit_code"
        exit $exit_code
    fi
}

# Run main if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi