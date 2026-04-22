#!/bin/bash
# Universal test runner that detects project type and runs appropriate tests
# Returns proper exit codes and parses coverage output when available

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

# Detect project type and framework
detect_project() {
    local project_type="unknown"
    local test_cmd=""
    
    # Check for JavaScript/TypeScript
    if [[ -f "package.json" ]]; then
        project_type="javascript"
        if grep -q "\"jest\"" package.json || grep -q "\"vitest\"" package.json; then
            test_cmd="npm test"
        elif grep -q "\"mocha\"" package.json || grep -q "\"jasmine\"" package.json; then
            test_cmd="npm test"
        else
            test_cmd="npm test"  # Default
        fi
    # Check for Python
    elif [[ -f "pyproject.toml" || -f "requirements.txt" || -f "setup.py" ]]; then
        project_type="python"
        if grep -q "pytest" pyproject.toml 2>/dev/null || grep -q "pytest" requirements.txt 2>/dev/null; then
            test_cmd="pytest"
        else
            test_cmd="python -m unittest discover"
        fi
    # Check for Java
    elif [[ -f "pom.xml" || -f "build.gradle" || -f "build.gradle.kts" ]]; then
        project_type="java"
        if [[ -f "pom.xml" ]]; then
            test_cmd="mvn test"
        else
            test_cmd="gradle test"
        fi
    # Check for Go
    elif [[ -f "go.mod" ]]; then
        project_type="go"
        test_cmd="go test ./..."
    fi
    
    echo "$project_type|$test_cmd"
}

# Run tests and capture output
run_tests() {
    local project_info="$1"
    local project_type="${project_info%%|*}"
    local test_cmd="${project_info#*|}"
    
    log_info "Detected project type: $project_type"
    log_info "Running tests with: $test_cmd"
    
    # Run the test command and capture output
    local output
    local exit_code
    
    # Execute test command and capture both stdout and stderr
    output=$(eval "$test_cmd" 2>&1) || exit_code=$?
    
    # If exit_code is not set, command succeeded
    if [[ -z "${exit_code:-}" ]]; then
        exit_code=0
    fi
    
    echo "$output"
    return $exit_code
}

# Parse coverage output if available
parse_coverage() {
    local output="$1"
    local project_type="$2"
    
    case "$project_type" in
        "javascript")
            # Look for Jest coverage output
            if echo "$output" | grep -q "Coverage Summary"; then
                echo "$output" | grep -A 10 "Coverage Summary"
            fi
            ;;
        "python")
            # Look for pytest-cov output
            if echo "$output" | grep -q "TOTAL"; then
                echo "$output" | grep -E "^TOTAL\s+"
            fi
            ;;
        "java")
            # Look for JaCoCo or Maven cobertura output
            if echo "$output" | grep -q "INSTRUCTION"; then
                echo "$output" | grep -A 5 "INSTRUCTION"
            fi
            ;;
        "go")
            # Look for go test coverage
            if echo "$output" | grep -q "coverage:"; then
                echo "$output" | grep "coverage:"
            fi
            ;;
    esac
}

# Main execution
main() {
    log_info "Starting test execution..."
    
    # Detect project and get test command
    local project_info
    project_info=$(detect_project)
    
    # Run tests
    local test_output
    local test_exit_code
    test_output=$(run_tests "$project_info")
    test_exit_code=$?
    
    # Output test results
    echo "===== TEST OUTPUT ====="
    echo "$test_output"
    echo "========================"
    
    # Parse and show coverage if available
    local coverage_info
    coverage_info=$(parse_coverage "$test_output" "${project_info%%|*}")
    if [[ -n "$coverage_info" ]]; then
        echo "===== COVERAGE INFO ====="
        echo "$coverage_info"
        echo "========================="
    fi
    
    # Determine final status
    if [[ $test_exit_code -eq 0 ]]; then
        log_info "All tests passed!"
        exit 0
    else
        log_error "Tests failed with exit code: $test_exit_code"
        exit $test_exit_code
    fi
}

# Run main if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi