---
name: git-release
description: Use for releases, changelogs, and version bumps.
---

# Git Release Workflow

## Semantic Versioning

```
MAJOR.MINOR.PATCH
  |     |     +-- Bug fixes, no API changes
  |     +-------- New features, backwards compatible
  +-------------- Breaking changes
```

## Validation Loop (Pre-Release Checklist)

Run this checklist before every release. Do not skip steps.

| # | Check | Command / Action |
|---|-------|------------------|
| 1 | Tests pass | `npm test` (or project-specific test command) |
| 2 | CI is green | Verify latest commit on main has passing checks |
| 3 | Changelog updated | `CHANGELOG.md` contains all changes since last tag |
| 4 | Version bump correct | `scripts/detect-version-bump.sh` matches manual expectation |
| 5 | Tag does not exist | `git tag -l "v<NEW_VERSION>"` returns nothing |
| 6 | Working directory clean | `git status --porcelain` returns empty |

If any check fails, stop the release and fix the issue before proceeding.

## Scripts

Place these in the project root under a `scripts/` directory or copy the logic into CI pipelines.

### Changelog Generator (`scripts/generate-changelog.sh`)

Groups commits since the latest tag into Added, Changed, Deprecated, Removed, Fixed, and Security sections. Requires conventional commit messages.

```bash
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
```

### Version Bump Auto-Detector (`scripts/detect-version-bump.sh`)

Inspects conventional commits since the last tag and suggests the next semantic version. Exits with code `0` and prints the new version string.

```bash
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
```

## Assets

### CHANGELOG.md Template (`assets/CHANGELOG.md`)

Follows the [Keep a Changelog](https://keepachangelog.com/) format. Copy this into the repository root and update it before every release.

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [1.2.0] - 2026-04-20

### Added
- New authentication flow (#123)

### Fixed
- Memory leak in cache handler (#456)

### Security
- Updated `lodash` to resolve CVE-2024-1234 (#789)

## [1.1.0] - 2026-03-15

### Added
- Dark mode support (#100)

### Changed
- Improved cache eviction policy (#101)

### Fixed
- Race condition in concurrent writes (#102)

## [1.0.0] - 2026-02-01

### Added
- Initial stable release

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/OWNER/REPO/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/OWNER/REPO/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
```

## Gotchas

### Monorepo Semver Divergence
In monorepos with independent versioning (e.g., Lerna, pnpm workspaces, or Yarn workspaces with `independent` mode), each package follows its own semantic version. Do not bump every package to the same version unless you use a fixed-version strategy. A fix in `package-a` should not force a patch release of `package-b`.

### `fix:` Commits May Include Breaking Changes Accidentally
A commit prefixed with `fix:` can still introduce breaking changes if it alters default behavior, tightens validation, or changes error handling. Always review the diff, not just the commit prefix, before declaring a release as "patch only."

### No Release If CI Is Red
Never create a tag or GitHub release while the default branch has failing checks. A red CI means tests, lint, build, or security scans failed. Releasing in that state ships broken code. Wait for green CI or fix the failures first.

## Release Steps

1. **Verify all tests pass**
   ```bash
   npm test  # or equivalent
   ```

2. **Review commits since last release**
   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

3. **Determine version bump**
   ```bash
   ./scripts/detect-version-bump.sh
   ```
   - Breaking changes -> MAJOR
   - New features -> MINOR
   - Bug fixes only -> PATCH

4. **Update version**
   ```bash
   npm version minor  # or major/patch
   # or manually edit package.json / pyproject.toml / Cargo.toml
   ```

5. **Generate and edit changelog**
   ```bash
   ./scripts/generate-changelog.sh >> CHANGELOG.md
   ```
   Group by: Added, Changed, Deprecated, Removed, Fixed, Security
   Reference PR/issue numbers and credit contributors.

6. **Commit changelog and version bump**
   ```bash
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "chore(release): prepare v1.2.0"
   ```

7. **Create and push tag**
   ```bash
   git tag -a v1.2.0 -m "Release v1.2.0"
   git push origin main --follow-tags
   ```

8. **Create GitHub release**
   ```bash
   gh release create v1.2.0 \
     --title "v1.2.0" \
     --notes-file CHANGELOG.md
   ```

## Guidelines

- Never release on Fridays or before vacations
- Verify CI is green before releasing
- Tag releases with `v` prefix (e.g., `v1.2.0`)
- Keep changelog entries user-focused
- Update the `[Unreleased]` diff link after every release
