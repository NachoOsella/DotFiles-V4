#!/usr/bin/env python3
"""
minimal-case-generator.py
Parses logs and stack traces to scaffold a minimal reproduction case.

Usage:
    python3 minimal-case-generator.py <log-file> [--language python|javascript|java]

Output:
    Prints a scaffolded test file to stdout. Redirect to a file to save.

Example:
    python3 minimal-case-generator.py crash.log --language python > test_repro.py

Heuristics:
    - Extracts exception types, file paths, and line numbers from stack traces.
    - Identifies input values (JSON blobs, query strings, timestamps) that preceded the crash.
    - Generates a skeleton test with TODOs for the user to fill in actual assertions.
"""

import argparse
import json
import re
import sys
from pathlib import Path


def extract_stack_traces(text: str) -> list[dict]:
    """Extract file paths, line numbers, and function names from common stack trace formats."""
    traces = []

    # Python / Java / JS common frame patterns
    patterns = [
        # Python
        r'File "([^"]+)", line (\d+), in (\S+)',
        # Java / JavaScript
        r'at\s+([\w.$/<>]+)\s*\(([^:]+):(\d+)\)',
        # JS/V8 alternative
        r'at\s+([^:]+):(\d+):(\d+)',
    ]

    for pat in patterns:
        for m in re.finditer(pat, text):
            if len(m.groups()) == 3:
                if 'File' in pat:
                    traces.append({
                        'file': m.group(1),
                        'line': int(m.group(2)),
                        'function': m.group(3),
                    })
                else:
                    traces.append({
                        'file': m.group(2) if ':' in m.group(2) else m.group(1),
                        'line': int(m.group(3)) if m.group(3).isdigit() else int(m.group(2)),
                        'function': m.group(1),
                    })
    return traces


def extract_exception_types(text: str) -> list[str]:
    """Extract exception or error type names."""
    results = []
    # Python: ValueError: ...
    results += re.findall(r'^(\w+Error):', text, re.MULTILINE)
    # Java: java.lang.IllegalArgumentException: ...
    results += re.findall(r'(\w+(?:Exception|Error)):', text)
    # JS: TypeError: ...
    results += re.findall(r'^(\w+Error):', text, re.MULTILINE)
    return list(dict.fromkeys(results))  # preserve order, dedupe


def extract_inputs(text: str) -> list[dict]:
    """Try to find JSON, query strings, or CSV rows that might be inputs."""
    inputs = []
    # JSON blobs
    for m in re.finditer(r'\{[^{}]*\}', text):
        blob = m.group(0)
        try:
            inputs.append(json.loads(blob))
        except json.JSONDecodeError:
            pass
    # Query strings
    for m in re.finditer(r'[?&](\w+)=([^&\s]+)', text):
        inputs.append({m.group(1): m.group(2)})
    return inputs


def generate_test(language: str, exceptions: list[str], traces: list[dict], inputs: list[dict]) -> str:
    if language == "python":
        return _generate_python(exceptions, traces, inputs)
    if language == "javascript":
        return _generate_javascript(exceptions, traces, inputs)
    if language == "java":
        return _generate_java(exceptions, traces, inputs)
    return f"// Unsupported language: {language}\n"


def _generate_python(exceptions, traces, inputs) -> str:
    lines = [
        "import pytest",
        "",
        "# Auto-generated reproduction scaffold",
        f"# Detected exceptions: {', '.join(exceptions) if exceptions else 'None'}",
        f"# Top frame: {traces[0] if traces else 'N/A'}",
        "",
        "def test_reproduction():",
        '    """TODO: describe the bug being reproduced."""',
        "",
    ]
    if inputs:
        lines.append(f"    inputs = {json.dumps(inputs[0], indent=4)}")
    else:
        lines.append("    inputs = {}  # TODO: provide failing input")
    lines += [
        "",
        "    # TODO: call the function under test with inputs",
        "    # result = function_under_test(inputs)",
        "",
        "    # TODO: add assertion that fails before the fix",
        "    # assert result == expected",
        "",
        "    # TODO: add assertion that passes after the fix",
    ]
    return "\n".join(lines)


def _generate_javascript(exceptions, traces, inputs) -> str:
    lines = [
        "// Auto-generated reproduction scaffold",
        f"// Detected exceptions: {', '.join(exceptions) if exceptions else 'None'}",
        f"// Top frame: {traces[0] if traces else 'N/A'}",
        "",
        "describe('reproduction', () => {",
        "  it('should fail before fix and pass after', () => {",
    ]
    if inputs:
        lines.append(f"    const inputs = {json.dumps(inputs[0], indent=4)};")
    else:
        lines.append("    const inputs = {}; // TODO: provide failing input")
    lines += [
        "",
        "    // TODO: call the function under test with inputs",
        "    // const result = functionUnderTest(inputs);",
        "",
        "    // TODO: add assertion that fails before the fix",
        "    // expect(result).toBe(expected);",
        "  });",
        "});",
    ]
    return "\n".join(lines)


def _generate_java(exceptions, traces, inputs) -> str:
    lines = [
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.*;",
        "",
        "// Auto-generated reproduction scaffold",
        f"// Detected exceptions: {', '.join(exceptions) if exceptions else 'None'}",
        f"// Top frame: {traces[0] if traces else 'N/A'}",
        "",
        "public class ReproductionTest {",
        "",
        "    @Test",
        "    public void testReproduction() {",
    ]
    if inputs:
        lines.append(f"        // inputs = {json.dumps(inputs[0])}")
    else:
        lines.append("        // TODO: provide failing input")
    lines += [
        "",
        "        // TODO: call the function under test",
        "        // var result = functionUnderTest(inputs);",
        "",
        "        // TODO: add assertion that fails before the fix",
        "        // assertEquals(expected, result);",
        "    }",
        "",
        "}",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a minimal reproduction scaffold from a log file.")
    parser.add_argument("log_file", help="Path to the log or stack trace file.")
    parser.add_argument("--language", choices=["python", "javascript", "java"], default="python",
                        help="Target language for the generated test scaffold.")
    args = parser.parse_args()

    log_path = Path(args.log_file)
    if not log_path.exists():
        print(f"Error: file not found: {log_path}", file=sys.stderr)
        return 1

    text = log_path.read_text(encoding="utf-8", errors="ignore")
    traces = extract_stack_traces(text)
    exceptions = extract_exception_types(text)
    inputs = extract_inputs(text)

    print(generate_test(args.language, exceptions, traces, inputs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
