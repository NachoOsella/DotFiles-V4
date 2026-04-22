---
name: docs-agent
description: "Generates and injects professional technical documentation, docstrings, and API specs directly into the codebase. Use when you need to: (1) add inline documentation to functions/classes/methods, (2) create or update README files, (3) generate API specifications (OpenAPI, GraphQL schemas), (4) document complex logic or architectures, (5) write setup or contribution guides, or (6) improve documentation coverage across a project."
---

## Core Actions

**Inline Documentation** (use `edit` tool)
- Inject docstrings (Javadoc, Python Docstrings, JSDoc, Rust doc comments) into source files
- Include `@param`, `@return`, `@throws` / `Args`, `Returns`, `Raises` annotations
- Target classes, functions, and complex logic blocks
- Do not modify code logic, only documentation

**README Generation** (use `write` tool)
- Use the template at `assets/README.md.template`
- Include: Installation, Usage, Configuration, Contributing sections
- Keep language professional and instructional

**API Specifications** (use `write` tool)
- Generate `openapi.yaml`, `schema.graphql`, or similar specs
- Use the stub at `assets/openapi.yaml.stub` as a starting point
- Save in an appropriate documentation directory (e.g., `docs/`, `api/`)

**Contribution Guides** (use `write` tool)
- Use the template at `assets/CONTRIBUTING.md.template`
- Cover: setup, branching, commits, PR process, code style, docs requirements

## Docstring Formats

- Follow project conventions first
- Default formats are defined in `references/docstring-formats.md`:
  - Google-style Python docstrings
  - JSDoc for JavaScript / TypeScript
  - Javadoc for Java
  - Rust documentation comments (`///`)
- Always include parameter, return, and error/exception details where relevant

## Scripts

- `scripts/check_docstrings.py` — scan a file or directory for public functions/classes missing docstrings
  - Supports Python, JavaScript, TypeScript, Java, and Rust
  - Returns exit code `1` when missing docstrings are found so it can be used in CI
  - Usage: `python scripts/check_docstrings.py <path> [--lang <language>]`

## Gotchas

1. **Document why, not what, if the name is already clear**
   - Bad: `def save_user(user): """Save the user."""`
   - Good: `def save_user(user): """Persist the user only after validating email uniqueness to prevent duplicates."""`

2. **Code examples in docstrings must be testable**
   - Python doctests and Rust doc tests are compiled and run by test suites
   - JS/TS and Java examples should be copy-pasteable and syntactically valid
   - Never include pseudocode or broken syntax in `@example` / `Example` blocks

3. **Do not leave placeholders in generated docs**
   - Remove or replace every `[description here]`, `TODO`, `FIXME`, and `{{VARIABLE}}` before finishing
   - A validation step is required (see below)

4. **Keep docstrings DRY**
   - Do not repeat the function name or parameter name if it adds no information
   - Focus on constraints, side effects, invariants, and caller responsibilities

5. **Match the project's tone and terminology**
   - Use the same vocabulary as existing docs and code comments
   - If the project uses "client" instead of "consumer", stay consistent

## Validation Loop

Before declaring documentation work complete, run this checklist:

1. **Placeholder sweep**
   - Search the modified files for `[description here]`, `TODO`, `FIXME`, `{{`, and `}}`
   - If any remain, resolve them before proceeding

2. **Docstring coverage check**
   - Run `scripts/check_docstrings.py` on the affected directory
   - Add docstrings to any newly introduced public API that is flagged

3. **Example verification**
   - Copy every code example from the new docs into a temporary file
   - Confirm it parses/compiles without syntax errors (run the language's compiler or interpreter if possible)

4. **Link integrity**
   - Verify any relative links in README/CONTRIBUTING files point to real files
   - Check anchor links in Markdown headers

5. **Consistency review**
   - Compare new docstrings against `references/docstring-formats.md`
   - Ensure section headings, tag names, and type annotations follow the canonical format

## Output

List files modified/created and summarize documentation coverage added. Highlight any public API items that still need docstrings after the validation loop.
